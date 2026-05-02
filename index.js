require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const axios   = require('axios');

const { supabase } = require('./database');
const { 
    enviarZap, 
    formatarMoedaZap,
    formatarNumero, 
    verificarStatusZapi, 
    enviarLembreteVencimento, 
    enviarAvisoAtraso,
    enviarReguaCobranca,
    enviarConfirmacaoBaixa,
    enviarAgendamentoParcial,
    enviarResumoDiarioAdmin,
    enviarAprovacaoComTermos 
} = require('./services/zapService');
const financeService = require('./services/financeService');
const { fazerUploadNoSupabase } = require('./services/uploadService');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public', { etag: false, lastModified: false, setHeaders: (res, path) => {
    if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
} }));

const APP_URL = process.env.APP_URL || 'https://cmsventures.site';
if (!process.env.APP_URL) {
    console.warn('[CONFIG] ⚠️  Variável APP_URL não definida no .env — usando fallback: https://cmsventures.site');
}

const travasAtivasPainel = new Set();
const tentativasLogin = new Map();
const tentativasSolicitacao = new Map();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const limparMoeda = (valor) => {
    if (valor === null || valor === undefined || valor === '') return 0;
    if (typeof valor === 'number') return valor;
    let str = String(valor).trim();
    if (str.includes(',')) str = str.replace(/\./g, '').replace(',', '.');
    const num = parseFloat(str);
    return isNaN(num) ? 0 : num;
};

// ==========================================
// FUNÇÕES AUXILIARES DE MATEMÁTICA E PARCELAS
// ==========================================
async function gerarParcelasNoBanco(devedorId, valorTotal, qtdParcelas, dataVencimento, frequencia) {
    return gerarParcelasComPersonalizacao(devedorId, valorTotal, qtdParcelas, dataVencimento, frequencia, null);
}

/**
 * Gera parcelas com suporte a valor diferenciado na 1ª parcela.
 * Se valorParcela1 for informado, a 1ª parcela usa esse valor e as demais dividem o restante.
 * Útil quando o admin cobra uma entrada diferenciada (ex: taxa de cadastro + juros antecipados).
 */
async function gerarParcelasComPersonalizacao(devedorId, valorTotal, qtdParcelas, dataVencimento, frequencia, valorParcela1 = null) {
    const valorPadrao = Math.round((valorTotal / qtdParcelas) * 100) / 100;

    // Se a 1ª parcela tem valor customizado, distribui o restante nas demais
    let valorP1 = valorPadrao;
    let valorDemais = valorPadrao;
    if (valorParcela1 && valorParcela1 > 0 && qtdParcelas > 1) {
        valorP1 = Math.round(valorParcela1 * 100) / 100;
        valorDemais = Math.round(((valorTotal - valorP1) / (qtdParcelas - 1)) * 100) / 100;
    }

    const insertData = [];
    let dt = new Date(dataVencimento + 'T12:00:00-03:00');

    for (let i = 0; i < qtdParcelas; i++) {
        const valor = i === 0 ? valorP1 : valorDemais;
        insertData.push({
            devedor_id:      devedorId,
            numero_parcela:  i + 1,
            valor_original:  valor,
            valor_atual:     valor,
            data_vencimento: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(dt),
            status:          'PENDENTE'
        });
        
        if (frequencia === 'SEMANAL') {
            dt.setDate(dt.getDate() + 7);
        } else {
            const diaOriginal = dt.getDate();
            dt.setMonth(dt.getMonth() + 1);
            if (dt.getDate() !== diaOriginal) dt.setDate(0);
        }
    }
    
    const { error } = await supabase.from('parcelas').insert(insertData);
    if (error) console.error("Erro crítico ao gerar parcelas no banco:", error);
}

/**
 * Formata o contrato para exibição no carnê/extrato.
 *
 * ATENÇÃO: valor_total do banco inclui multas diárias acumuladas, o que inflava
 * a parcela exibida e subtraia parcelas_pagas erroneamente.
 *
 * FIX: os callers desta função (extrato e validar-extrato) devem passar
 * parcelaOriginalValor e numeroParcela buscados da tabela `parcelas` para
 * sobrescrever os valores calculados com os valores reais do contrato.
 */
const formatarContratoCarne = (dev, parcelaOriginalValor = null, numeroParcela = null) => {
    const totalAtual = parseFloat(dev.valor_total) || 0;
    const jaPago = parseFloat(dev.total_ja_pego) || 0;
    const capital = parseFloat(dev.valor_emprestado) || 0;
    const taxa = (parseFloat(dev.taxa_juros) || 0) / 100;
    const qtdDB = parseInt(dev.qtd_parcelas) || 1;

    // Se a parcela real foi fornecida pelo caller (vem da tabela `parcelas.valor_original`),
    // usa diretamente — imune à inflação por multas diárias acumuladas em valor_total.
    if (parcelaOriginalValor && parcelaOriginalValor > 0) {
        dev.valor_parcela      = parcelaOriginalValor;
        dev.parcelas_pagas     = numeroParcela ? Math.max(0, numeroParcela - 1) : Math.floor(jaPago / parcelaOriginalValor);
        // qtd_parcelas no banco = total original (não decrementa após pagamentos).
        // Usa Math.max para proteger contra inconsistência onde numeroParcela > qtdDB.
        dev.qtd_parcelas_original = Math.max(qtdDB, numeroParcela || 1);
        return dev;
    }

    if (qtdDB > 1 || jaPago > 0) {
        // NOTA: globalOriginalComMultas pode estar inflado por multas acumuladas em totalAtual
        // e por multas já pagas dentro de jaPago (total_ja_pego inclui multas pagas).
        // Essa estimativa é usada apenas como fallback quando não há dados da tabela parcelas.
        const globalOriginalComMultas = totalAtual + jaPago;
        let originalQtd = qtdDB;
        let parcela = globalOriginalComMultas / qtdDB;

        if (capital > 0 && taxa > 0) {
            const calculatedQtd = Math.round((globalOriginalComMultas / capital - 1) / taxa);
            if (calculatedQtd > 0 && calculatedQtd >= qtdDB) {
                originalQtd = calculatedQtd;
                if (originalQtd < 1) originalQtd = 1;
                parcela = (capital * (1 + (taxa * originalQtd))) / originalQtd;
            } else {
                if (originalQtd < 1) originalQtd = 1;
                parcela = globalOriginalComMultas / originalQtd;
            }
        } else {
            const parcelaH1 = totalAtual / qtdDB;
            const isPerfect = (val, div) => div > 0 && Math.abs((val / div) - Math.round(val / div)) < 0.02;

            if (isPerfect(globalOriginalComMultas, parcelaH1)) {
                originalQtd = Math.round(globalOriginalComMultas / parcelaH1);
                parcela = parcelaH1;
            } else {
                if (originalQtd < 1) originalQtd = 1;
                parcela = globalOriginalComMultas / originalQtd;
            }
        }

        if (originalQtd < 1) originalQtd = 1;
        if (!parcela || parcela === Infinity) parcela = totalAtual;

        dev.valor_parcela = parcela;
        dev.parcelas_pagas = Math.floor(jaPago / parcela);
        dev.qtd_parcelas_original = Math.max(1, originalQtd);
    } else {
        dev.valor_parcela = totalAtual;
        dev.parcelas_pagas = jaPago >= totalAtual && totalAtual > 0 ? 1 : 0;
        dev.qtd_parcelas_original = 1;
    }
    return dev;
};

const escolherPixInteligente = (configPixString, valorCobranca) => {
    if (!configPixString) return null;
    try {
        const conf = JSON.parse(configPixString);
        if (!conf || !conf.chaves || conf.chaves.length === 0) return null;
        const getChave = (id) => conf.chaves.find(c => c.id === id);
        if (conf.modo === 'UNICO') return getChave(conf.padrao) || conf.chaves[0];
        if (conf.modo === 'ALEATORIO') return conf.chaves[Math.floor(Math.random() * conf.chaves.length)];
        if (conf.modo === 'VALOR') {
            const limite = parseFloat(conf.regras.limite) || 0;
            if (parseFloat(valorCobranca) < limite) return getChave(conf.regras.menor);
            else return getChave(conf.regras.maior);
        }
        return conf.chaves[0]; 
    } catch(e) { return null; }
};

// ==========================================
// HELPER: TAXA DE MULTA DIÁRIA (com cache de 5 min)
// ==========================================
let _cacheTaxaMulta = null;
let _cacheTaxaMultaTs = 0;
const buscarTaxaMultaDiaria = async () => {
    const agora = Date.now();
    if (_cacheTaxaMulta !== null && (agora - _cacheTaxaMultaTs) < 5 * 60 * 1000) {
        return _cacheTaxaMulta;
    }
    try {
        const { data } = await supabase.from('config').select('valor').eq('chave', 'multa_diaria').maybeSingle();
        if (data?.valor) {
            _cacheTaxaMulta = Math.max(0, parseFloat(data.valor) / 100);
            _cacheTaxaMultaTs = agora;
            return _cacheTaxaMulta;
        }
    } catch (_) {}
    _cacheTaxaMulta = 0.01;
    _cacheTaxaMultaTs = agora;
    return 0.01; // fallback 1%/dia
};

// ==========================================
// HELPER: PROJEÇÃO DE JUROS AO VIVO
// ==========================================
/**
 * Calcula quantas multas diárias estão pendentes desde a última aplicada pelo robô.
 * NÃO grava nada no banco — usado apenas para exibição ao vivo e para
 * garantir que pagamentos manuais já reflitam o saldo correto do dia.
 *
 * @param dev           — objeto devedor do banco
 * @param taxaDiaria    — taxa em decimal (ex: 0.03 para 3%). Leia com buscarTaxaMultaDiaria().
 *
 * Retorna:
 *   diasPendentes  — quantos dias de multa ainda não foram gravados
 *   multaPendente  — valor total a acrescentar (R$)
 *   valorProjetado — valor_total + multaPendente (saldo real de hoje)
 */
const projetarJurosAtraso = (dev, taxaDiaria = 0.01) => {
    const hoje = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()) + 'T00:00:00-03:00');

    if (dev.isento_multa || !['ATRASADO', 'ABERTO'].includes(dev.status)) {
        return { diasPendentes: 0, multaPendente: 0, valorProjetado: parseFloat(dev.valor_total || 0) };
    }

    const dataVenc = new Date(dev.data_vencimento + 'T00:00:00-03:00');
    if (hoje <= dataVenc) {
        return { diasPendentes: 0, multaPendente: 0, valorProjetado: parseFloat(dev.valor_total || 0) };
    }

    const ultimaMulta = dev.ultima_cobranca_atraso
        ? new Date(dev.ultima_cobranca_atraso + 'T00:00:00-03:00')
        : dataVenc;

    const diasPendentes = Math.max(0, Math.floor((hoje - ultimaMulta) / (1000 * 60 * 60 * 24)));

    if (diasPendentes === 0) {
        return { diasPendentes: 0, multaPendente: 0, valorProjetado: parseFloat(dev.valor_total || 0) };
    }

    const capitalBase    = Math.round(parseFloat(dev.valor_emprestado || 0) * 100) / 100;
    const totalAtual     = Math.round(parseFloat(dev.valor_total || 0) * 100) / 100;

    // Juros compostos: capital × taxa × dias (sobre o capital, não sobre o total crescente)
    const multaPendente  = Math.round(capitalBase * taxaDiaria * diasPendentes * 100) / 100;
    const valorProjetado = Math.round((totalAtual + multaPendente) * 100) / 100;

    return { diasPendentes, multaPendente, valorProjetado };
};

// Cache do fluxo líquido de caixa (30 segundos) — evita carregar todos os logs a cada request do dashboard
let _cacheFluxoCaixa = null;
let _cacheFluxoCaixaTs = 0;
const buscarFluxoLiquidoCaixa = async () => {
    const agora = Date.now();
    if (_cacheFluxoCaixa !== null && (agora - _cacheFluxoCaixaTs) < 30 * 1000) {
        return _cacheFluxoCaixa;
    }
    const { data: logsFluxo } = await supabase.from('logs').select('valor_fluxo');
    const total = (logsFluxo || []).reduce((s, l) => s + (parseFloat(l.valor_fluxo) || 0), 0);
    _cacheFluxoCaixa = total;
    _cacheFluxoCaixaTs = agora;
    return total;
};
const invalidarCacheFluxo = () => { _cacheFluxoCaixa = null; };


app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const tentativas = tentativasLogin.get(ip) || 0;
    if (tentativas >= 5) return res.status(429).json({ erro: 'Muitas tentativas falhadas. Por favor, aguarde 5 minutos.' });

    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
            tentativasLogin.set(ip, tentativas + 1);
            setTimeout(() => tentativasLogin.delete(ip), 5 * 60 * 1000); 
            return res.status(401).json({ erro: 'E-mail ou palavra-passe incorretos.' });
        }
        tentativasLogin.delete(ip); 
        // Retorna access_token E refresh_token para o frontend renovar a sessão automaticamente
        res.json({
            token:         data.session.access_token,
            refresh_token: data.session.refresh_token,
            expires_in:    data.session.expires_in || 3600,
            email:         data.user?.email
        });
    } catch (err) { res.status(500).json({ erro: 'Erro interno de autenticação.' }); }
});

// Rota para renovar o access_token usando o refresh_token (sem precisar fazer login novamente)
app.post('/api/refresh-session', async (req, res) => {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ erro: 'refresh_token obrigatório.' });
    try {
        const { data, error } = await supabase.auth.refreshSession({ refresh_token });
        if (error || !data?.session) return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
        res.json({
            token:         data.session.access_token,
            refresh_token: data.session.refresh_token,
            expires_in:    data.session.expires_in || 3600,
        });
    } catch (err) { res.status(500).json({ erro: 'Erro ao renovar sessão.' }); }
});

const authMiddleware = async (req, res, next) => {
    const rotasPublicas = [
        '/api/login',
        '/api/refresh-session',   // renovação de token não requer auth (usa refresh_token)
        '/api/enviar-solicitacao',
        '/validar-extrato', 
        '/cliente-aceitou', 
        '/cliente-gerar-pagamento', 
        '/status-zapi', 
        '/api/config-publica', 
        '/favicon.ico'
    ];
    if (rotasPublicas.includes(req.path)
        || req.path.startsWith('/api/buscar-cliente-publico')
        || req.path.startsWith('/api/docs-reprovados/')
        || req.path.startsWith('/api/consultar-cpf/')
        || req.path === '/api/reenviar-documentos'
    ) return next();
    
    const tokenHeader = req.headers['authorization'];
    if (!tokenHeader || !tokenHeader.startsWith('Bearer ')) return res.status(401).json({ erro: 'Acesso Restrito.' });
    
    const token = tokenHeader.split(' ')[1];
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) throw new Error("Sessão Inválida");
        req.user = user; 
        return next();
    } catch(err) { return res.status(401).json({ erro: 'Sessão expirada.' }); }
};

app.use(authMiddleware);
app.get('/api/verify-session', (req, res) => res.json({ autenticado: true, email: req.user?.email }));

// ==========================================
// 2. ROTAS PÚBLICAS E SOLICITAÇÃO
// ==========================================

// ─── Consulta de CPF via API externa ────────────────────────────────────────
// Rate-limit: 10 consultas por IP por hora
const tentativasConsultaCPF = new Map();

app.get('/api/consultar-cpf/:cpf', async (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const hits = tentativasConsultaCPF.get(ip) || 0;
    if (hits >= 10) return res.status(429).json({ erro: 'Muitas consultas. Aguarde.' });

    const cpf = req.params.cpf.replace(/\D/g, '');
    if (cpf.length !== 11) return res.status(400).json({ erro: 'CPF inválido.' });

    const apiUrl = process.env.CPF_API_URL;
    const apiKey = process.env.CPF_API_KEY;
    if (!apiUrl || !apiKey) return res.status(503).json({ erro: 'API de CPF não configurada.' });

    tentativasConsultaCPF.set(ip, hits + 1);
    setTimeout(() => tentativasConsultaCPF.delete(ip), 60 * 60 * 1000);

    try {
        const { data: d } = await axios.get(`${apiUrl}${cpf}`, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            timeout: 8000
        });

        // Normaliza campos comuns de diferentes providers (BigBoost, CPFcerto, Serpro, genérico)
        const nome     = d.nome     || d.name      || d.NomePF     || d.nome_pf    || d.data?.nome     || '';
        const nascimento = d.data_nascimento || d.dataNascimento || d.birthDate
                         || d.DataNascimento || d.data?.data_nascimento || '';
        const situacao = d.situacao || d.status     || d.situacaoCadastral || d.data?.situacao || '';

        // Telefone: tenta vários formatos de response
        const telRaw = d.telefone || d.phone || d.celular || d.fone
                     || d.telefones?.[0]?.numero || d.phones?.[0]?.number
                     || d.data?.telefone || '';
        const telefone = telRaw ? telRaw.toString().replace(/\D/g, '') : '';

        res.json({ nome, nascimento, situacao, telefone });
    } catch(e) {
        const status = e.response?.status;
        if (status === 404) return res.status(404).json({ erro: 'CPF não encontrado.' });
        if (status === 401 || status === 403) return res.status(503).json({ erro: 'Credenciais inválidas na API de CPF.' });
        console.error('[CPF API]', e.message);
        res.status(503).json({ erro: 'Serviço de consulta temporariamente indisponível.' });
    }
});

app.get('/status-zapi', async (req, res) => { try { const status = await verificarStatusZapi(); res.json(status); } catch(e) { res.json({ connected: false }); } });
app.get('/api/config-publica', async (req, res) => { try { const { data } = await supabase.from('config').select('*').in('chave', ['valor_minimo', 'juros_unico', 'juros_parcelado', 'pix_avancado', 'multa_diaria']); res.json(data || []); } catch(e) { res.json([]); } });

app.get('/api/buscar-cliente-publico/:cpf', async (req, res) => {
    try {
        const cpf = req.params.cpf.replace(/\D/g, '');
        const { data, error } = await supabase.from('devedores').select('nome, telefone').eq('cpf', cpf).limit(1);
        if (error || !data || data.length === 0) return res.status(404).json({ erro: "Cliente não encontrado." });
        res.json(data[0]);
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/enviar-solicitacao', async (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const reqCount = tentativasSolicitacao.get(ip) || 0;
    if (reqCount >= 3) return res.status(429).json({ erro: "Muitas solicitações. Aguarde." });
    
    try {
        const d = req.body;
        const imagensParaVerificar = [d.url_selfie, d.url_residencia, d.url_frente, d.url_verso, d.url_casa];
        for (let img of imagensParaVerificar) { if (img && img.length > 15 * 1024 * 1024) return res.status(413).json({ erro: "Imagem excede o limite." }); }

        const cpfLimpoSol = (d.cpf || '').replace(/\D/g, '');

        const { data: bl } = await supabase.from('lista_negra').select('cpf').eq('cpf', cpfLimpoSol).single();
        if (bl) return res.status(403).json({ erro: "CPF bloqueado pelo sistema." });

        const { data: solPendente } = await supabase.from('solicitacoes').select('id').eq('cpf', cpfLimpoSol).eq('status', 'PENDENTE').maybeSingle();
        if (solPendente) return res.status(429).json({ erro: "Você já possui uma solicitação em análise." });

        // Bloqueia nova solicitação se já existe contrato ativo — cliente deve usar "Já sou cliente"
        if (!d.is_recorrente) {
            const { data: contratoAtivo } = await supabase
                .from('devedores')
                .select('id')
                .eq('cpf', cpfLimpoSol)
                .in('status', ['ABERTO', 'ATRASADO', 'APROVADO_AGUARDANDO_ACEITE'])
                .limit(1)
                .maybeSingle();
            if (contratoAtivo) {
                return res.status(409).json({ erro: "Este CPF já possui um contrato ativo na CMS Ventures. No formulário, use a opção *Já é nosso cliente?* e informe o seu CPF para renovar." });
            }
        }

        tentativasSolicitacao.set(ip, reqCount + 1);
        setTimeout(() => tentativasSolicitacao.delete(ip), 60 * 60 * 1000);

        const ts = Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        let oldFrente = null, oldVerso = null, oldCasa = null;

        // Reutiliza documentos existentes sempre que o CPF já está cadastrado (mesmo sem is_recorrente)
        const { data: devExistente } = await supabase.from('devedores').select('url_frente, url_verso, url_casa').eq('cpf', cpfLimpoSol).order('created_at', { ascending: false }).limit(1);
        if (devExistente && devExistente.length > 0) {
            oldFrente = devExistente[0].url_frente;
            oldVerso  = devExistente[0].url_verso;
            oldCasa   = devExistente[0].url_casa;
        }

        if (d.is_recorrente) {
            const { data: dev } = await supabase.from('devedores').select('url_frente, url_verso, url_casa').eq('cpf', cpfLimpoSol).limit(1);
            if (dev && dev.length > 0) { oldFrente = dev[0].url_frente; oldVerso = dev[0].url_verso; oldCasa = dev[0].url_casa; }
        }

        const uSelfie = d.url_selfie ? await fazerUploadNoSupabase(d.url_selfie, `${d.cpf}_selfie_${ts}.jpg`) : null;
        const uResidencia = d.url_residencia ? await fazerUploadNoSupabase(d.url_residencia, `${d.cpf}_res_${ts}.jpg`) : null;
        const uFrente = d.url_frente ? await fazerUploadNoSupabase(d.url_frente, `${d.cpf}_frente_${ts}.jpg`) : oldFrente;
        const uVerso = d.url_verso ? await fazerUploadNoSupabase(d.url_verso, `${d.cpf}_verso_${ts}.jpg`) : oldVerso;
        const uCasa = d.url_casa ? await fazerUploadNoSupabase(d.url_casa, `${d.cpf}_casa_${ts}.jpg`) : oldCasa;

        const parcelasMatematicas = Math.max(1, d.tipo_plano === '30DIAS' ? 1 : (parseInt(d.qtd_parcelas) || 1));

        const { error } = await supabase.from('solicitacoes').insert([{
            nome: d.nome, cpf: d.cpf, whatsapp: d.whatsapp, valor: limparMoeda(d.valor),
            tipo_plano: d.tipo_plano || '30DIAS', frequencia: d.frequencia || 'MENSAL',
            qtd_parcelas: parcelasMatematicas, indicado_por: d.indicado_por || 'DIRETO',
            url_selfie: uSelfie, url_frente: uFrente, url_verso: uVerso, url_residencia: uResidencia, url_casa: uCasa,
            referencia1_nome: d.referencia1_nome, referencia1_tel: d.referencia1_tel, status: 'PENDENTE'
        }]);
        
        if (error) throw error;

        // ── NOTIFICAÇÃO DE NOVA SOLICITAÇÃO ──────────────────────────────────
        // Envia para ADMIN_WHATSAPP (número principal) E para NOTIF_WHATSAPP
        // (segundo número — só recebe notificações, ex: sócio, outro celular).
        // Para configurar o segundo número: adicione NOTIF_WHATSAPP no .env
        const numerosNotif = [
            process.env.ADMIN_WHATSAPP,
            process.env.NOTIF_WHATSAPP,   // segundo número (opcional)
        ].filter(Boolean);                // remove os que não estão configurados

        if (numerosNotif.length > 0) {
            const valorFmt  = Number(limparMoeda(d.valor)).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
            const planoFmt  = d.tipo_plano === '30DIAS'
                ? `Única parcela (30 dias)`
                : `${parcelasMatematicas}x — ${d.frequencia === 'SEMANAL' ? 'Semanal' : 'Mensal'}`;
            const cpfFmt    = (d.cpf || '').replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
            const indicador = d.indicado_por && d.indicado_por !== 'DIRETO'
                ? `\n🤝 *Indicado por:* ${d.indicado_por}` : '';
            const ref1      = d.referencia1_nome
                ? `\n📞 *Referência:* ${d.referencia1_nome}${d.referencia1_tel ? ' — ' + d.referencia1_tel : ''}` : '';
            const obs       = d.observacoes ? `\n📝 *Obs:* ${d.observacoes}` : '';

            const msgNotif =
                `🔔 *CMS VENTURES — NOVA SOLICITAÇÃO*\n\n` +
                `👤 *Nome:* ${d.nome}\n` +
                `🪪 *CPF:* ${cpfFmt}\n` +
                `📱 *WhatsApp:* ${d.whatsapp || '—'}\n` +
                `💰 *Valor:* ${valorFmt}\n` +
                `📋 *Plano:* ${planoFmt}` +
                indicador + ref1 + obs + `\n\n` +
                `👉 Acesse o painel para *aprovar ou rejeitar*:\n${APP_URL}`;

            // Envia para todos os números configurados (sem bloquear a resposta)
            numerosNotif.forEach(num => {
                enviarZap(num, msgNotif).catch(e => console.warn(`[NOTIF SOLICITAÇÃO] Falha para ${num}:`, e.message));
            });
        }
        // ─────────────────────────────────────────────────────────────────────

        res.status(200).json({ mensagem: "Solicitação recebida com sucesso!" });
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==========================================
// 3. FLUXO DO CLIENTE E CONTRATO
// ==========================================
app.post('/validar-extrato', async (req, res) => { 
    try { 
        const camposPublicos = 'id, uuid, nome, valor_emprestado, valor_total, qtd_parcelas, frequencia, data_vencimento, status, taxa_juros, total_ja_pego, cobrar_so_em_dinheiro, isento_multa, ultima_cobranca_atraso';
        let query = supabase.from('devedores').select(camposPublicos).eq('uuid', req.body.id);
        if (req.body.cpf) query = query.eq('cpf', req.body.cpf.replace(/\D/g, '')); 
        
        const { data: dev, error } = await query.single();
        if (error || !dev) return res.status(404).json({ erro: "Extrato não encontrado." }); 
        
        // Busca valor_original real da próxima parcela pendente para evitar inflação por multas
        // (formatarContratoCarne usa valor_total+total_ja_pego que inclui multas acumuladas)
        let parcelaOriginalValor = null;
        let numeroParcela = null;
        if (parseInt(dev.qtd_parcelas) > 1) {
            const { data: proxParc } = await supabase
                .from('parcelas')
                .select('valor_original, numero_parcela')
                .eq('devedor_id', dev.id)
                .in('status', ['PENDENTE', 'ATRASADO', 'PARCIAL'])
                .order('numero_parcela', { ascending: true })
                .limit(1)
                .maybeSingle();
            if (proxParc?.valor_original > 0) {
                parcelaOriginalValor = parseFloat(proxParc.valor_original);
                numeroParcela = proxParc.numero_parcela;
            }
        }

        const devFormatado = formatarContratoCarne(dev, parcelaOriginalValor, numeroParcela);

        // Lê taxa configurada e projeta juros pendentes ao vivo
        const taxa = await buscarTaxaMultaDiaria();
        const projecao = projetarJurosAtraso(devFormatado, taxa);
        devFormatado.valor_total_projetado = projecao.valorProjetado;
        devFormatado.multa_pendente        = projecao.multaPendente;
        devFormatado.dias_pendentes        = projecao.diasPendentes;
        devFormatado.taxa_multa_diaria_pct = Math.round(taxa * 10000) / 100; // ex: 3.00

        res.json(devFormatado); 
    } catch(e) { res.status(500).json({ erro: e.message }); } 
});

app.post('/cliente-aceitou', async (req, res) => {
    // Trava por UUID para evitar race condition (duplo-clique / dois requests simultâneos)
    // que causaria duplicação do log "Empréstimo Liberado" e caixa incorreto.
    const lockKey = `aceite_${req.body.id}`;
    if (travasAtivasPainel.has(lockKey)) return res.status(429).json({ erro: "Operação em andamento." });
    travasAtivasPainel.add(lockKey);
    try {
        const { data: dev } = await supabase.from('devedores').select('*').eq('uuid', req.body.id).single();
        if (!dev) return res.status(404).json({ erro: "Contrato não encontrado." });

        if (dev.status === 'ABERTO' || dev.status === 'ATRASADO') {
            return res.status(400).json({ erro: "Este contrato já se encontra ativo no sistema." });
        }
        if (dev.status !== 'APROVADO_AGUARDANDO_ACEITE') {
            return res.status(400).json({ erro: "Este contrato não está disponível para assinatura." });
        }

        await supabase.from('devedores').update({ status: 'ABERTO' }).eq('id', dev.id);
        await supabase.from('solicitacoes').update({ status: 'ASSINADO' }).eq('cpf', dev.cpf).eq('status', 'APROVADO_CP');
        const { error: logErr } = await supabase.from('logs').insert([
            { evento: 'Empréstimo Liberado', detalhes: `Contrato assinado digitalmente. Vencimento: ${dev.data_vencimento}.`, devedor_id: dev.id, valor_fluxo: -Math.abs(dev.valor_emprestado) },
        ]);
        if (logErr) {
            console.error('[ASSINAR] Falha ao registrar log de empréstimo no caixa:', logErr.message);
            return res.status(500).json({ erro: 'Contrato assinado, mas falha ao registrar saída no caixa: ' + logErr.message });
        }
        res.json({ status: 'Assinado' });
    } catch(e) { res.status(500).json({ erro: e.message }); } finally { travasAtivasPainel.delete(lockKey); }
});

app.post('/cliente-gerar-pagamento', async (req, res) => {
    try {
        const { id, valorParaPagar } = req.body;
        const { data: dev, error } = await supabase.from('devedores').select('*').eq('uuid', id).single();
        if (error || !dev) return res.status(404).json({ erro: "Fatura não encontrada." });
        const checkoutUrl = process.env.INFINITY_TOKEN;
        res.json({ checkout_url: checkoutUrl });
    } catch (e) {
        res.status(500).json({ erro: "Falha ao conectar." });
    }
});

// ==========================================
// 4. MÓDULOS DE PREVISÃO E GARANTIAS
// ==========================================
app.get('/api/previsao-caixa', async (req, res) => {
    try {
        const dataApoio = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        dataApoio.setHours(0,0,0,0);
        const { data: devedores } = await supabase.from('devedores').select('nome, valor_total, qtd_parcelas, data_vencimento, status').in('status', ['ABERTO', 'ATRASADO']).gte('data_vencimento', dataApoio.toISOString().split('T')[0]);
        const previsao = {};
        (devedores || []).forEach(d => {
            const dataVenc = d.data_vencimento;
            const valorParcela = d.qtd_parcelas > 1 ? (parseFloat(d.valor_total) / d.qtd_parcelas) : parseFloat(d.valor_total);
            if (!previsao[dataVenc]) previsao[dataVenc] = { total: 0, clientes: [] };
            previsao[dataVenc].total += valorParcela;
            previsao[dataVenc].clientes.push({ nome: d.nome.split(' ')[0], valor: valorParcela });
        });
        res.json(previsao);
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/garantias/:cpf', async (req, res) => {
    try {
        const cpf = req.params.cpf.replace(/\D/g, '');
        const { data } = await supabase.from('garantias').select('*').eq('cpf', cpf).order('created_at', { ascending: false });
        res.json(data || []);
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/garantias', async (req, res) => {
    try {
        const { cpf, descricao, valor_estimado } = req.body;
        await supabase.from('garantias').insert([{ cpf: cpf.replace(/\D/g, ''), descricao, valor_estimado: limparMoeda(valor_estimado) }]);
        res.json({ sucesso: true });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/garantias/:id/status', async (req, res) => {
    try { await supabase.from('garantias').update({ status: req.body.status }).eq('id', req.params.id); res.json({ sucesso: true }); } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// 5. ROTAS DE GESTÃO, DASHBOARD E APROVAÇÕES
// ==========================================
app.get(['/api/dashboard', '/api/dashboard-master'], async (req, res) => {
    try {
        const { data: configs } = await supabase.from('config').select('*');
        let caixaGeral = 0; // CORREÇÃO: era 50000 hardcoded — agora fallback seguro é zero
        let caixaConfigurado = false;
        configs?.forEach(c => { 
            if (c.chave === 'caixa_total') { 
                caixaGeral = parseFloat(c.valor) || 0; 
                caixaConfigurado = true;
            } 
        });

        const p_inicio = req.query.inicio || null;
        const p_fim = req.query.fim || null;

        const { data: dbResumo, error: rpcErr } = await supabase.rpc('obter_resumo_dashboard', { p_inicio: p_inicio, p_fim: p_fim });
        if (rpcErr) throw new Error(rpcErr.message);
        
        const resumoSeguro = dbResumo || {};
        const hojeStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
        const taxaInad = await buscarTaxaMultaDiaria();
        const hojeObj  = new Date(); hojeObj.setHours(0,0,0,0);

        // Uma única query com todos os campos necessários para calcular
        // tanto a inadimplência (parcelas vencidas) quanto o totalAReceber (todas as parcelas).
        const { data: todasParcelas } = await supabase
            .from('vw_cobranca_ativa_parcelas')
            .select('valor_original, valor_pago, valor_emprestado, vencimento_parcela, devedor_id, status_contrato');

        // Calcula inadimplência filtrando em JS (parcelas com vencimento < hoje)
        const multaContadaPorDevedor = new Set();
        let valorInadimplenciaReal = 0;
        (todasParcelas || []).filter(p => p.vencimento_parcela < hojeStr).forEach(p => {
            const valorOriginal = parseFloat(p.valor_original || 0);
            const jaPago        = parseFloat(p.valor_pago    || 0);
            const capital       = parseFloat(p.valor_emprestado || 0);
            const dtVenc        = new Date(p.vencimento_parcela + 'T00:00:00-03:00');
            const diasAtr       = dtVenc < hojeObj
                ? Math.max(0, Math.floor((hojeObj - dtVenc) / (1000 * 60 * 60 * 24)))
                : 0;

            // Multa total: sobre o capital do contrato, apenas uma vez por devedor
            let multaDevedor = 0;
            if (diasAtr > 0 && !multaContadaPorDevedor.has(p.devedor_id)) {
                multaDevedor = Math.round(capital * taxaInad * diasAtr * 100) / 100;
                multaContadaPorDevedor.add(p.devedor_id);
            }

            valorInadimplenciaReal += Math.max(0, valorOriginal - jaPago + multaDevedor);
        });
        valorInadimplenciaReal = Math.round(valorInadimplenciaReal * 100) / 100;

        // ── PROJEÇÃO AO VIVO DE MULTAS ────────────────────────────────────────
        // Usa EXATAMENTE o mesmo cálculo da aba de cobrança (devedores-ativos):
        //   capital × taxa × diasTotais_desde_vencimento (não dias pendentes)
        // Isso garante que o dashboard e a aba de cobrança mostram o mesmo número.
        //
        // Para não dupla-contar: recalculamos totalAReceber do zero usando parcelas reais.
        // totalAReceber = sum(valor_original - valor_pago) de parcelas abertas
        //               + multaTotal por devedor atrasado

        let totalAReceberCalculado = 0;
        const multaContadaDash = new Set();

        (todasParcelas || []).forEach(p => {
            const valOrig = parseFloat(p.valor_original || 0);
            const jaPago  = parseFloat(p.valor_pago    || 0);
            totalAReceberCalculado += Math.max(0, valOrig - jaPago);

            // Multa: uma vez por devedor atrasado, sobre o capital total
            if (p.status_contrato === 'ATRASADO' && !multaContadaDash.has(p.devedor_id)) {
                const capital  = parseFloat(p.valor_emprestado || 0);
                const dtVenc   = new Date(p.vencimento_parcela + 'T00:00:00-03:00');
                const diasTotais = dtVenc < hojeObj
                    ? Math.max(0, Math.floor((hojeObj - dtVenc) / (1000 * 60 * 60 * 24)))
                    : 0;
                if (diasTotais > 0) {
                    totalAReceberCalculado += Math.round(capital * taxaInad * diasTotais * 100) / 100;
                }
                multaContadaDash.add(p.devedor_id);
            }
        });

        const totalAReceberReal = Math.round(totalAReceberCalculado * 100) / 100;
        const capitalNaRuaReal  = parseFloat(resumoSeguro.capitalNaRua) || 0;
        const lucroEstimadoReal = Math.round((totalAReceberReal - capitalNaRuaReal) * 100) / 100;
        // ─────────────────────────────────────────────────────────────────────

        // CORREÇÃO: calcula caixa diretamente dos logs (soma todos valor_fluxo positivos e negativos).
        // O RPC obter_resumo_dashboard pode não incluir saídas negativas (empréstimos liberados),
        // por isso a caixa ficava estática mesmo após contratos assinados.
        // Usa cache de 30s para evitar carregar todos os logs a cada request.
        const fluxoLiquidoTotal = await buscarFluxoLiquidoCaixa();
        const caixaDisponivel = Math.round((caixaGeral + fluxoLiquidoTotal) * 100) / 100;

        res.json({
            totalAReceber: totalAReceberReal,
            lucroEstimado: lucroEstimadoReal,
            recebidoHoje: resumoSeguro.recebidoHoje || 0,
            pendencias: resumoSeguro.pendencias || 0,
            finalizados: resumoSeguro.finalizados || 0,
            capitalNaRua: capitalNaRuaReal,
            caixaDisponivel,
            caixaConfigurado,
            valor_inadimplencia: valorInadimplenciaReal
        });
    } catch (err) { res.status(500).json({ erro: "Erro ao processar dashboard" }); }
});

app.get('/api/solicitacoes-pendentes', async (req, res) => {
    try {
        let todas = []; let buscar = true; let ptr = 0;
        while (buscar) {
            const { data, error } = await supabase.from('solicitacoes').select('*').eq('status', 'PENDENTE').order('created_at', { ascending: false }).range(ptr, ptr + 999);
            if (error || !data || data.length === 0) break;
            todas = todas.concat(data); if (data.length < 1000) buscar = false; ptr += 1000;
        }
        res.json(todas);
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Editar dados pessoais de uma solicitação (nome, whatsapp, referências)
app.post('/api/editar-dados-solicitacao', async (req, res) => {
    try {
        const { id, nome, whatsapp, referencia1_nome, referencia1_tel } = req.body;
        if (!id) return res.status(400).json({ erro: 'ID da solicitação obrigatório.' });

        const payload = {};
        if (nome && nome.trim()) payload.nome = nome.trim();
        if (whatsapp !== undefined) payload.whatsapp = (whatsapp || '').replace(/\D/g, '');
        if (referencia1_nome !== undefined) payload.referencia1_nome = referencia1_nome;
        if (referencia1_tel !== undefined) payload.referencia1_tel = (referencia1_tel || '').replace(/\D/g, '');

        if (Object.keys(payload).length === 0) return res.status(400).json({ erro: 'Nenhum dado para actualizar.' });

        const { error } = await supabase.from('solicitacoes').update(payload).eq('id', id);
        if (error) throw error;

        res.json({ sucesso: true });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/aprovar-solicitacao', async (req, res) => {
    const { id, juros, observacao, novoValor, novaFreq, novasParcelas, cobrarSoEmDinheiro, isContraProposta, isentoMulta, vencimento1, valorParcela1 } = req.body;
    
    const lockKey = `aprovar_${id}`;
    if (travasAtivasPainel.has(lockKey)) return res.status(429).json({ erro: "Operação em andamento." });
    travasAtivasPainel.add(lockKey);

    try {
        const { data: sol, error: errSol } = await supabase.from('solicitacoes').select('*').eq('id', id).single();
        if (errSol || !sol) throw new Error("Solicitação não encontrada.");
        if (sol.status !== 'PENDENTE') return res.status(400).json({ erro: "Esta solicitação já foi tratada." });

        let valorJurosLimpo = limparMoeda(juros);
        const jurosDecimal = Math.max(0, (valorJurosLimpo !== null && valorJurosLimpo !== undefined ? valorJurosLimpo : 30) / 100);
        const valorFinal = novoValor ? Math.max(0, limparMoeda(novoValor)) : Math.max(0, limparMoeda(sol.valor));
        const freqFinal = novaFreq || sol.frequencia || 'MENSAL';
        let parcelasFinais = novasParcelas ? parseInt(novasParcelas) : (parseInt(sol.qtd_parcelas) || 1);
        parcelasFinais = Math.max(1, parcelasFinais);

        let taxaAplicada = parcelasFinais > 1 ? (jurosDecimal * parcelasFinais) : jurosDecimal;
        const valorTotal = Math.round((valorFinal * (1 + taxaAplicada)) * 100) / 100;
        
        // Vencimento da 1ª parcela: usa o informado pelo admin ou calcula o padrão
        let dtVencimentoProjetado;
        if (vencimento1 && vencimento1.match(/^\d{4}-\d{2}-\d{2}$/)) {
            dtVencimentoProjetado = vencimento1;
        } else {
            const momentBRT = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
            momentBRT.setDate(momentBRT.getDate() + (freqFinal === 'SEMANAL' ? 7 : 30));
            dtVencimentoProjetado = momentBRT.toISOString().split('T')[0];
        }
        
        const cpfLimpo = String(sol.cpf || '').replace(/\D/g, '');
        const { data: exDevs } = await supabase.from('devedores').select('id, uuid, status').eq('cpf', cpfLimpo).order('created_at', { ascending: false }).limit(1);
        const exDev = exDevs && exDevs.length > 0 ? exDevs[0] : null;

        let devId, devUuid;
        let payload = {
            nome: sol.nome, telefone: sol.whatsapp || sol.telefone || 'N/A', valor_emprestado: valorFinal, valor_total: valorTotal,
            frequencia: freqFinal, qtd_parcelas: parcelasFinais, status: 'APROVADO_AGUARDANDO_ACEITE', data_vencimento: dtVencimentoProjetado, 
            taxa_juros: jurosDecimal * 100, observacoes: observacao || '', url_selfie: sol.url_selfie, url_frente: sol.url_frente, 
            url_verso: sol.url_verso, url_residencia: sol.url_residencia, url_casa: sol.url_casa, referencia1_nome: sol.referencia1_nome, 
            referencia1_tel: sol.referencia1_tel, indicado_por: sol.indicado_por, pago: false, 
            cobrar_so_em_dinheiro: cobrarSoEmDinheiro || false, isento_multa: isentoMulta || false
        };

        if (exDev && exDev.status === 'PRE_CADASTRO') {
            payload.created_at = new Date().toISOString(); payload.ultima_cobranca_atraso = null;
            const { data: u, error: uE } = await supabase.from('devedores').update(payload).eq('id', exDev.id).select().single();
            if (uE) throw uE; devId = u.id; devUuid = u.uuid;
        } else {
            payload.cpf = cpfLimpo;
            const { data: i, error: iE } = await supabase.from('devedores').insert([payload]).select().single();
            if (iE) throw iE; devId = i.id; devUuid = i.uuid;
        }

        // Gera parcelas com vencimento customizado e valor diferenciado na 1ª parcela
        await gerarParcelasComPersonalizacao(devId, valorTotal, parcelasFinais, dtVencimentoProjetado, freqFinal, valorParcela1);
        await supabase.from('solicitacoes').update({ status: 'APROVADO_CP', observacoes: observacao }).eq('id', id);
        // NÃO grava log de Empréstimo Liberado aqui — o dinheiro só sai do caixa
        // quando o cliente assinar. Gravar aqui causava -R$X no caixa mesmo em aprovações
        // que depois eram rejeitadas ou que o cliente nunca assinou.

        const linkAceite = `${APP_URL}/aceitar.html?id=${devUuid}`;
        let whatsappEnviado = false;
        try { 
            const valorDaParcela = parcelasFinais > 1 ? (valorTotal / parcelasFinais) : valorTotal;
            await enviarAprovacaoComTermos(payload.telefone, payload.nome, valorFinal, parcelasFinais, freqFinal, valorDaParcela, linkAceite, isContraProposta);
            whatsappEnviado = true;
        } catch(e) {
            // CORREÇÃO: erro silenciado virou log + campo no response para o painel alertar o operador
            console.error(`[WHATSAPP] Falha ao enviar aprovação para ${payload.telefone}:`, e.message);
        }
        
        res.json({ sucesso: true, whatsappEnviado });
    } catch (e) { res.status(500).json({ erro: e.message }); } finally { travasAtivasPainel.delete(lockKey); }
});

app.post('/api/rejeitar-solicitacao', async (req, res) => {
    try {
        const { data: sol } = await supabase.from('solicitacoes').select('*').eq('id', req.body.id).single();
        if (sol && sol.status === 'ASSINADO') return res.status(400).json({ erro: "Cliente já assinou este contrato."});

        await supabase.from('solicitacoes').update({ status: 'REJEITADO', observacoes: req.body.motivo }).eq('id', req.body.id);

        // Se havia um devedor criado aguardando aceite (aprovado mas não assinado),
        // cancelar para não sujar o dashboard com capital_na_rua fantasma
        if (sol?.cpf) {
            await supabase.from('devedores')
                .update({ status: 'CANCELADO', pago: true })
                .eq('cpf', sol.cpf.replace(/\D/g, ''))
                .eq('status', 'APROVADO_AGUARDANDO_ACEITE');
        }

        await supabase.from('logs').insert([{
            evento: "Solicitação Rejeitada",
            detalhes: `Motivo: ${req.body.motivo || '—'}`,
            valor_fluxo: 0
        }]);
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// 6. BUSCA DE CLIENTES E COBRANÇAS
// ==========================================
app.get('/api/devedores-ativos', async (req, res) => {
    try {
        const { data, error } = await supabase.from('vw_cobranca_ativa_parcelas').select('*').order('vencimento_parcela', { ascending: true }); 
        if (error) throw error;

        const taxa = await buscarTaxaMultaDiaria();
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);

        // Agrupa por devedor — multa é sobre o CAPITAL DO CONTRATO, não por parcela
        // Calculamos apenas UMA VEZ por devedor e atribuímos INTEIRA à parcela mais antiga
        // Saldo base por devedor: soma de (valor_original - valor_pago) de todas as parcelas ativas
        const saldoBasePorDevedor = {};
        (data || []).forEach(p => {
            const did = p.devedor_id;
            const valOrig = parseFloat(p.valor_original || p.valor_atual || 0);
            const jaPago  = parseFloat(p.valor_pago || 0);
            saldoBasePorDevedor[did] = (saldoBasePorDevedor[did] || 0) + Math.max(0, valOrig - jaPago);
        });

        const multasPorDevedor  = {};
        const primeiraPorDevedor = {};

        (data || []).forEach(p => {
            if (p.status_contrato !== 'ATRASADO' || p.isento_multa) return;
            const did = p.devedor_id;

            if (!multasPorDevedor[did]) {
                // CÁLCULO LIMPO: valor_original + capital × taxa × dias_totais_em_atraso
                // NÃO usa valor_atual do banco (que pode estar desatualizado)
                // NÃO depende do robô ter rodado — sempre correto
                const dtVenc = new Date(p.vencimento_parcela + 'T00:00:00-03:00');
                const diasTotais = dtVenc < hoje
                    ? Math.max(0, Math.floor((hoje - dtVenc) / (1000 * 60 * 60 * 24)))
                    : 0;
                const capital = parseFloat(p.valor_emprestado || 0);
                const multaTotal = diasTotais > 0
                    ? Math.round(capital * taxa * diasTotais * 100) / 100
                    : 0;

                multasPorDevedor[did]   = { multaTotal, diasTotais };
                primeiraPorDevedor[did] = p.parcela_id;
            } else {
                // Mantém a parcela mais antiga como a que recebe a multa
                const jaReg = (data || []).find(x => x.parcela_id === primeiraPorDevedor[did]);
                if (jaReg && p.vencimento_parcela < jaReg.vencimento_parcela) {
                    primeiraPorDevedor[did] = p.parcela_id;
                }
            }
        });

        const projetados = (data || []).map(p => {
            if (p.status_contrato !== 'ATRASADO') return p;

            const info = multasPorDevedor[p.devedor_id];
            if (!info || info.multaTotal <= 0) return p;

            // Só a primeira parcela vencida recebe a multa
            if (p.parcela_id !== primeiraPorDevedor[p.devedor_id]) return p;

            // valor_a_pagar = valor_original (parcela combinada) + multa total do contrato
            const valorOriginal = parseFloat(p.valor_original || p.valor_atual);
            const jaPago        = parseFloat(p.valor_pago || 0);
            const valorComMulta = Math.round((valorOriginal - jaPago + info.multaTotal) * 100) / 100;

            const saldoTotalProjetado = Math.round(((saldoBasePorDevedor[p.devedor_id] || 0) + info.multaTotal) * 100) / 100;

            return {
                ...p,
                valor_atual:          Math.round((valorOriginal + info.multaTotal) * 100) / 100,
                valor_pago:           p.valor_pago,   // mantém o já pago intacto
                multa_total:          info.multaTotal,
                dias_atraso:          info.diasTotais,
                valor_total_projetado: saldoTotalProjetado,
            };
        });

        // Parcelas ABERTO/PENDENTE: inclui saldo base como valor_total_projetado para consistência
        const projetadosComSaldo = projetados.map(p => {
            if (p.valor_total_projetado != null) return p; // já calculado (ATRASADO)
            return { ...p, valor_total_projetado: Math.round((saldoBasePorDevedor[p.devedor_id] || parseFloat(p.valor_total) || 0) * 100) / 100 };
        });

        res.json(projetadosComSaldo);
    } catch (error) { res.status(500).json({ erro: "Erro ao buscar parcelas de cobrança." }); }
});

app.get('/api/clientes-lista', async (req, res) => {
    try {
        let todos = []; let buscar = true; let ptr = 0;
        while (buscar) {
            const { data, error } = await supabase.from('devedores').select('id, cpf, nome, telefone, status').order('nome', { ascending: true }).range(ptr, ptr + 999);
            if (error || !data || data.length === 0) break;
            todos = todos.concat(data); if (data.length < 1000) buscar = false; ptr += 1000;
        }

        const unicos = []; const cpfs = new Set(); const cpfsDevendo = new Set(); const cpfsAtrasados = new Set(); const cpfsCadastrados = new Set();

        todos.forEach(c => {
            if (c.status !== 'PRE_CADASTRO') cpfsCadastrados.add(c.cpf);
            if (['ABERTO', 'ATRASADO'].includes(c.status)) cpfsDevendo.add(c.cpf);
            if (c.status === 'ATRASADO') cpfsAtrasados.add(c.cpf);
            if (!cpfs.has(c.cpf)) { cpfs.add(c.cpf); unicos.push(c); }
        });

        unicos.sort((a, b) => a.nome.localeCompare(b.nome));
        res.json({ clientes: unicos, totalDevendo: cpfsDevendo.size, totalAtrasados: cpfsAtrasados.size, totalCadastrados: cpfsCadastrados.size });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/calotes', async (req, res) => {
    try { const { data } = await supabase.from('devedores').select('*').eq('status', 'CALOTE').order('data_vencimento', { ascending: true }); res.json(data || []); } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/marcar-calote', async (req, res) => {
    try {
        const { id, reverter } = req.body;
        const novoStatus = reverter ? 'ATRASADO' : 'CALOTE';
        const evento = reverter ? 'Recuperação de Calote' : 'Baixa por Calote / Perda';
        const detalhes = reverter ? 'Cliente voltou para a esteira.' : 'Contrato congelado.';
        await supabase.from('devedores').update({ status: novoStatus }).eq('id', id);
        await supabase.from('logs').insert([{ evento, detalhes, devedor_id: id }]);
        res.json({ sucesso: true });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/enviar-cobranca-manual', async (req, res) => {
    try {
        const { data: dev } = await supabase.from('devedores').select('*').eq('id', req.body.id).single();
        if (!dev) throw new Error("Cliente não encontrado");

        const { data: confPix } = await supabase.from('config').select('valor').eq('chave', 'pix_avancado').maybeSingle();

        // Lê taxa configurada no sistema (respeita o que está em config)
        const taxa = await buscarTaxaMultaDiaria();

        // Calcula dias em atraso reais
        const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
        const dataVenc = new Date(dev.data_vencimento + 'T00:00:00-03:00');
        const diasAtraso = dataVenc < hoje
            ? Math.max(1, Math.floor((hoje - dataVenc) / (1000 * 60 * 60 * 24)))
            : 0;

        // Para parcelados: cobrar só parcelas vencidas + multa sobre o CAPITAL TOTAL
        // A multa de atraso incide sobre todo o capital emprestado, não por parcela.
        let valorCobranca;
        const capitalBase = parseFloat(dev.valor_emprestado || 0);

        if (dev.qtd_parcelas > 1 && diasAtraso > 0) {
            const hojeStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
            const { data: parcsVencidas } = await supabase
                .from('parcelas')
                .select('valor_original, valor_pago')
                .eq('devedor_id', dev.id)
                .in('status', ['ATRASADO', 'PENDENTE', 'PARCIAL'])
                .lte('data_vencimento', hojeStr);

            // MULTA TOTAL: capital × taxa × todos os dias desde vencimento (não só os pendentes)
            const multaTotalDias = Math.round(capitalBase * taxa * diasAtraso * 100) / 100;

            if (parcsVencidas?.length > 0) {
                // Usa valor_original (parcela combinada) não valor_atual (pode estar desatualizado)
                const saldoParcelas = parcsVencidas.reduce((acc, p) =>
                    acc + Math.max(0, parseFloat(p.valor_original) - parseFloat(p.valor_pago || 0)), 0);
                valorCobranca = Math.round((saldoParcelas + multaTotalDias) * 100) / 100;
            } else {
                valorCobranca = Math.round((parseFloat(dev.valor_total) + multaTotalDias) * 100) / 100;
            }
        } else {
            // Simples: valor_total + multa total desde vencimento
            const multaTotalDias = Math.round(capitalBase * taxa * diasAtraso * 100) / 100;
            valorCobranca = Math.round((parseFloat(dev.valor_total) + multaTotalDias) * 100) / 100;
        }

        const pixDados = dev.cobrar_so_em_dinheiro ? null : escolherPixInteligente(confPix?.valor, valorCobranca);

        if (diasAtraso > 0) {
            // Calcula multa total acumulada desde o vencimento (capital × taxa × dias totais)
            const dtVencMan = new Date(dev.data_vencimento + 'T00:00:00-03:00');
            const diasTotais = Math.max(1, Math.floor((hoje - dtVencMan) / (1000 * 60 * 60 * 24)));
            const multaTotalManual = Math.round(capitalBase * taxa * diasTotais * 100) / 100;

            await enviarReguaCobranca(
                dev.telefone, dev.nome,
                valorCobranca, capitalBase,
                diasAtraso, pixDados,
                dev.referencia1_nome || null,
                multaTotalManual,
                dev.data_vencimento
            );
        } else {
            const valorFmt  = valorCobranca.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
            const dtFmt     = dataVenc.toLocaleDateString('pt-BR');
            let msg = `⏰ *CMS VENTURES — LEMBRETE DE PAGAMENTO*\n\nOlá ${dev.nome}!\n\nSua fatura de *${valorFmt}* vence em *${dtFmt}*.\n\n`;
            if (pixDados?.chave) {
                msg += `🏦 *PAGUE VIA PIX:*\nFavorecido: *${pixDados.nome}*\nInstituição: *${pixDados.banco}*\n\nChave PIX:\n*${pixDados.chave}*\n\n`;
            } else if (dev.cobrar_so_em_dinheiro) {
                msg += `Conforme acordado, este contrato deve ser pago em *dinheiro físico*.\n\n`;
            } else {
                msg += `Para realizar o pagamento, entre em contato.\n\n`;
            }
            msg += `🤖 _Mensagem automática. Dúvidas? Responda aqui!_`;
            await enviarZap(dev.telefone, msg);
        }

        await supabase.from('logs').insert([{ evento: "Envio Manual de Cobrança", detalhes: `Cobrança enviada via WhatsApp. Valor cobrado: R$ ${valorCobranca.toFixed(2)}`, devedor_id: dev.id }]);
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// 7. MOTOR DE INTELIGÊNCIA ARTIFICIAL: SCORE
// ==========================================
app.get('/api/cliente-extrato/:busca', async (req, res) => {
    try {
        const buscaOriginal = decodeURIComponent(req.params.busca); 
        const hasNum = /\d/.test(buscaOriginal); 
        
        let queryMain = supabase.from('devedores').select('*');
        if (hasNum) { 
            const numLimpo = buscaOriginal.replace(/\D/g, ''); 
            queryMain = queryMain.or(`cpf.eq.${numLimpo},telefone.ilike.%${numLimpo}%`); 
        } else { 
            queryMain = queryMain.ilike('nome', `%${buscaOriginal}%`); 
        }
        
        const { data: cls } = await queryMain.order('created_at', { ascending: false }).limit(20);
        if (!cls || cls.length === 0) return res.status(404).json({ erro: "Cliente não encontrado." });
        
        const clientePrincipal = cls[0];
        // GUARD: CPF inválido (nulo ou todos zeros) — não buscar por CPF para evitar misturar clientes
        const cpfPrincipalLimpo = (clientePrincipal.cpf || '').replace(/\D/g, '');
        const cpfValido = cpfPrincipalLimpo.length >= 11 && !/^0+$/.test(cpfPrincipalLimpo);
        const { data: tds } = cpfValido
            ? await supabase.from('devedores').select('*').eq('cpf', clientePrincipal.cpf).order('created_at', { ascending: false })
            : { data: [clientePrincipal] };

        const tdsValidos = (tds || cls).filter(c => c.status !== 'CANCELADO');
        let scoreCalculado = 500;

        // Busca valor_original das próximas parcelas pendentes de todos os contratos
        // para sobrescrever o cálculo de formatarContratoCarne (que inflaciona com multas)
        const idsContratosAtivos = tdsValidos.map(c => c.id);
        const parcelasReaisMap = {};
        if (idsContratosAtivos.length > 0) {
            const { data: parcsReais } = await supabase
                .from('parcelas')
                .select('devedor_id, numero_parcela, valor_original')
                .in('devedor_id', idsContratosAtivos)
                .in('status', ['PENDENTE', 'ATRASADO', 'PARCIAL'])
                .order('numero_parcela', { ascending: true });
            // Guarda apenas a 1ª parcela pendente de cada contrato
            (parcsReais || []).forEach(p => {
                if (!parcelasReaisMap[p.devedor_id]) parcelasReaisMap[p.devedor_id] = p;
            });
        }

        const tdsComParcelas = tdsValidos.map(dev => {
            const parcelaReal = parcelasReaisMap[dev.id];
            dev = formatarContratoCarne(
                dev,
                parcelaReal?.valor_original ? parseFloat(parcelaReal.valor_original) : null,
                parcelaReal?.numero_parcela || null
            );
            if (dev.status === 'QUITADO') scoreCalculado += 150;
            if (dev.status === 'ATRASADO') {
                const dtVenc = new Date(dev.data_vencimento + 'T12:00:00Z');
                const hj = new Date(); hj.setHours(0,0,0,0);
                if (dtVenc < hj) {
                    const diasOff = Math.floor((hj - dtVenc) / (1000 * 60 * 60 * 24));
                    scoreCalculado -= (diasOff * 5); 
                }
            }
            return dev;
        });

        scoreCalculado = Math.min(1000, Math.max(0, scoreCalculado));
        const idsArray = tdsValidos.map(c => c.id);
        let logs = [];
        if (idsArray.length > 0) {
            const { data: logsData } = await supabase.from('logs').select('*').in('devedor_id', idsArray).order('created_at', { ascending: false }).limit(300);
            logs = logsData || [];
        }
        
        res.json({ cliente: tdsComParcelas.length > 0 ? tdsComParcelas[0] : clientePrincipal, todos_contratos: tdsComParcelas, logs: logs, score: scoreCalculado });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Busca extrato diretamente pelo ID do devedor (evita problema de CPF=0000)
app.get('/api/cliente-extrato-id/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        if (!id) return res.status(400).json({ erro: 'ID inválido.' });

        const { data: clientePrincipal } = await supabase.from('devedores').select('*').eq('id', id).single();
        if (!clientePrincipal) return res.status(404).json({ erro: 'Cliente não encontrado.' });

        // GUARD: CPF inválido (nulo ou todos zeros) — não buscar por CPF para evitar misturar clientes
        const cpfIdLimpo = (clientePrincipal.cpf || '').replace(/\D/g, '');
        const cpfIdValido = cpfIdLimpo.length >= 11 && !/^0+$/.test(cpfIdLimpo);
        const { data: tds } = cpfIdValido
            ? await supabase.from('devedores').select('*').eq('cpf', clientePrincipal.cpf).order('created_at', { ascending: false })
            : { data: [clientePrincipal] };
        const tdsValidos = (tds || [clientePrincipal]).filter(c => c.status !== 'CANCELADO');

        // Busca valor_original das próximas parcelas pendentes de todos os contratos
        const idsContratosAtivosId = tdsValidos.map(c => c.id);
        const parcelasReaisMapId = {};
        if (idsContratosAtivosId.length > 0) {
            const { data: parcsReaisId } = await supabase
                .from('parcelas')
                .select('devedor_id, numero_parcela, valor_original')
                .in('devedor_id', idsContratosAtivosId)
                .in('status', ['PENDENTE', 'ATRASADO', 'PARCIAL'])
                .order('numero_parcela', { ascending: true });
            (parcsReaisId || []).forEach(p => {
                if (!parcelasReaisMapId[p.devedor_id]) parcelasReaisMapId[p.devedor_id] = p;
            });
        }

        let scoreCalculado = 500;
        const tdsComParcelas = tdsValidos.map(dev => {
            const parcelaRealId = parcelasReaisMapId[dev.id];
            dev = formatarContratoCarne(
                dev,
                parcelaRealId?.valor_original ? parseFloat(parcelaRealId.valor_original) : null,
                parcelaRealId?.numero_parcela || null
            );
            if (dev.status === 'QUITADO') scoreCalculado += 150;
            if (dev.status === 'ATRASADO') {
                const dtVenc = new Date(dev.data_vencimento + 'T12:00:00Z');
                const hj = new Date(); hj.setHours(0,0,0,0);
                if (dtVenc < hj) scoreCalculado -= (Math.floor((hj - dtVenc) / (1000*60*60*24)) * 5);
            }
            return dev;
        });
        scoreCalculado = Math.min(1000, Math.max(0, scoreCalculado));

        const idsArray = tdsValidos.map(c => c.id);
        let logs = [];
        if (idsArray.length > 0) {
            const { data: logsData } = await supabase.from('logs').select('*').in('devedor_id', idsArray).order('created_at', { ascending: false }).limit(300);
            logs = logsData || [];
        }

        res.json({ cliente: tdsComParcelas[0] || clientePrincipal, todos_contratos: tdsComParcelas, logs, score: scoreCalculado });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/buscar-cliente-admin/:busca', async (req, res) => {
    try {
        const b = decodeURIComponent(req.params.busca); const hasNum = /\d/.test(b); 
        let q = supabase.from('devedores').select('id, nome, cpf, telefone, status');
        if (hasNum) { const numL = b.replace(/\D/g, ''); q = q.or(`cpf.eq.${numL},telefone.ilike.%${numL}%`); } else { q = q.ilike('nome', `%${b}%`); }
        
        const { data: cls } = await q.limit(10);
        const uniqueClients = []; const cpfs = new Set();
        (cls || []).forEach(c => { if (!cpfs.has(c.cpf)) { cpfs.add(c.cpf); uniqueClients.push(c); } });
        res.json(uniqueClients);
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// 8. CRM KANBAN E ANÁLISE DE SAFRAS
// ==========================================
app.get('/api/crm', async (req, res) => {
    try {
        const hojeStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
        const hojeObj = new Date(); hojeObj.setHours(0,0,0,0);
        const taxa    = await buscarTaxaMultaDiaria();

        const { data, error } = await supabase
            .from('vw_cobranca_ativa_parcelas')
            .select('*')
            .lt('vencimento_parcela', hojeStr)
            .order('vencimento_parcela', { ascending: true });

        if (error) throw error;

        // Mesma lógica do devedores-ativos:
        // multa total (capital × taxa × diasTotais) vai inteira na primeira parcela vencida.
        const multasPorDevedor  = {};
        const primeiraPorDevedor = {};

        (data || []).forEach(p => {
            const did = p.devedor_id;
            if (!multasPorDevedor[did]) {
                const capital    = parseFloat(p.valor_emprestado || 0);
                const dtVenc     = new Date(p.vencimento_parcela + 'T00:00:00-03:00');
                const diasTotais = dtVenc < hojeObj
                    ? Math.max(0, Math.floor((hojeObj - dtVenc) / (1000 * 60 * 60 * 24)))
                    : 0;
                multasPorDevedor[did]    = diasTotais > 0 ? Math.round(capital * taxa * diasTotais * 100) / 100 : 0;
                primeiraPorDevedor[did]  = p.parcela_id;
            } else {
                const jaReg = (data || []).find(x => x.parcela_id === primeiraPorDevedor[did]);
                if (jaReg && p.vencimento_parcela < jaReg.vencimento_parcela) {
                    primeiraPorDevedor[did] = p.parcela_id;
                }
            }
        });

        const formatados = (data || []).map(d => {
            const valOrig  = parseFloat(d.valor_original || d.valor_atual);
            const jaPago   = parseFloat(d.valor_pago || 0);
            const multa    = d.parcela_id === primeiraPorDevedor[d.devedor_id]
                ? (multasPorDevedor[d.devedor_id] || 0)
                : 0;
            return {
                ...d,
                id:          d.devedor_id,
                valor_total: Math.round((valOrig - jaPago + multa) * 100) / 100,
                multa_total: multa,
            };
        });

        res.json(formatados);
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

// CORREÇÃO: segunda definição de /api/crm removida — estava sobrescrevendo a versão acima
// e vazando error.stack no response. A versão correta (com filtro de data) está acima.

app.get('/api/safras', async (req, res) => {
    try {
        // CORREÇÃO: antes carregava todos devedores e logs em memória em loop paginado.
        // Agora usa a função SQL obter_relatorio_safras() que já existe no schema,
        // fazendo o agrupamento direto no banco — muito mais eficiente e sem risco de timeout.
        const { data, error } = await supabase.rpc('obter_relatorio_safras');
        if (error) throw new Error(error.message);
        res.json(data || []);
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// 9. EDIÇÃO E BAIXAS MANUAIS
// ==========================================
app.post('/api/editar-contrato', async (req, res) => {
    try {
        const { id, novoVencimento, novoCapital, novoTotal, novaFrequencia, cobrarSoEmDinheiro, novasParcelas, novaTaxa, isentoMulta } = req.body;
        const { data: devAntigo } = await supabase.from('devedores').select('valor_emprestado, status').eq('id', id).maybeSingle();
        if (devAntigo?.status === 'APROVADO_AGUARDANDO_ACEITE') return res.status(400).json({ erro: "Contrato pendente não editável." });

        let payload = { 
            data_vencimento: novoVencimento, valor_emprestado: limparMoeda(novoCapital), valor_total: limparMoeda(novoTotal), 
            frequencia: novaFrequencia, status: 'ABERTO', ultima_cobranca_atraso: null, pago: false, 
            cobrar_so_em_dinheiro: cobrarSoEmDinheiro, isento_multa: isentoMulta || false
        };

        if (novasParcelas) payload.qtd_parcelas = parseInt(novasParcelas);
        if (novaTaxa) payload.taxa_juros = limparMoeda(novaTaxa);

        await supabase.from('devedores').update(payload).eq('id', id);
        await supabase.from('parcelas').delete().eq('devedor_id', id).in('status', ['PENDENTE', 'ATRASADO', 'PARCIAL']);
        await gerarParcelasNoBanco(id, limparMoeda(novoTotal), parseInt(novasParcelas) || 1, novoVencimento, novaFrequencia);

        const capitalAntigo = Math.round((parseFloat(devAntigo?.valor_emprestado) || 0) * 100) / 100;
        const capitalNovo   = Math.round(limparMoeda(novoCapital) * 100) / 100;
        const difCapital    = Math.round((capitalNovo - capitalAntigo) * 100) / 100;

        const logsEditar = [{ evento: "Edição Manual", detalhes: `Novo Vencimento: ${novoVencimento}. Saldo Restante: R$ ${limparMoeda(novoTotal)}. Capital anterior: R$ ${capitalAntigo.toFixed(2)} → R$ ${capitalNovo.toFixed(2)}.`, devedor_id: id, valor_fluxo: 0 }];

        if (difCapital > 0.01) {
            // Novo capital liberado: aparece no relatório como saída de caixa (valor negativo)
            logsEditar.push({ evento: "Empréstimo Liberado", detalhes: `[EDIÇÃO] Aditamento de contrato: +R$ ${difCapital.toFixed(2)} ao capital existente.`, devedor_id: id, valor_fluxo: -difCapital });
        } else if (difCapital < -0.01) {
            // Capital reduzido (correção): registra retorno proporcional de caixa
            logsEditar.push({ evento: "Ajuste de Capital", detalhes: `[EDIÇÃO] Redução de capital: R$ ${Math.abs(difCapital).toFixed(2)} devolvido ao caixa.`, devedor_id: id, valor_fluxo: Math.abs(difCapital) });
        }

        await supabase.from('logs').insert(logsEditar);
        res.json({ sucesso: true });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Edita o valor de UMA parcela futura sem redistribuir nas demais.
// Ajusta devedores.valor_total pela diferença.
app.post('/api/editar-parcela-individual', async (req, res) => {
    try {
        const { parcela_id, novo_valor } = req.body;
        if (!parcela_id || novo_valor == null) return res.status(400).json({ erro: 'parcela_id e novo_valor são obrigatórios.' });

        const novoValor = Math.round(parseFloat(novo_valor) * 100) / 100;
        if (novoValor < 0) return res.status(400).json({ erro: 'Valor não pode ser negativo.' });

        const { data: parc, error: errParc } = await supabase
            .from('parcelas')
            .select('id, devedor_id, valor_original, valor_atual, valor_pago, status, numero_parcela')
            .eq('id', parcela_id)
            .single();
        if (errParc || !parc) return res.status(404).json({ erro: 'Parcela não encontrada.' });

        if (!['PENDENTE', 'ATRASADO', 'PARCIAL'].includes(parc.status)) {
            return res.status(400).json({ erro: 'Só é possível editar parcelas pendentes.' });
        }

        const valorAtual    = Math.round(parseFloat(parc.valor_original) * 100) / 100;
        const diferenca     = Math.round((novoValor - valorAtual) * 100) / 100;

        // Atualiza a parcela
        const { error: errUpd } = await supabase
            .from('parcelas')
            .update({ valor_original: novoValor, valor_atual: novoValor })
            .eq('id', parcela_id);
        if (errUpd) throw errUpd;

        // Ajusta o valor_total do contrato pela mesma diferença
        if (Math.abs(diferenca) > 0.009) {
            const { data: dev } = await supabase.from('devedores').select('valor_total').eq('id', parc.devedor_id).single();
            const novoTotal = Math.max(0, Math.round((parseFloat(dev.valor_total) + diferenca) * 100) / 100);
            await supabase.from('devedores').update({ valor_total: novoTotal }).eq('id', parc.devedor_id);
            await supabase.from('logs').insert([{
                evento: 'Ajuste de Parcela',
                detalhes: `Parcela ${parc.numero_parcela} ajustada: R$ ${valorAtual.toFixed(2)} → R$ ${novoValor.toFixed(2)} (diferença: ${diferenca > 0 ? '+' : ''}R$ ${diferenca.toFixed(2)}). Demais parcelas não alteradas.`,
                devedor_id: parc.devedor_id,
                valor_fluxo: 0
            }]);
        }

        res.json({ sucesso: true, diferenca });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/estatisticas-pagamento/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { data: dev } = await supabase.from('devedores').select('*').eq('id', id).single();
        if (!dev) throw new Error("Contrato não encontrado");
        
        const { data: logs } = await supabase.from('logs').select('*').eq('devedor_id', id);

        let totalPago = 0;
        logs?.forEach(l => {
            if ((l.evento.includes('Rolagem') || l.evento.includes('Pagamento') || l.evento.includes('Liquidação') || l.evento.includes('Recebimento') || l.evento.includes('Quitação')) && l.valor_fluxo > 0) {
                totalPago += parseFloat(l.valor_fluxo) || 0;
            }
        });
        
        const venc = new Date(dev.data_vencimento + 'T12:00:00Z');
        let diasAtraso = 0;
        if (new Date() > venc) diasAtraso = Math.floor((new Date() - venc) / (1000 * 60 * 60 * 24));

        res.json({ data_emprestimo: dev.created_at, capital_original: dev.valor_emprestado, saldo_atual: parseFloat(dev.valor_total || 0), dias_atraso: Math.max(0, diasAtraso), total_pago: totalPago });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/baixar-manual', async (req, res) => {
    const { id, parcelaId, valorPago, formaPagamento, observacoes, dataRecebimento, novoVencimento, modoBaixa,
            recalculoAjuste, recalculoTaxa, recalculoParcelas } = req.body;
    if (!parcelaId) return res.status(400).json({ erro: "ID da parcela não foi enviado." });

    // Trava por parcelaId: impede duplo processamento da mesma parcela em paralelo
    const lockKeyBaixa = `baixa_${parcelaId}`;
    if (travasAtivasPainel.has(lockKeyBaixa)) return res.status(429).json({ erro: "Baixa já está sendo processada. Aguarde." });
    travasAtivasPainel.add(lockKeyBaixa);

    try {

        const { data: parc } = await supabase.from('parcelas').select('*').eq('id', parcelaId).single();
        const { data: dev } = await supabase.from('devedores').select('*').eq('id', id).single();
        if (!parc || !dev) throw new Error("Dados não encontrados no banco.");

        // Declarados aqui para evitar TDZ (temporal dead zone) nas checagens abaixo
        const ajuste_     = recalculoAjuste    != null ? parseFloat(recalculoAjuste)    : null;
        const novaTaxaPct_= recalculoTaxa      != null ? parseFloat(recalculoTaxa)      : null;
        const novasParcs  = recalculoParcelas  != null ? parseInt(recalculoParcelas)     : null;

        const valPago     = Math.round((parseFloat(valorPago) || 0) * 100) / 100;
        let totalAtual    = Math.round((parseFloat(dev.valor_total)      || 0) * 100) / 100;
        let capitalAtual  = Math.round((parseFloat(dev.valor_emprestado) || 0) * 100) / 100;

        // ── MODO ACORDO: Encerrar contrato pelo valor negociado ───────────────
        if (modoBaixa === 'ACORDO') {
            const dataEnvioAcordo = dataRecebimento
                ? (dataRecebimento.includes('T') ? dataRecebimento : `${dataRecebimento}T12:00:00-03:00`)
                : new Date().toISOString();
            const desconto = Math.max(0, Math.round((totalAtual - valPago) * 100) / 100);

            // Registra o recebimento no extrato
            await supabase.from('logs').insert([{
                devedor_id:    parseInt(id),
                evento:        'Quitação por Acordo',
                detalhes:      `[ACORDO] Recebido R$ ${valPago.toFixed(2)} de R$ ${totalAtual.toFixed(2)} total. Desconto concedido: R$ ${desconto.toFixed(2)}.${observacoes ? ' OBS: ' + observacoes : ''}`,
                valor_fluxo:   valPago,
                valor_capital: Math.min(capitalAtual, valPago),
                valor_juros:   Math.max(0, Math.round((valPago - capitalAtual) * 100) / 100),
                created_at:    dataEnvioAcordo
            }]);

            // Encerra o contrato definitivamente
            const novoTotalJaPegoAcordo = Math.round(((parseFloat(dev.total_ja_pego) || 0) + valPago) * 100) / 100;
            await supabase.from('devedores')
                .update({ valor_total: 0, valor_emprestado: 0, status: 'QUITADO', pago: true, total_ja_pego: novoTotalJaPegoAcordo })
                .eq('id', parseInt(id));

            // Marca todas as parcelas abertas como PAGA
            await supabase.from('parcelas')
                .update({ status: 'PAGA' })
                .eq('devedor_id', parseInt(id))
                .in('status', ['PENDENTE', 'ATRASADO', 'PARCIAL']);

            enviarConfirmacaoBaixa(dev.telefone, dev.nome, valPago, 0, null, formaPagamento || 'PIX')
                .catch(e => console.warn('[ACORDO] Falha WhatsApp:', e.message));

            return res.json({ sucesso: true });
        }
        // ─────────────────────────────────────────────────────────────────────

        // ── APLICAR MULTAS PENDENTES ANTES DO PAGAMENTO ──────────────────────
        const taxa = await buscarTaxaMultaDiaria();
        const projecao = projetarJurosAtraso(dev, taxa);
        if (projecao.diasPendentes > 0 && projecao.multaPendente > 0) {
            const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
            if (financeService?.aplicarMultaDiaria) {
                await financeService.aplicarMultaDiaria(dev, hoje, taxa); // taxa já buscada acima
            }
            const { data: devAtualizado } = await supabase
                .from('devedores').select('valor_total, valor_emprestado').eq('id', id).single();
            if (devAtualizado) {
                totalAtual   = Math.round((parseFloat(devAtualizado.valor_total)      || 0) * 100) / 100;
                capitalAtual = Math.round((parseFloat(devAtualizado.valor_emprestado) || 0) * 100) / 100;
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        // ── DRE CORRETO: SEPARAR PARCELA ORIGINAL DA MULTA ───────────────────
        //
        // REGRA DE NEGÓCIO:
        //   - A multa de atraso (juros diários) é receita extra, NÃO reduz capital.
        //   - Apenas a parcela combinada (valor_original) amortiza capital.
        //   - O excedente (valPago - valor_original + já_pago) = multa pura = lucro extra.
        //
        // Exemplo: capital=2000, 4x1000, parcela 1/4 em atraso, multa=540, paga 1540
        //   pagoOriginal = 1000 (parcela combinada)
        //   pagoMulta    = 540  (multa pura — não toca no capital)
        //   amortizaCapital = 1000 × (2000 / 4000) = 500   ← correto, não 677
        //   novoValorEmprestado = 2000 - 500 = 1500         ← correto

        const valorOriginalParcela = Math.round((parseFloat(parc.valor_original) || parseFloat(parc.valor_atual)) * 100) / 100;
        const jaPagoParcela        = Math.round((parseFloat(parc.valor_pago || 0)) * 100) / 100;
        const restoOriginal        = Math.max(0, valorOriginalParcela - jaPagoParcela);

        // Quanto do pagamento cobre a parcela original vs a multa
        const pagoSobreOriginal = Math.min(valPago, restoOriginal);
        const pagoMulta         = Math.max(0, Math.round((valPago - restoOriginal) * 100) / 100);

        // ── AMORTIZAÇÃO CORRETA DE CAPITAL ──────────────────────────────────
        //
        // PROBLEMA DO RATIO FIXO: usar capitalAtual/totalOriginalContrato causa drift.
        // Após pagar parcela 1, capitalAtual cai de 2000→1500, mas totalOriginal fica
        // em 4000 — o ratio diminui de 0.5 para 0.375, distorcendo as parcelas seguintes.
        //
        // SOLUÇÃO: capitalAtual / parcelasRestantes = capital fixo por parcela
        //   Parcela 1: 2000/4 = 500  Parcela 2: 1500/3 = 500  Parcela 3: 1000/2 = 500
        //   Resultado: sempre R$ 500 de capital por parcela, R$ 500 de juros mensais.
        //
        // Busca quantas parcelas ainda estão em aberto (incluindo a atual)
        const { data: parcsAbertas } = await supabase
            .from('parcelas')
            .select('id')
            .eq('devedor_id', id)
            .in('status', ['PENDENTE', 'ATRASADO', 'PARCIAL'])
            .neq('status', 'CANCELADA');
        const parcelasRestantes = Math.max(1, (parcsAbertas?.length || 1));

        const capitalPorParcela    = Math.round((capitalAtual / parcelasRestantes) * 100) / 100;
        const amortizaCapital      = Math.min(capitalPorParcela, pagoSobreOriginal);
        const amortizaJurosMensalid = Math.max(0, Math.round((pagoSobreOriginal - amortizaCapital) * 100) / 100);
        const amortizaJurosTotal    = Math.round((amortizaJurosMensalid + pagoMulta) * 100) / 100;

        // novoStatusParcela precisa ser declarado ANTES de novoValorTotal que o usa
        const novoStatusParcela   = (pagoSobreOriginal >= Math.max(0.01, restoOriginal - 0.10)) ? 'PAGA' : 'PARCIAL';

        const novoValorTotal = (() => {
            if (novoStatusParcela === 'PAGA') {
                const multaAcumuladaNoBanco = Math.max(0, totalAtual - (parcelasRestantes * valorOriginalParcela));
                const multaRestante         = Math.max(0, multaAcumuladaNoBanco - pagoMulta);
                return Math.max(0, Math.round(((parcelasRestantes - 1) * valorOriginalParcela + multaRestante) * 100) / 100);
            } else {
                return Math.max(0, Math.round((totalAtual - valPago) * 100) / 100);
            }
        })();
        // Capital reduz APENAS pela porção mensalidade — multa não toca no capital
        const novoValorEmprestado = Math.max(0, Math.round((capitalAtual - amortizaCapital) * 100) / 100);

        let dataVencGlobal  = novoVencimento ? novoVencimento : dev.data_vencimento;
        const dataEnvioFinal = dataRecebimento
            ? (dataRecebimento.includes('T') ? dataRecebimento : `${dataRecebimento}T12:00:00-03:00`)
            : new Date().toISOString();

        // Determina se o contrato estava atrasado (tem multa embutida no pagamento)
        const dataVencCheck = new Date(dev.data_vencimento + 'T00:00:00-03:00');
        const hojeCheck     = new Date(); hojeCheck.setHours(0,0,0,0);
        const estaAtrasado  = dataVencCheck < hojeCheck;

        // Evento e detalhe diferenciados para o relatório classificar corretamente:
        //   Pagamento em dia    → "Pagamento de Parcela"
        //   Pagamento atrasado  → "Pagamento com Atraso" + tag [MULTA] nos detalhes
        //
        // valor_juros no log = amortizaJurosMensalid + pagoMulta
        //   O relatorio usa valor_juros para saber quanto foi lucro.
        //   Distingue mensalidade de multa pelo evento/tag — não pelo valor_juros bruto.
        const eventoLog = estaAtrasado ? 'Pagamento com Atraso' : 'Pagamento de Parcela';
        const detalhesLog = estaAtrasado
            ? `[MULTA] [${formaPagamento}] Recebido R$ ${valPago.toFixed(2)} ref. parcela ${parc.numero_parcela} (original: R$ ${pagoSobreOriginal.toFixed(2)} + multa: R$ ${pagoMulta.toFixed(2)}). ${observacoes ? 'OBS: ' + observacoes : ''}`
            : `[${formaPagamento}] Recebido R$ ${valPago.toFixed(2)} ref. parcela ${parc.numero_parcela}. ${observacoes ? 'OBS: ' + observacoes : ''}`;

        const { error } = await supabase.rpc('processar_transacao_financeira', {
            p_devedor_id:      parseInt(id),
            p_pago:            valPago,
            p_novo_total:      novoValorTotal,
            p_capital:         novoValorEmprestado,   // capital reduz só pela porção mensalidade
            p_status:          null,
            p_novo_vencimento: dataVencGlobal,
            p_novas_parcelas:  dev.qtd_parcelas,
            p_limpar_atraso:   estaAtrasado && novoStatusParcela === 'PAGA', // só limpa se a parcela foi totalmente quitada
            p_evento:          eventoLog,
            p_detalhes:        detalhesLog,
            p_transaction_id:  `BAIXA_${parcelaId}_${Date.now()}`,
            p_data_pagamento:  dataEnvioFinal,
            p_valor_capital:   amortizaCapital,       // só a porção mensalidade
            p_valor_juros:     amortizaJurosTotal,    // mensalidade + multa = lucro total
            p_parcela_id:      parseInt(parcelaId),
            p_parcela_pago:    valPago,
            p_parcela_status:  novoStatusParcela
        });
        if (error) throw error;

        // ── VALOR DA PRÓXIMA PARCELA NEGOCIADO ───────────────────────────────
        // Quando o admin combina um valor específico para o próximo pagamento,
        // atualiza apenas a parcela-alvo sem tocar nas demais.
        const valorProxParc = req.body.valorProximaParcela != null ? parseFloat(req.body.valorProximaParcela) : null;
        if (valorProxParc !== null && !isNaN(valorProxParc) && valorProxParc > 0) {
            if (novoStatusParcela === 'PARCIAL') {
                // Parcela atual ainda aberta: ajusta seu valor_atual para (já_pago + combinado)
                const { data: parcPos } = await supabase.from('parcelas').select('valor_pago, valor_atual').eq('id', parseInt(parcelaId)).single();
                const vPagoPos   = Math.round((parseFloat(parcPos?.valor_pago)  || 0) * 100) / 100;
                const vAtualPos  = Math.round((parseFloat(parcPos?.valor_atual) || 0) * 100) / 100;
                const novoVAtual = Math.round((vPagoPos + valorProxParc) * 100) / 100;
                await supabase.from('parcelas').update({ valor_atual: novoVAtual }).eq('id', parseInt(parcelaId));
                // Reflete a diferença no valor_total do contrato
                const diff = Math.round((novoVAtual - vAtualPos) * 100) / 100;
                if (diff !== 0) {
                    const { data: devDiff } = await supabase.from('devedores').select('valor_total').eq('id', id).single();
                    const novoTotalDiff = Math.max(0, Math.round(((parseFloat(devDiff?.valor_total) || 0) + diff) * 100) / 100);
                    await supabase.from('devedores').update({ valor_total: novoTotalDiff }).eq('id', id);
                }
            } else {
                // Parcela atual foi totalmente paga: ajusta a próxima PENDENTE
                const { data: proxParc } = await supabase.from('parcelas')
                    .select('id, valor_atual').eq('devedor_id', id).eq('status', 'PENDENTE')
                    .order('numero_parcela', { ascending: true }).limit(1).maybeSingle();
                if (proxParc) {
                    const vAtualProx = Math.round((parseFloat(proxParc.valor_atual) || 0) * 100) / 100;
                    const diff = Math.round((valorProxParc - vAtualProx) * 100) / 100;
                    await supabase.from('parcelas').update({ valor_atual: Math.round(valorProxParc * 100) / 100 }).eq('id', proxParc.id);
                    if (diff !== 0) {
                        const { data: devDiff } = await supabase.from('devedores').select('valor_total').eq('id', id).single();
                        const novoTotalDiff = Math.max(0, Math.round(((parseFloat(devDiff?.valor_total) || 0) + diff) * 100) / 100);
                        await supabase.from('devedores').update({ valor_total: novoTotalDiff }).eq('id', id);
                    }
                }
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        const { data: parcAbertas } = await supabase
            .from('parcelas')
            .select('id, valor_atual, valor_pago, data_vencimento, status, numero_parcela')
            .eq('devedor_id', id)
            .neq('status', 'CANCELADA')
            .order('numero_parcela', { ascending: true });

        let saldoAtualizado = 0;
        parcAbertas?.forEach(p => saldoAtualizado += Math.max(0, parseFloat(p.valor_atual) - parseFloat(p.valor_pago || 0)));

        // Próxima parcela pendente — usada para avançar o vencimento do contrato
        // e para informar a data correta na mensagem de confirmação.
        // SEM isso, o contrato ficaria travado em 17/04 mesmo após pagar a primeira
        // parcela, e a mensagem diria "próximo vencimento: 17/04" (a que foi paga).
        const proximaParcela = parcAbertas?.find(
            p => ['PENDENTE', 'ATRASADO', 'PARCIAL'].includes(p.status)
        );
        const proximoVencimentoReal = proximaParcela?.data_vencimento || null;

        if (saldoAtualizado <= 0.10) {
            await supabase.from('devedores').update({ valor_total: 0, valor_emprestado: 0, status: 'QUITADO', pago: true }).eq('id', id);
            await supabase.from('logs').insert([{ evento: 'Quitação Total', detalhes: 'Contrato liquidado com sucesso.', devedor_id: id }]);
        } else if (novoStatusParcela === 'PAGA') {
            // Parcela paga mas contrato ainda tem saldo → avança vencimento e
            // determina o novo status: ABERTO se a próxima parcela ainda não venceu,
            // ATRASADO se já passou da data (ex: cliente tinha 2 parcelas vencidas e pagou só uma).
            // Prioridade: vencimento definido pelo admin > próxima parcela real > vencimento atual
            const dataVencFinal = novoVencimento || proximoVencimentoReal || dev.data_vencimento;
            const dtProxima = dataVencFinal
                ? new Date(dataVencFinal + 'T00:00:00-03:00')
                : null;
            const novoStatusContrato = (dtProxima && dtProxima > hojeCheck) ? 'ABERTO' : 'ATRASADO';
            // valor_total reconciliado com a soma real das parcelas: garante que
            // devedores.valor_total nunca diverge da tabela parcelas (ex: multa parcialmente
            // coberta faz novoValorTotal != saldoAtualizado em edge cases).
            await supabase.from('devedores')
                .update({
                    data_vencimento: dataVencFinal,
                    status: novoStatusContrato,
                    valor_total: Math.round(saldoAtualizado * 100) / 100
                })
                .eq('id', id);

            // Se o admin definiu um novo vencimento e não houve reparcelamento,
            // atualiza também a próxima parcela pendente para refletir a nova data.
            if (novoVencimento && proximaParcela && !novasParcs) {
                await supabase.from('parcelas')
                    .update({ data_vencimento: novoVencimento })
                    .eq('id', proximaParcela.id);
            }
        } else if (novoVencimento) {
            // PARCIAL: parcela ainda aberta — atualiza data de vencimento desta parcela e do contrato
            const dtProxParcial = new Date(novoVencimento + 'T00:00:00-03:00');
            const novoStatusContratoP = dtProxParcial > hojeCheck ? 'ABERTO' : 'ATRASADO';
            await supabase.from('devedores')
                .update({ data_vencimento: novoVencimento, status: novoStatusContratoP })
                .eq('id', id);
            await supabase.from('parcelas')
                .update({ data_vencimento: novoVencimento })
                .eq('id', parseInt(parcelaId));
        }

        // MENSAGEM WHATSAPP — bifurca conforme o tipo de baixa:
        //   PARCIAL + data agendada → confirma parcial e informa agendamento do restante
        //   PARCIAL sem data        → confirmação simples com saldo restante
        //   PAGA (integral)         → confirmação com próximo vencimento real
        const novoSaldoFinal = saldoAtualizado <= 0.10 ? 0 : Math.round(saldoAtualizado * 100) / 100;

        if (novoStatusParcela === 'PARCIAL') {
            // Calcula quanto ainda falta pagar nesta parcela específica
            const parcelaAtualizada = parcAbertas?.find(p => p.id === parseInt(parcelaId));
            const restanteParcela = parcelaAtualizada
                ? Math.max(0, Math.round((parseFloat(parcelaAtualizada.valor_atual) - parseFloat(parcelaAtualizada.valor_pago || 0)) * 100) / 100)
                : novoSaldoFinal;

            if (novoVencimento) {
                // Admin agendou uma data para o segundo pagamento → mensagem de agendamento
                enviarAgendamentoParcial(
                    dev.telefone, dev.nome,
                    valPago, restanteParcela,
                    novoVencimento,
                    formaPagamento || 'PIX'
                ).catch(e => console.warn('[AGENDAMENTO PARCIAL] Falha WhatsApp:', e.message));
            } else {
                // Sem data agendada → confirmação simples informando o restante
                enviarConfirmacaoBaixa(
                    dev.telefone, dev.nome,
                    valPago, restanteParcela,
                    null,
                    formaPagamento || 'PIX'
                ).catch(e => console.warn('[CONFIRM PARCIAL] Falha WhatsApp:', e.message));
            }
        } else {
            // Parcela integralmente paga → confirma com próximo vencimento real (17/05, não 17/04)
            enviarConfirmacaoBaixa(
                dev.telefone, dev.nome,
                valPago, novoSaldoFinal,
                novoSaldoFinal > 0 ? proximoVencimentoReal : null,
                formaPagamento || 'PIX'
            ).catch(e => console.warn('[CONFIRM BAIXA] Falha WhatsApp:', e.message));
        }

        // ── RECÁLCULO MANUAL DE ESTRUTURA (pós-pagamento) ────────────────────
        const ajuste = ajuste_;         // declarado no início da rota para evitar TDZ
        const novaTaxaPct = novaTaxaPct_; // idem

        if (ajuste !== null && !isNaN(ajuste) && ajuste !== 0) {
            const { data: devPos } = await supabase.from('devedores').select('valor_total, valor_emprestado').eq('id', id).single();
            const saldoPos   = Math.round((parseFloat(devPos?.valor_total)      || 0) * 100) / 100;
            const capitalPos = Math.round((parseFloat(devPos?.valor_emprestado) || 0) * 100) / 100;
            const novoSaldoAj   = Math.max(0, Math.round((saldoPos   + ajuste) * 100) / 100);
            const ratioCapital  = saldoPos > 0 ? Math.min(1, capitalPos / saldoPos) : 0;
            const novoCapitalAj = Math.max(0, Math.round((capitalPos + ajuste * ratioCapital) * 100) / 100);
            await supabase.from('devedores').update({ valor_total: novoSaldoAj, valor_emprestado: novoCapitalAj }).eq('id', id);
            await supabase.from('logs').insert([{
                devedor_id: parseInt(id),
                evento:     ajuste < 0 ? 'Desconto Manual' : 'Acréscimo Manual',
                detalhes:   `[AJUSTE] Saldo ${ajuste > 0 ? '+' : ''}R$ ${ajuste.toFixed(2)}. De R$ ${saldoPos.toFixed(2)} → R$ ${novoSaldoAj.toFixed(2)}.${observacoes ? ' OBS: ' + observacoes : ''}`,
                valor_fluxo: ajuste < 0 ? ajuste : 0
            }]);

            // Se o desconto zerou o saldo, encerra o contrato
            if (novoSaldoAj <= 0.10) {
                await supabase.from('devedores').update({ valor_total: 0, valor_emprestado: 0, status: 'QUITADO', pago: true }).eq('id', id);
                await supabase.from('parcelas').update({ status: 'PAGA' }).eq('devedor_id', id).in('status', ['PENDENTE', 'ATRASADO', 'PARCIAL']);
                await supabase.from('logs').insert([{ evento: 'Quitação Total', detalhes: 'Contrato quitado via desconto manual.', devedor_id: parseInt(id) }]);
            }

            // Se não houve reparcelamento, distribui o ajuste nas parcelas pendentes
            // para evitar que a reconciliação da próxima baixa reverta o desconto/acréscimo.
            if (!novasParcs) {
                const { data: parcsPendentes } = await supabase.from('parcelas')
                    .select('id, valor_atual, valor_pago')
                    .eq('devedor_id', id)
                    .in('status', ['PENDENTE', 'PARCIAL'])
                    .order('numero_parcela', { ascending: false });

                if (parcsPendentes && parcsPendentes.length > 0) {
                    let restante = ajuste;
                    for (const p of parcsPendentes) {
                        if (restante === 0) break;
                        const vAtual  = Math.round((parseFloat(p.valor_atual) || 0) * 100) / 100;
                        const vPago   = Math.round((parseFloat(p.valor_pago)  || 0) * 100) / 100;
                        const novoVal = Math.max(vPago, Math.round((vAtual + restante) * 100) / 100);
                        const aplicado = Math.round((novoVal - vAtual) * 100) / 100;
                        restante = Math.round((restante - aplicado) * 100) / 100;
                        await supabase.from('parcelas').update({ valor_atual: novoVal }).eq('id', p.id);
                    }
                }
            }
        }

        if (novaTaxaPct !== null && !isNaN(novaTaxaPct) && novaTaxaPct > 0) {
            await supabase.from('devedores').update({ taxa_juros: novaTaxaPct }).eq('id', id);
        }

        if (novasParcs !== null && !isNaN(novasParcs) && novasParcs > 0) {
            const { data: devRec } = await supabase.from('devedores').select('valor_total, frequencia, data_vencimento').eq('id', id).single();
            const saldoRec   = Math.round((parseFloat(devRec?.valor_total) || 0) * 100) / 100;
            // Prioridade: data definida pelo admin > próxima parcela aberta > vencimento atual do contrato
            const proxVencRec = novoVencimento || proximoVencimentoReal || devRec?.data_vencimento;
            if (saldoRec > 0.10 && proxVencRec) {
                await supabase.from('parcelas').update({ status: 'CANCELADA' })
                    .eq('devedor_id', id).in('status', ['PENDENTE', 'ATRASADO', 'PARCIAL']);
                await gerarParcelasComPersonalizacao(parseInt(id), saldoRec, novasParcs, proxVencRec, devRec?.frequencia || 'MENSAL');
                // Atualiza vencimento e status do contrato para refletir o reparcelamento
                const dtProxRec = new Date(proxVencRec + 'T00:00:00-03:00');
                const novoStatusRec = dtProxRec > hojeCheck ? 'ABERTO' : 'ATRASADO';
                const updateRec = { qtd_parcelas: novasParcs, data_vencimento: proxVencRec, status: novoStatusRec };
                if (novoStatusRec === 'ABERTO') updateRec.ultima_cobranca_atraso = null;
                await supabase.from('devedores').update(updateRec).eq('id', id);
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        invalidarCacheFluxo(); // atualiza caixa no próximo request do dashboard
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message || "Erro interno ao processar baixa." }); }
    finally { travasAtivasPainel.delete(lockKeyBaixa); }
});

app.post('/api/estornar-pagamento', async (req, res) => {
    try {
        const { logId } = req.body;
        const { data: logOriginal, error: errLog } = await supabase.from('logs').select('*').eq('id', logId).single();
        if (errLog || !logOriginal) throw new Error("Registo financeiro não encontrado.");

        const { data: jaEstornado } = await supabase.from('logs').select('id').ilike('detalhes', `%Ref. Log #${logId}%`);
        if (jaEstornado && jaEstornado.length > 0) throw new Error("Este pagamento já foi estornado.");

        const valorEstornarBruto = parseFloat(logOriginal.valor_fluxo);
        if (valorEstornarBruto <= 0) throw new Error("Apenas recebimentos podem ser estornados.");

        // Determina o status correto após estorno com base no vencimento real do contrato
        const { data: devEstorno } = await supabase.from('devedores').select('data_vencimento').eq('id', logOriginal.devedor_id).single();
        const hojeEstorno = new Date(); hojeEstorno.setHours(0,0,0,0);
        const vencEstorno = devEstorno ? new Date(devEstorno.data_vencimento + 'T00:00:00-03:00') : null;
        const statusAposEstorno = (vencEstorno && vencEstorno < hojeEstorno) ? 'ATRASADO' : 'ABERTO';

        const eraAtrasado = logOriginal.evento?.toLowerCase().includes('atraso')
            || logOriginal.detalhes?.includes('[MULTA]');
        const tagMulta = eraAtrasado ? ' [MULTA]' : '';

        // Extrai porção da multa do detalhe para reverter corretamente no DRE
        let multaOriginal = 0;
        if (eraAtrasado) {
            const matchMulta = (logOriginal.detalhes || '').match(/multa[:\s]+R?\$?\s*([\d.]+)/i);
            multaOriginal = matchMulta ? Math.round(parseFloat(matchMulta[1]) * 100) / 100 : 0;
        }

        let numParcela = null;
        const match = logOriginal.detalhes.match(/ref\. parcela (\d+)/i);
        if (match) numParcela = parseInt(match[1]);

        let p_parcela_id = null; let p_parcela_pago_negativo = 0; let p_parcela_status = null;

        if (numParcela) {
            const { data: parc } = await supabase.from('parcelas').select('*').eq('devedor_id', logOriginal.devedor_id).eq('numero_parcela', numParcela).single();
            if (parc) {
                p_parcela_id = parc.id;
                p_parcela_pago_negativo = -Math.abs(valorEstornarBruto); 
                
                const saldoAtualizadoParcela = Math.max(0, parseFloat(parc.valor_pago) + p_parcela_pago_negativo);
                const faltaPagar = parseFloat(parc.valor_atual) - saldoAtualizadoParcela;
                const hoje = new Date(); hoje.setHours(0,0,0,0);
                const dtVenc = new Date(parc.data_vencimento + 'T12:00:00Z');

                if (faltaPagar <= 0.10) p_parcela_status = 'PAGA';
                else if (saldoAtualizadoParcela > 0) p_parcela_status = 'PARCIAL';
                else if (dtVenc < hoje) p_parcela_status = 'ATRASADO';
                else p_parcela_status = 'PENDENTE';
            }
        }

        const detalheEstorno = multaOriginal > 0
            ? `Estorno (Ref. Log #${logId}). Valores devolvidos.${tagMulta} multa: R$ ${multaOriginal.toFixed(2)}`
            : `Estorno (Ref. Log #${logId}). Valores devolvidos.${tagMulta}`;

        const { error: errEstorno } = await supabase.rpc('processar_transacao_financeira', {
            p_devedor_id:      logOriginal.devedor_id,
            p_pago:            -Math.abs(valorEstornarBruto),
            p_novo_total:      0,
            p_capital:         0,
            p_status:          statusAposEstorno,
            p_novo_vencimento: null,
            p_novas_parcelas:  null,
            p_evento:          'Estorno de Pagamento',
            p_detalhes:        detalheEstorno,
            p_valor_capital:   -Math.abs(parseFloat(logOriginal.valor_capital || 0)),
            p_valor_juros:     -Math.abs(parseFloat(logOriginal.valor_juros   || 0)),
            p_limpar_atraso:   false,
            p_transaction_id:  `ESTORNO_${logId}`,  // idempotência: impede estorno duplo
            p_data_pagamento:  null,
            p_parcela_id:      p_parcela_id,
            p_parcela_pago:    p_parcela_pago_negativo,
            p_parcela_status:  p_parcela_status
        });

        if (errEstorno) throw errEstorno;
        invalidarCacheFluxo();
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================

// ==========================================
// REPROVAR DOCUMENTOS + REENVIO
// ==========================================

// Rota: reprovar documentos específicos de uma solicitação e notificar cliente
app.post('/api/reprovar-documentos', async (req, res) => {
    try {
        const { solicitacao_id, docs_reprovados, motivo } = req.body;
        // docs_reprovados: array ex: ['url_selfie', 'url_frente']

        if (!solicitacao_id || !docs_reprovados || docs_reprovados.length === 0) {
            return res.status(400).json({ erro: 'Informe a solicitação e os documentos reprovados.' });
        }

        const { data: sol, error: errSol } = await supabase
            .from('solicitacoes')
            .select('id, nome, cpf, whatsapp, status')
            .eq('id', solicitacao_id)
            .single();

        if (errSol || !sol) return res.status(404).json({ erro: 'Solicitação não encontrada.' });
        if (sol.status !== 'PENDENTE') return res.status(400).json({ erro: 'Só é possível reprovar documentos de solicitações PENDENTES.' });

        // Salva quais docs foram reprovados e o motivo no campo observacoes
        const nomesDocs = {
            url_selfie:    'Selfie',
            url_frente:    'Documento Frente',
            url_verso:     'Documento Verso',
            url_residencia:'Comprovante de Residência',
            url_casa:      'Fachada da Casa',
            url_rg:        'RG (sem CPF)'
        };

        const docsStr = docs_reprovados.map(d => nomesDocs[d] || d).join(', ');
        const obsAtualizada = `[DOCS REPROVADOS: ${docsStr}] ${motivo || ''}`.trim();

        // Zera as URLs dos documentos reprovados na solicitacao
        const clearPayload = {};
        docs_reprovados.forEach(doc => { clearPayload[doc] = null; });
        clearPayload.observacoes = obsAtualizada;

        const { error: upErr } = await supabase
            .from('solicitacoes')
            .update(clearPayload)
            .eq('id', solicitacao_id);

        if (upErr) throw upErr;

        // Monta link de reenvio com os docs reprovados na query string
        const docsQuery = docs_reprovados.join(',');
        const linkReenvio = `${APP_URL}/reenviar-docs.html?cpf=${sol.cpf}&docs=${encodeURIComponent(docsQuery)}&sol=${solicitacao_id}`;

        // Monta mensagem WhatsApp
        const msgDocs = docs_reprovados.map(d => `  • ${nomesDocs[d] || d}`).join('\n');
        const msg = `Olá, *${sol.nome}*! 👋\n\n` +
            `Analisamos sua solicitação de crédito e os seguintes documentos precisam ser reenviados:\n\n` +
            `${msgDocs}\n\n` +
            (motivo ? `📋 *Motivo:* ${motivo}\n\n` : '') +
            `Por favor, acesse o link abaixo e reenvie *apenas* os documentos indicados:\n` +
            `👉 ${linkReenvio}\n\n` +
            `Após o reenvio, daremos continuidade à análise. 🙏`;

        let whatsappEnviado = false;
        try {
            await enviarZap(sol.whatsapp, msg);
            whatsappEnviado = true;
        } catch(e) {
            console.error('[REPROVAR DOCS] Falha WhatsApp:', e.message);
        }

        res.json({ sucesso: true, whatsappEnviado, linkReenvio });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Rota pública: buscar quais docs estão reprovados para um CPF+solicitação
app.get('/api/docs-reprovados/:cpf/:sol_id', async (req, res) => {
    try {
        const { cpf, sol_id } = req.params;
        const cpfLimpo = cpf.replace(/\D/g, '');

        const { data: sol, error } = await supabase
            .from('solicitacoes')
            .select('id, nome, cpf, observacoes, url_selfie, url_frente, url_verso, url_residencia, url_casa, url_rg, status')
            .eq('id', sol_id)
            .eq('cpf', cpfLimpo)
            .single();

        if (error || !sol) return res.status(404).json({ erro: 'Solicitação não encontrada para este CPF.' });

        // Extrai quais docs estão nulos (foram reprovados e zerados)
        const todosDocs = ['url_selfie','url_frente','url_verso','url_residencia','url_casa','url_rg'];
        const docsNulos = todosDocs.filter(d => !sol[d]);

        res.json({
            nome: sol.nome,
            docs_pendentes: docsNulos,
            observacoes: sol.observacoes,
            status: sol.status
        });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Rota pública: receber reenvio dos documentos reprovados
app.post('/api/reenviar-documentos', async (req, res) => {
    try {
        const { cpf, sol_id, docs } = req.body;
        // docs: objeto { url_selfie: 'base64...', url_frente: 'base64...' }
        const cpfLimpo = (cpf || '').replace(/\D/g, '');
        if (!cpfLimpo || cpfLimpo.length < 11) return res.status(400).json({ erro: 'CPF inválido.' });
        if (!sol_id || !docs || Object.keys(docs).length === 0) return res.status(400).json({ erro: 'Dados incompletos.' });

        const { data: sol, error } = await supabase
            .from('solicitacoes')
            .select('id, cpf, status')
            .eq('id', sol_id)
            .eq('cpf', cpfLimpo)
            .single();

        if (error || !sol) return res.status(404).json({ erro: 'Solicitação não encontrada.' });
        if (sol.status !== 'PENDENTE') return res.status(400).json({ erro: 'Esta solicitação não está mais pendente.' });

        const ts = Date.now();
        const uploadPayload = {};
        const camposPermitidos = ['url_selfie','url_frente','url_verso','url_residencia','url_casa','url_rg'];
        const nomeArquivo = { url_selfie:'selfie', url_frente:'frente', url_verso:'verso', url_residencia:'res', url_casa:'casa', url_rg:'rg' };

        for (const campo of camposPermitidos) {
            if (docs[campo] && docs[campo].startsWith('data:')) {
                if (docs[campo].length > 15 * 1024 * 1024) return res.status(413).json({ erro: `Imagem ${campo} excede o limite.` });
                uploadPayload[campo] = await fazerUploadNoSupabase(docs[campo], `${cpfLimpo}_${nomeArquivo[campo]}_${ts}.jpg`);
            }
        }

        if (Object.keys(uploadPayload).length === 0) return res.status(400).json({ erro: 'Nenhuma imagem válida enviada.' });

        // Atualiza a observação removendo a marcação de reprovado dos docs reenviados
        const { data: solAtual } = await supabase.from('solicitacoes').select('observacoes').eq('id', sol_id).single();
        let obsLimpa = (solAtual?.observacoes || '');
        // Remove os docs reenviados da lista de reprovados na observação
        Object.keys(uploadPayload).forEach(campo => {
            const nomesDocs = { url_selfie:'Selfie', url_frente:'Documento Frente', url_verso:'Documento Verso', url_residencia:'Comprovante de Residência', url_casa:'Fachada da Casa', url_rg:'RG (sem CPF)' };
            obsLimpa = obsLimpa.replace(nomesDocs[campo] + ', ', '').replace(', ' + nomesDocs[campo], '').replace(nomesDocs[campo], '');
        });
        uploadPayload.observacoes = obsLimpa.trim();

        const { error: upErr } = await supabase.from('solicitacoes').update(uploadPayload).eq('id', sol_id);
        if (upErr) throw upErr;

        res.json({ sucesso: true });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// REENVIAR CONFIRMAÇÃO DE CONTRATAÇÃO
// ==========================================
app.post('/api/reenviar-aceite', async (req, res) => {
    try {
        const { devedor_id } = req.body;
        const { data: dev, error } = await supabase
            .from('devedores')
            .select('uuid, nome, telefone, valor_emprestado, valor_total, qtd_parcelas, frequencia, status')
            .eq('id', devedor_id)
            .single();

        if (error || !dev) return res.status(404).json({ erro: 'Contrato não encontrado.' });
        if (dev.status !== 'APROVADO_AGUARDANDO_ACEITE') {
            return res.status(400).json({ erro: 'Este contrato não está aguardando aceite.' });
        }

        const linkAceite = `${APP_URL}/aceitar.html?id=${dev.uuid}`;
        const valorParcela = dev.qtd_parcelas > 1 ? (dev.valor_total / dev.qtd_parcelas) : dev.valor_total;
        
        await enviarAprovacaoComTermos(
            dev.telefone, dev.nome, dev.valor_emprestado,
            dev.qtd_parcelas, dev.frequencia, valorParcela, linkAceite, false
        );

        await supabase.from('logs').insert([{
            evento: 'Reenvio de Aceite',
            detalhes: `Link de aceite reenviado ao cliente via WhatsApp.`,
            devedor_id: dev.id || devedor_id
        }]);

        res.json({ sucesso: true });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// EDITAR CONTATO DO CLIENTE
// ==========================================
app.post('/api/editar-contato-cliente', async (req, res) => {
    try {
        const { cpf, novo_telefone, referencia1_nome, referencia1_tel } = req.body;
        const cpfLimpo = (cpf || '').replace(/\D/g, '');
        if (!cpfLimpo) return res.status(400).json({ erro: 'CPF inválido.' });

        const payload = {};
        if (novo_telefone) payload.telefone = novo_telefone.replace(/\D/g, '');
        if (referencia1_nome !== undefined) payload.referencia1_nome = referencia1_nome;
        if (referencia1_tel  !== undefined) payload.referencia1_tel  = (referencia1_tel  || '').replace(/\D/g, '');

        if (Object.keys(payload).length === 0) return res.status(400).json({ erro: 'Nenhum campo para atualizar.' });

        // Atualiza em todos os contratos do CPF
        const { error } = await supabase.from('devedores').update(payload).eq('cpf', cpfLimpo);
        if (error) throw error;

        await supabase.from('logs').insert([{
            evento: 'Edição de Contato',
            detalhes: `Contato atualizado para CPF ${cpfLimpo}.${payload.telefone ? ' Novo WhatsApp: ' + payload.telefone : ''}`
        }]);

        res.json({ sucesso: true });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});


// 10. CADASTRO MANUAL E LISTAS
// ==========================================
app.post('/api/cadastrar-cliente-manual', async (req, res) => {
    try {
        const d = req.body;
        const cpfLimpo = (d.cpf || '').replace(/\D/g, '');
        if (!cpfLimpo || cpfLimpo.length < 11) return res.status(400).json({ erro: "CPF inválido ou não informado." });
        const { data: exDevs } = await supabase.from('devedores').select('*').eq('cpf', cpfLimpo).order('created_at', { ascending: false }).limit(1);
        const oldDev = exDevs && exDevs.length > 0 ? exDevs[0] : null;

        const uS = d.img_selfie ? await fazerUploadNoSupabase(d.img_selfie, `${cpfLimpo}_s_${Date.now()}.jpg`) : (oldDev?.url_selfie || null);
        const uF = d.img_frente ? await fazerUploadNoSupabase(d.img_frente, `${cpfLimpo}_f_${Date.now()}.jpg`) : (oldDev?.url_frente || null);
        const uV = d.img_verso ? await fazerUploadNoSupabase(d.img_verso, `${cpfLimpo}_v_${Date.now()}.jpg`) : (oldDev?.url_verso || null);
        const uR = d.img_residencia ? await fazerUploadNoSupabase(d.img_residencia, `${cpfLimpo}_r_${Date.now()}.jpg`) : (oldDev?.url_residencia || null);
        const uC = d.img_casa ? await fazerUploadNoSupabase(d.img_casa, `${cpfLimpo}_c_${Date.now()}.jpg`) : (oldDev?.url_casa || null);
        
        let db = { 
                nome: d.nome, cpf: cpfLimpo, telefone: d.whatsapp, 
                observacoes: d.observacoes ? `[Manual] ${d.observacoes}` : "[Via Cadastro Manual de Balcão]", 
                cobrar_so_em_dinheiro: d.cobrar_so_em_dinheiro || false, isento_multa: d.isento_multa || false,
                url_selfie: uS, url_frente: uF, url_verso: uV, url_residencia: uR, url_casa: uC, indicado_por: d.indicado_por || 'DIRETO'
            };

        if (!d.is_precadastro) {
            db.valor_emprestado = limparMoeda(d.valor_emprestado); 
            db.valor_total = limparMoeda(d.valor_total);
            db.data_vencimento = new Date(d.data_vencimento + 'T12:00:00Z').toISOString().split('T')[0];
            db.frequencia = d.frequencia; db.qtd_parcelas = Math.max(1, parseInt(d.qtd_parcelas) || 1);
            
            let taxaCalc = 30;
            if (db.valor_emprestado > 0) taxaCalc = (((db.valor_total / db.valor_emprestado) - 1) / db.qtd_parcelas) * 100;
            db.taxa_juros = Math.round(taxaCalc * 100) / 100;
            db.status = 'ABERTO'; db.pago = false;
        } else {
            db.status = 'PRE_CADASTRO'; db.pago = true; db.valor_emprestado = 0; db.valor_total = 0;
        }

        let dId;
        if (!d.is_precadastro) {
            const { data: i, error: iErr } = await supabase.from('devedores').insert([db]).select().single();
            if (iErr) throw iErr; dId = i.id;
            
            await gerarParcelasNoBanco(dId, db.valor_total, db.qtd_parcelas, db.data_vencimento, db.frequencia);
            await supabase.from('logs').insert([{ evento: 'Empréstimo Liberado', detalhes: `Lançado Manualmente.`, devedor_id: dId, valor_fluxo: -Math.abs(db.valor_emprestado) }]);
        } else {
            if (oldDev && oldDev.status === 'PRE_CADASTRO') {
                const { data: u, error: uErr } = await supabase.from('devedores').update(db).eq('id', oldDev.id).select().single();
                if (uErr) throw uErr; dId = u.id;
                await supabase.from('logs').insert([{ evento: 'Pré-Cadastro', detalhes: `Ficha de Perfil Atualizada.`, devedor_id: dId }]);
            } else {
                const { data: i, error: iErr } = await supabase.from('devedores').insert([db]).select().single();
                if (iErr) throw iErr; dId = i.id;
                await supabase.from('logs').insert([{ evento: 'Pré-Cadastro', detalhes: `Ficha em Branco Salva.`, devedor_id: dId }]); 
            }
        }
        res.json({ sucesso: true });
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/extrato-caixa', async (req, res) => {
    try { const { data } = await supabase.from('logs').select('*').eq('evento', 'SAÍDA DE CAIXA').order('created_at', { ascending: false }).limit(50); res.json(data || []); } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/saida-caixa', async (req, res) => {
    try { await supabase.from('logs').insert([{ evento: "SAÍDA DE CAIXA", detalhes: req.body.motivo, valor_fluxo: -Math.abs(limparMoeda(req.body.valor)) }]); invalidarCacheFluxo(); res.json({ sucesso: true }); } catch(e) { res.status(500).json({ erro: e.message }); }
});

// REPARO: cria os logs de "Empréstimo Liberado" faltantes para contratos ativos sem lançamento no caixa.
// Seguro: verifica existência antes de inserir, nunca duplica. Usa a data original do contrato.
app.post('/api/admin/reparar-logs-emprestimos', async (req, res) => {
    try {
        const { data: devedores } = await supabase
            .from('devedores')
            .select('id, nome, valor_emprestado, status, created_at')
            .in('status', ['ABERTO', 'ATRASADO', 'QUITADO', 'CALOTE'])
            .gt('valor_emprestado', 0);

        if (!devedores?.length) return res.json({ reparados: 0, detalhes: [] });

        const reparados = [];
        const falhas = [];

        for (const dev of devedores) {
            const { count } = await supabase
                .from('logs')
                .select('id', { count: 'exact', head: true })
                .eq('devedor_id', dev.id)
                .eq('evento', 'Empréstimo Liberado');

            if (count === 0) {
                const { error } = await supabase.from('logs').insert([{
                    evento: 'Empréstimo Liberado',
                    detalhes: `Lançamento reparado — contrato ativo sem log de liberação. Cliente: ${dev.nome}.`,
                    devedor_id: dev.id,
                    valor_fluxo: -Math.abs(dev.valor_emprestado),
                    created_at: dev.created_at,
                }]);
                if (!error) {
                    reparados.push({ nome: dev.nome, valor: dev.valor_emprestado });
                } else {
                    console.error(`[REPAIR] Falha ao criar log para ${dev.nome}:`, error.message);
                    falhas.push({ nome: dev.nome, erro: error.message });
                }
            }
        }

        res.json({ reparados: reparados.length, detalhes: reparados, falhas });
    } catch (err) {
        res.status(500).json({ erro: err.message });
    }
});

app.get('/api/lista-negra', async (req, res) => {
    try {
        const { data: lista } = await supabase.from('lista_negra').select('*').order('created_at', { ascending: false });
        if (!lista || !lista.length) return res.json([]);
        const cpfs = lista.map(l => l.cpf);
        const { data: devedores } = await supabase.from('devedores').select('cpf, nome').in('cpf', cpfs);
        const nomeMap = {};
        (devedores || []).forEach(d => { nomeMap[d.cpf] = d.nome; });
        res.json(lista.map(l => ({ ...l, nome: nomeMap[l.cpf] || null })));
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/lista-negra', async (req, res) => {
    try { await supabase.from('lista_negra').insert([{ cpf: req.body.cpf, motivo: req.body.motivo }]); await supabase.from('logs').insert([{ evento: "Bloqueio na Lista Negra", detalhes: `CPF ${req.body.cpf} embargado.` }]); res.json({ sucesso: true }); } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/lista-negra/:cpf', async (req, res) => {
    try { await supabase.from('lista_negra').delete().eq('cpf', req.params.cpf); res.json({ sucesso: true }); } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/promotores', async (req, res) => {
    try { 
        const { data: devedores } = await supabase.from('devedores').select('indicado_por, valor_emprestado, status').not('indicado_por', 'is', null).neq('indicado_por', 'DIRETO');
        const stats = {};
        (devedores || []).forEach(d => {
            const nomeAvalista = d.indicado_por;
            if (!stats[nomeAvalista]) stats[nomeAvalista] = { nome: nomeAvalista, volume_gerado: 0, contratos_ativos: 0 };
            stats[nomeAvalista].volume_gerado += (parseFloat(d.valor_emprestado) || 0);
            if (d.status === 'ABERTO' || d.status === 'ATRASADO') stats[nomeAvalista].contratos_ativos += 1;
        });
        res.json(Object.values(stats).sort((a, b) => b.volume_gerado - a.volume_gerado)); 
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/cancelar-contrato', async (req, res) => {
    try {
        const { id, motivo } = req.body;
        const { data: dev } = await supabase.from('devedores').select('*').eq('id', id).single();
        if (!dev) return res.status(404).json({ erro: "Contrato não encontrado" });
        if (dev.status === 'QUITADO' || dev.status === 'CANCELADO') return res.status(400).json({ erro: "Status inválido para cancelamento." });

        // CORREÇÃO: valor_fluxo era positivo (Math.abs), inflando o caixa como se fosse receita.
        // Cancelamento não é entrada de caixa — usar 0. O capital perdido aparece no relatório
        // de safras pelo status CANCELADO, não pelo fluxo.
        await supabase.from('logs').insert([{ 
            evento: "Cancelamento de Contrato", 
            detalhes: `Contrato cancelado. Capital: R$ ${parseFloat(dev.valor_emprestado).toFixed(2)}. Motivo: ${motivo}.`,
            valor_fluxo: 0,
            devedor_id: dev.id 
        }]);
        await supabase.from('devedores').update({ status: 'CANCELADO', valor_total: 0, valor_emprestado: 0, pago: true }).eq('id', id);
        await supabase.from('parcelas').update({ status: 'CANCELADA' }).eq('devedor_id', id).in('status', ['PENDENTE', 'ATRASADO']);
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/adicionar-promotor', async (req, res) => {
    try {
        await supabase.from('logs').insert([{ evento: "Novo Parceiro", detalhes: `Promotor ${req.body.nome} (CPF: ${req.body.cpf}) integrado.` }]);
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// GESTÃO DE CADASTROS COM CPF INVÁLIDO
// ==========================================

// Lista devedores com CPF nulo, vazio ou zerado (todos dígitos iguais a 0)
app.get('/api/admin/devedores-cpf-invalido', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('devedores')
            .select('id, nome, cpf, telefone, status, created_at, valor_emprestado, valor_total')
            .not('status', 'eq', 'CANCELADO')
            .or('cpf.is.null,cpf.eq.,cpf.eq.00000000000,cpf.eq.000.000.000-00');

        if (error) throw error;

        // Filtra também CPFs com todos os dígitos zero mas com formatação diferente
        const invalidos = (data || []).filter(d => {
            if (!d.cpf) return true;
            const limpo = d.cpf.replace(/\D/g, '');
            return limpo.length === 0 || /^0+$/.test(limpo);
        });

        res.json(invalidos);
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Cancela (soft-delete) um ou mais devedores com CPF inválido
app.post('/api/admin/cancelar-devedores-cpf-invalido', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ erro: 'Lista de IDs inválida.' });
        }

        // Valida que todos os IDs existem e têm CPF inválido antes de cancelar
        const { data: devedores, error: errBusca } = await supabase
            .from('devedores')
            .select('id, nome, cpf')
            .in('id', ids)
            .not('status', 'eq', 'CANCELADO');

        if (errBusca) throw errBusca;

        const idsValidos = (devedores || [])
            .filter(d => {
                if (!d.cpf) return true;
                const limpo = d.cpf.replace(/\D/g, '');
                return limpo.length === 0 || /^0+$/.test(limpo);
            })
            .map(d => d.id);

        if (idsValidos.length === 0) {
            return res.status(400).json({ erro: 'Nenhum dos IDs informados possui CPF inválido.' });
        }

        // Cancela devedores
        const { error: errDev } = await supabase
            .from('devedores')
            .update({ status: 'CANCELADO', valor_total: 0, valor_emprestado: 0, pago: true })
            .in('id', idsValidos);
        if (errDev) throw errDev;

        // Cancela parcelas pendentes/atrasadas desses devedores
        await supabase
            .from('parcelas')
            .update({ status: 'CANCELADA' })
            .in('devedor_id', idsValidos)
            .in('status', ['PENDENTE', 'ATRASADO']);

        // Log de auditoria
        const nomes = (devedores || []).filter(d => idsValidos.includes(d.id)).map(d => d.nome).join(', ');
        await supabase.from('logs').insert([{
            evento: 'Cancelamento CPF Inválido',
            detalhes: `${idsValidos.length} cadastro(s) cancelado(s) por CPF inválido: ${nomes}`
        }]);

        res.json({ sucesso: true, cancelados: idsValidos.length });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/config', async (req, res) => {
    try { const { data } = await supabase.from('config').select('*'); res.json(data || []); } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/config', async (req, res) => {
    try { for (const c of req.body.configs) { await supabase.from('config').upsert({ chave: c.chave, valor: c.valor }); } res.json({ sucesso: true }); } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/logs-auditoria', async (req, res) => { 
    try { const { data } = await supabase.from('logs').select('*, devedores(nome)').order('created_at', { ascending: false }).limit(300); res.json(data || []); } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// 11b. SIMULADOR DE EMPRÉSTIMO
// ==========================================
app.post('/api/simular-emprestimo', async (req, res) => {
    try {
        const valor      = Math.max(0, limparMoeda(req.body.valor));
        const taxa       = Math.max(0, limparMoeda(req.body.taxa)) / 100;
        const parcelas   = Math.max(1, parseInt(req.body.parcelas) || 1);
        const frequencia = req.body.frequencia || 'MENSAL';

        if (valor <= 0) return res.status(400).json({ erro: "Valor inválido." });
        if (taxa  <= 0) return res.status(400).json({ erro: "Taxa inválida." });

        // Juro simples sobre o prazo total (modelo do sistema)
        const taxaTotal    = taxa * parcelas;
        const totalDevido  = Math.round(valor * (1 + taxaTotal) * 100) / 100;
        const lucro        = Math.round((totalDevido - valor) * 100) / 100;
        const valorParcela = Math.round((totalDevido / parcelas) * 100) / 100;
        const roiPct       = Math.round((lucro / valor) * 10000) / 100;

        const taxaMulta      = await buscarTaxaMultaDiaria();
        const multaDiaria15         = Math.round(valor * taxaMulta * 15 * 100) / 100;
        const totalCom15DiasAtraso  = Math.round((totalDevido + multaDiaria15) * 100) / 100;

        // Vencimento projetado
        const hoje = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
        const dtVenc = new Date(hoje);
        dtVenc.setDate(dtVenc.getDate() + (frequencia === 'SEMANAL' ? 7 : 30));

        res.json({
            capital:                  valor,
            taxa_periodo_pct:         Math.round(taxa * 10000) / 100,
            parcelas,
            frequencia,
            total_devido:             totalDevido,
            valor_parcela:            valorParcela,
            lucro_esperado:           lucro,
            roi_pct:                  roiPct,
            multa_15dias:             multaDiaria15,
            total_com_15dias_atraso:  totalCom15DiasAtraso,
            data_vencimento:          dtVenc.toISOString().split('T')[0],
        });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// 12. RELATÓRIO ANALÍTICO DEFINITIVO
// ==========================================
// ==============================================================================
// 12. RELATÓRIO ANALÍTICO DEFINITIVO (COM DIAGNÓSTICO PROFUNDO)
// ==============================================================================
app.post('/api/relatorio-periodo', async (req, res) => {
    try {
        // 1. Tratamento SUPER seguro de Datas
        let dtInicio = req.body.dataInicio || req.body.inicio;
        let dtFim = req.body.dataFim || req.body.fim;
        
        if (!dtInicio) dtInicio = new Date().toISOString().split('T')[0];
        if (!dtFim) dtFim = new Date().toISOString().split('T')[0];

        const inicio = dtInicio.includes('T') ? dtInicio : `${dtInicio}T00:00:00-03:00`;
        const fim = dtFim.includes('T') ? dtFim : `${dtFim}T23:59:59-03:00`;

        console.log(`[API] A gerar Relatório Analítico: ${inicio} a ${fim}`);

        // Limite explícito de 5000 para evitar o cap silencioso de 1000 do PostgREST.
        const { data: logs, error: errLogs } = await supabase.from('logs')
            .select('id, valor_fluxo, valor_capital, valor_juros, evento, detalhes, created_at, devedor_id, devedores(nome, status)')
            .gte('created_at', inicio)
            .lte('created_at', fim)
            .order('created_at', { ascending: false })
            .limit(5000);

        if (errLogs) {
            console.error("ERRO SUPABASE:", errLogs);
            throw new Error(`Erro do Banco de Dados: ${errLogs.message}`);
        }

        let totalEmprestado = 0, totalRecebido = 0, totalDespesas = 0;
        let jurosMensalidadeFix = 0;  // juros mensais recebidos (receita prevista)
        let jurosAtrasoGerado   = 0;  // multa de atraso RECEBIDA (receita extra)
        let multasAcumuladas    = 0;  // multa GERADA no período mas ainda não paga (v=0)
        let qtdCadastros = 0, qtdQuitados = 0;

        // ── CONTROLE DE ESTORNOS ─────────────────────────────────────────────
        let qtdEstornos   = 0;
        let totalEstornado = 0;
        const listaEstornos = [];
        // ─────────────────────────────────────────────────────────────────────

        (logs || []).forEach(log => {
            const dev = Array.isArray(log.devedores) ? log.devedores[0] : log.devedores; 
            if (dev && dev.status === 'CANCELADO') return;

            const v         = Number(log.valor_fluxo) || 0;
            const jurosOrig = Number(log.valor_juros)  || 0;
            const capOrig   = Number(log.valor_capital) || 0;
            const ev  = log.evento   || "";
            const det = log.detalhes || "";

            // ── Multa GERADA (robô diário) — v=0, ainda não paga ──────────────
            if (ev === 'Juros de Atraso' && v === 0) {
                multasAcumuladas += jurosOrig;
                return;
            }

            // ── Quitação Total — v=0 mas precisa ser contada ──────────────────
            if (ev === 'Quitação Total') {
                qtdQuitados++;
                return;
            }

            // ── Estornos ─────────────────────────────────────────────────────
            if (ev.includes('Estorno')) {
                totalRecebido += v; // v negativo — abate do totalRecebido
                // Estorno de multa: reverte jurosAtraso; estorno de mensalidade: reverte mensalidade
                if (det.includes('[MULTA]') || ev.includes('Atraso')) {
                    jurosAtrasoGerado   += jurosOrig; // jurosOrig negativo → reduz
                } else {
                    jurosMensalidadeFix += jurosOrig;
                }
                qtdEstornos++;
                totalEstornado += Math.abs(v);
                listaEstornos.push({
                    log_id:            log.id,
                    data:              log.created_at,
                    cliente:           dev?.nome || 'Desconhecido',
                    valor:             Math.abs(v),
                    capital_revertido: Math.abs(capOrig),
                    juros_revertido:   Math.abs(jurosOrig),
                    detalhes:          det,
                    tipo_multa:        det.includes('[MULTA]'),
                });
                return;
            }

            // ── Empréstimos liberados / saídas ────────────────────────────────
            if (ev === 'Empréstimo Liberado' || (ev.includes('Ajuste') && v < 0)) {
                totalEmprestado += Math.abs(v);
                if (ev === 'Empréstimo Liberado') qtdCadastros++;
                return;
            }
            // Redução de capital via edição: reverte parte do emprestado, não é receita
            if (ev === 'Ajuste de Capital' && v > 0) {
                totalEmprestado = Math.max(0, totalEmprestado - v);
                return;
            }
            if (ev === 'SAÍDA DE CAIXA') {
                totalDespesas += Math.abs(v);
                return;
            }

            // ── Recebimentos positivos ────────────────────────────────────────
            if (v > 0) {
                totalRecebido += v;

                // EXTRAÇÃO DA MULTA PAGA:
                // Estratégia de extração em cascata (da mais confiável para a menos):
                //   1ª prioridade — regex nos detalhes ("+ multa: R$ XX") — formato atual
                //   2ª prioridade — regex alternativo ("multa: R$ XX") — formatos legados
                //   3ª prioridade — nenhuma multa encontrada → 0
                // Se detectado como pagamento com atraso mas regex falhar, usa valor_juros
                // do log menos o juros de mensalidade para não subestimar multasAcumuladas.
                let multaPaga = 0;
                if (ev === 'Pagamento com Atraso' || det.includes('[MULTA]')) {
                    // Tenta regex principal: "+ multa: R$ XX.XX" ou "multa: R$ XX"
                    const mPrincipal = det.match(/\+\s*multa:\s*R?\$?\s*([\d,.]+)/i)
                                    || det.match(/multa[:\s]+R?\$?\s*([\d,.]+)/i);
                    if (mPrincipal) {
                        const raw = mPrincipal[1].replace(',', '.');
                        multaPaga = Math.round(parseFloat(raw) * 100) / 100;
                    } else if (jurosOrig > 0 && capOrig > 0) {
                        // Fallback: usa o valor_juros do log como proxy da multa
                        // (valor_juros = mensalidade + multa; capOrig = amortização de capital)
                        // Mensalidade mínima esperada = v - capOrig (receita sem multa)
                        // Excedente acima da mensalidade pura = estimativa da multa
                        // Conservador: só marca multa se o log declara evento de atraso
                        multaPaga = 0; // não arrisca estimativa — mantém 0 se regex não achou
                    }
                }

                const mensalPago = Math.max(0, Math.round((v - capOrig - multaPaga) * 100) / 100);

                jurosAtrasoGerado   += multaPaga;
                jurosMensalidadeFix += mensalPago;
                multasAcumuladas = Math.max(0, multasAcumuladas - multaPaga);
            }
        });

        const lucroLiquidoReal = jurosMensalidadeFix + jurosAtrasoGerado - totalDespesas;

        // Inadimplência real no relatório: mesmo cálculo do dashboard
        // valor_original + capital × taxa × dias — não usa valor_atual defasado
        let valorTotalAtrasadoReal = 0;
        try {
            const hojeRelStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
            const taxaRel    = await buscarTaxaMultaDiaria();
            const hojeRelObj = new Date(); hojeRelObj.setHours(0,0,0,0);
            const { data: parcGargalo } = await supabase
                .from('vw_cobranca_ativa_parcelas')
                .select('valor_original, valor_pago, valor_emprestado, vencimento_parcela, devedor_id')
                .lt('vencimento_parcela', hojeRelStr);

            const multaContadaRel = new Set();
            (parcGargalo || []).forEach(p => {
                const valOrig  = parseFloat(p.valor_original || 0);
                const jaPago   = parseFloat(p.valor_pago    || 0);
                const capital  = parseFloat(p.valor_emprestado || 0);
                const dtVc     = new Date(p.vencimento_parcela + 'T00:00:00-03:00');
                const diasAtr  = dtVc < hojeRelObj ? Math.max(0, Math.floor((hojeRelObj - dtVc) / (1000*60*60*24))) : 0;
                let multa = 0;
                if (diasAtr > 0 && !multaContadaRel.has(p.devedor_id)) {
                    multa = Math.round(capital * taxaRel * diasAtr * 100) / 100;
                    multaContadaRel.add(p.devedor_id);
                }
                valorTotalAtrasadoReal += Math.max(0, valOrig - jaPago + multa);
            });
            valorTotalAtrasadoReal = Math.round(valorTotalAtrasadoReal * 100) / 100;
        } catch(e) {}

        let totalGarantias = 0;
        try {
            const { data: garantias } = await supabase.from('garantias').select('valor_estimado').eq('status', 'ATIVO');
            totalGarantias = (garantias || []).reduce((acc, g) => acc + (parseFloat(g.valor_estimado) || 0), 0);
        } catch(e) {}

        const movFormatadas = (logs || []).filter(log => {
            const dev = Array.isArray(log.devedores) ? log.devedores[0] : log.devedores;
            return !(dev && dev.status === 'CANCELADO');
        }).slice(0, 1500).map(m => ({
            ...m,
            devedores:  Array.isArray(m.devedores) ? m.devedores[0] : m.devedores,
            // Flag para o frontend destacar linhas de estorno em vermelho / ícone de alerta
            is_estorno: (m.evento || '').includes('Estorno'),
        }));

        // Avisa o frontend se o resultado foi truncado pelo limite de 5000 registros.
        const truncado = (logs || []).length >= 5000;

        res.json({
            totalEmprestado,
            totalRecebido,
            totalDespesas,
            lucro:              lucroLiquidoReal,
            jurosAtrasoGerado,
            jurosMensalidade:   jurosMensalidadeFix,
            multasAcumuladas:   Math.round(multasAcumuladas * 100) / 100,
            qtdCadastros,
            qtdQuitados,
            totalGarantias,
            valor_inadimplencia: valorTotalAtrasadoReal,
            truncado,            // true = período tem mais de 5000 registros (use período menor)
            estornos: {
                quantidade:      qtdEstornos,
                total_revertido: Math.round(totalEstornado * 100) / 100,
                lista:           listaEstornos,
            },
            movimentacoes: movFormatadas,
        });

    } catch (e) {
        console.error("[CRÍTICO] Falha geral no relatorio-periodo:", e.message);
        res.status(500).json({ erro: "Erro interno ao gerar relatório. Tente novamente.", movimentacoes: [] });
    }
});

// ==========================================
// 13. ROBÔS AUTOMÁTICOS (CRONS E FORÇA BRUTA)
// ==========================================
let cronCobrancaRodando = false;
const rodarRoboCobranca = async () => {
    if (cronCobrancaRodando) return { status: 'Já em execução' };
    cronCobrancaRodando = true;

    const hoje     = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const hojeDate = new Date(hoje + 'T00:00:00-03:00');

    try {
        // ── PASSO 1: MARCAR ABERTO → ATRASADO ────────────────────────────────
        // Contratos ABERTOS com vencimento no passado precisam ser marcados como
        // ATRASADO antes de qualquer coisa — senão o cron nunca os processa e
        // a multa nunca é aplicada. Esta é a causa do "valor não atualizado".
        const { data: vencidos } = await supabase
            .from('devedores')
            .select('id, data_vencimento')
            .eq('status', 'ABERTO')
            .lt('data_vencimento', hoje);

        if (vencidos?.length > 0) {
            const idsVencidos = vencidos.map(d => d.id);
            await supabase
                .from('devedores')
                .update({ status: 'ATRASADO' })
                .in('id', idsVencidos);

            // Marca também as parcelas correspondentes como ATRASADO
            await supabase
                .from('parcelas')
                .update({ status: 'ATRASADO' })
                .in('devedor_id', idsVencidos)
                .eq('status', 'PENDENTE')
                .lt('data_vencimento', hoje);

            console.log(`[ROBÔ] ${idsVencidos.length} contrato(s) marcado(s) ABERTO → ATRASADO`);
        }
        // ─────────────────────────────────────────────────────────────────────

        // Busca a taxa UMA VEZ antes do loop (evita N queries idênticas ao banco)
        const taxaRobo = await buscarTaxaMultaDiaria();

        // ── PASSO 2: BUSCAR TODOS OS ATRASADOS (incluindo os recém-marcados) ─
        const { data: devedores, error } = await supabase
            .from('devedores')
            .select('*')
            .eq('status', 'ATRASADO')
            .or(`ultima_cobranca_atraso.lt.${hoje},ultima_cobranca_atraso.is.null`);
        if (error) throw error;

        const { data: confPix } = await supabase.from('config').select('valor').eq('chave', 'pix_avancado').maybeSingle();

        // Processa em lotes de 10 em paralelo (idempotência garante segurança)
        const LOTE = 10;
        for (let i = 0; i < (devedores || []).length; i += LOTE) {
            await Promise.all(devedores.slice(i, i + LOTE).map(async (dev) => {
                try {
                    // 1. Aplica multa diária sobre o capital (passa taxaRobo para evitar N queries)
                    if (financeService?.aplicarMultaDiaria) {
                        await financeService.aplicarMultaDiaria(dev, hoje, taxaRobo);
                    }

                    // 2. Calcula dias em atraso a partir do vencimento original
                    const dtVenc   = new Date(dev.data_vencimento + 'T00:00:00-03:00');
                    const diasAtraso = Math.max(1, Math.floor((hojeDate - dtVenc) / (1000 * 60 * 60 * 24)));

                    // 3. Busca saldo e parcelas atrasadas para montar o valor correto da mensagem
                    const { data: devAtualizado } = await supabase
                        .from('devedores')
                        .select('valor_total, valor_emprestado, ultima_cobranca_atraso, isento_multa, status, data_vencimento')
                        .eq('id', dev.id).single();

                    // Guarda de segurança: o contrato pode ter sido pago enquanto o robô
                    // processava o lote (race condition). Se status mudou para ABERTO/QUITADO,
                    // não enviar cobrança.
                    if (!devAtualizado || devAtualizado.status !== 'ATRASADO') return;

                    const saldoTotalAtual = parseFloat(devAtualizado?.valor_total   || dev.valor_total);
                    const capitalBase     = parseFloat(devAtualizado?.valor_emprestado || dev.valor_emprestado);

                    // Multa total acumulada: capital × taxa × dias totais em atraso
                    // Zerada para clientes isentos de multa
                    const dtVencRobo = new Date((devAtualizado?.data_vencimento || dev.data_vencimento) + 'T00:00:00-03:00');
                    const diasTotaisAtraso = Math.max(1, Math.floor((hojeDate - dtVencRobo) / (1000 * 60 * 60 * 24)));
                    const isento = devAtualizado?.isento_multa || dev.isento_multa || false;
                    const multaTotalAcum = (!isento && diasTotaisAtraso > 0)
                        ? Math.round(capitalBase * taxaRobo * diasTotaisAtraso * 100) / 100
                        : 0;

                    // VALOR DA MENSAGEM:
                    // Parcelado → soma só as parcelas vencidas + multa total sobre o capital
                    // Simples   → saldo total do contrato (já correto)
                    let saldoMensagem = saldoTotalAtual;
                    if (dev.qtd_parcelas > 1) {
                        const { data: parcsVenc } = await supabase
                            .from('parcelas')
                            .select('valor_original, valor_pago')
                            .eq('devedor_id', dev.id)
                            .in('status', ['ATRASADO', 'PENDENTE', 'PARCIAL'])
                            .lte('data_vencimento', hoje);
                        if (parcsVenc?.length > 0) {
                            const saldoVencidas = parcsVenc.reduce((acc, p) =>
                                acc + Math.max(0, parseFloat(p.valor_original) - parseFloat(p.valor_pago || 0)), 0);
                            saldoMensagem = Math.round((saldoVencidas + multaTotalAcum) * 100) / 100;
                        }
                    }

                    // 4. Escolhe chave PIX conforme configuração
                    const pixDados = escolherPixInteligente(confPix?.valor, saldoMensagem);

                    // 5. Dispara a mensagem escalonada com o valor correto
                    if (!dev.cobrar_so_em_dinheiro || diasAtraso >= 25) {
                        await enviarReguaCobranca(
                            dev.telefone, dev.nome,
                            saldoMensagem, capitalBase,
                            diasAtraso,
                            dev.cobrar_so_em_dinheiro ? null : pixDados,
                            dev.referencia1_nome || null,
                            multaTotalAcum,
                            dev.data_vencimento
                        );
                    }

                    // Anti-ban: pequena pausa após cada envio individual não é possível em paralelo,
                    // mas o lote de 10 já espaça naturalmente. Se quiser pausa, use série.
                } catch (errDev) {
                    console.error(`[ROBÔ] Erro no devedor ${dev.id}:`, errDev.message);
                }
            }));

            // Pausa entre lotes para não sobrecarregar Z-API (10 mensagens de golpe)
            if (i + LOTE < (devedores || []).length) await sleep(3500);
        }

        console.log(`[ROBÔ] Multas + régua processadas em ${hoje}. Total: ${devedores?.length || 0}`);
        return { status: 'Multas e Cobranças Processadas', total: devedores?.length || 0 };
    } catch (err) {
        console.error("Erro no robô de multas:", err.message);
        return { erro: err.message };
    } finally { cronCobrancaRodando = false; }
};

let cronLembretesRodando = false;
const rodarRoboLembretes = async () => {
    if (cronLembretesRodando) return { status: 'Já em execução' };
    cronLembretesRodando = true;
    const relatorioEnvio = [];
    
    try {
        const hoje = new Date(); const amanha = new Date(); amanha.setDate(amanha.getDate() + 1);
        const strHoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(hoje);
        const strAmanha = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(amanha);

        const { data: parcelas } = await supabase.from('vw_cobranca_ativa_parcelas').select('*').in('vencimento_parcela', [strHoje, strAmanha]);

        for (const parc of (parcelas || [])) {
            const valorAEnviar = (parseFloat(parc.valor_atual) - parseFloat(parc.valor_pago || 0)).toFixed(2);
            const textoContexto = parc.vencimento_parcela === strAmanha ? `Sua parcela vence amanhã!` : `Sua parcela vence *hoje*!`;

            const sucesso = await enviarLembreteVencimento(parc.telefone, parc.nome, valorAEnviar, parc.vencimento_parcela, null, textoContexto);
            if (sucesso) relatorioEnvio.push(parc.nome);
            await sleep(3500); // Pausa anti-ban do WhatsApp
        }
        
        console.log(`[ROBÔ] ${relatorioEnvio.length} Lembretes enviados com sucesso.`);
        return { status: 'Lembretes Processados', total: relatorioEnvio.length };
    } catch (errGeral) { 
        console.error("Erro no robô de lembretes:", errGeral.message);
        return { erro: errGeral.message }; 
    } finally { cronLembretesRodando = false; }
};

/**
 * RESUMO DIÁRIO PARA O ADMIN — roda às 07:00
 * Agrega dados do dashboard e envia briefing matinal via WhatsApp.
 */
const rodarResumoDiarioAdmin = async () => {
    const adminNum = process.env.ADMIN_WHATSAPP;
    if (!adminNum) return { erro: 'ADMIN_WHATSAPP não configurado no .env' };

    try {
        const hojeStr   = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
        const amanhaObj = new Date(); amanhaObj.setDate(amanhaObj.getDate() + 1);
        const amanhaStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(amanhaObj);

        // Ontem (para recebido ontem)
        const ontemObj = new Date(); ontemObj.setDate(ontemObj.getDate() - 1);
        const ontemStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(ontemObj);

        const [solPend, parcHoje, parcAmanha, atrasados, logsOntem, configs] = await Promise.all([
            supabase.from('solicitacoes').select('id', { count: 'exact', head: true }).eq('status', 'PENDENTE'),
            supabase.from('vw_cobranca_ativa_parcelas').select('devedor_id', { count: 'exact', head: true }).eq('vencimento_parcela', hojeStr),
            supabase.from('vw_cobranca_ativa_parcelas').select('devedor_id', { count: 'exact', head: true }).eq('vencimento_parcela', amanhaStr),
            supabase.from('devedores').select('valor_total').eq('status', 'ATRASADO'),
            supabase.from('logs').select('valor_fluxo').gte('created_at', ontemStr + 'T00:00:00-03:00').lte('created_at', ontemStr + 'T23:59:59-03:00').gt('valor_fluxo', 0),
            supabase.from('config').select('*'),
        ]);

        let caixaGeral = 0;
        configs.data?.forEach(c => { if (c.chave === 'caixa_total') caixaGeral = parseFloat(c.valor) || 0; });

        const recebidoOntem  = (logsOntem.data || []).reduce((s, l) => s + (parseFloat(l.valor_fluxo) || 0), 0);
        const valorAtrasado  = (atrasados.data || []).reduce((s, d) => s + (parseFloat(d.valor_total) || 0), 0);
        // Caixa real = capital inicial + soma de todos os fluxos — usa cache de 30s
        const fluxoLiquidoTotal = await buscarFluxoLiquidoCaixa();
        const caixaDisponivel = Math.round((caixaGeral + fluxoLiquidoTotal) * 100) / 100;

        await enviarResumoDiarioAdmin(adminNum, {
            vencenteHoje:          parcHoje.count || 0,
            vencenteAmanha:        parcAmanha.count || 0,
            atrasados:             atrasados.data?.length || 0,
            valorAtrasado,
            solicitacoesPendentes: solPend.count || 0,
            recebidoOntem,
            caixaDisponivel,
        });

        console.log('[RESUMO ADMIN] Briefing enviado com sucesso.');
        return { status: 'Resumo Enviado' };
    } catch (err) {
        console.error('[RESUMO ADMIN] Erro:', err.message);
        return { erro: err.message };
    }
};

// ==========================================
// 14. INICIALIZAÇÃO E ESCUTA
// ==========================================
cron.schedule('0 7 * * *',    rodarResumoDiarioAdmin, { scheduled: true, timezone: "America/Sao_Paulo" });
cron.schedule('0 8,14 * * *', rodarRoboCobranca,      { scheduled: true, timezone: "America/Sao_Paulo" });
cron.schedule('0 9 * * *',    rodarRoboLembretes,     { scheduled: true, timezone: "America/Sao_Paulo" });

// Rotas de acionamento manual dos robôs — protegidas pelo authMiddleware (login do admin)
// CRON_SECRET removido: o login já garante que só o admin acessa.
app.get('/api/forcar-robo',         async (req, res) => res.json(await rodarRoboCobranca()      || { status: "OK" }));
app.get('/api/forcar-lembretes',    async (req, res) => res.json(await rodarRoboLembretes()     || { status: "OK" }));
app.get('/api/forcar-resumo-admin', async (req, res) => res.json(await rodarResumoDiarioAdmin() || { status: "OK" }));

// ==========================================
// REVERTER MULTAS INDEVIDAS (CLIENTES ISENTOS)
// ==========================================
app.post('/api/reverter-multas-isentos', async (req, res) => {
    try {
        // Busca todos os devedores isentos de multa com contratos ativos
        const { data: isentos, error: errIsentos } = await supabase
            .from('devedores')
            .select('id, nome, cpf, valor_total, valor_emprestado, qtd_parcelas, data_vencimento')
            .eq('isento_multa', true)
            .neq('status', 'QUITADO');

        if (errIsentos) throw errIsentos;
        if (!isentos || isentos.length === 0) {
            return res.json({ sucesso: true, revertidos: 0, mensagem: 'Nenhum cliente isento com contrato ativo.' });
        }

        let totalRevertidos = 0;
        const relatorio = [];

        for (const dev of isentos) {
            // Busca logs de multa aplicados a este devedor
            const { data: logsMulta } = await supabase
                .from('logs')
                .select('id, valor_juros')
                .eq('devedor_id', dev.id)
                .eq('evento', 'Juros de Atraso')
                .ilike('detalhes', '%[MULTA]%');

            if (!logsMulta || logsMulta.length === 0) continue;

            // Verifica quais logs já foram estornados anteriormente
            const { data: estornosExistentes } = await supabase
                .from('logs')
                .select('detalhes')
                .eq('devedor_id', dev.id)
                .eq('evento', 'Estorno de Multa (Isento)');

            const idsJaEstornados = new Set();
            (estornosExistentes || []).forEach(l => {
                const matches = [...(l.detalhes || '').matchAll(/Log #(\d+)/g)];
                matches.forEach(m => idsJaEstornados.add(parseInt(m[1])));
            });

            const logsPendentes = logsMulta.filter(l => !idsJaEstornados.has(l.id));
            if (logsPendentes.length === 0) continue;

            const multaTotal = Math.round(
                logsPendentes.reduce((acc, l) => acc + (parseFloat(l.valor_juros) || 0), 0) * 100
            ) / 100;
            if (multaTotal <= 0) continue;

            const totalAtual  = Math.round(parseFloat(dev.valor_total    || 0) * 100) / 100;
            const capitalAtual = Math.round(parseFloat(dev.valor_emprestado || 0) * 100) / 100;
            const novoTotal   = Math.max(0, Math.round((totalAtual - multaTotal) * 100) / 100);
            const idsStr      = logsPendentes.map(l => `Log #${l.id}`).join(', ');

            // Atualiza o saldo do devedor
            const { error: errUpd } = await supabase
                .from('devedores')
                .update({ valor_total: novoTotal })
                .eq('id', dev.id);

            if (errUpd) {
                console.error(`[ESTORNO MULTA ISENTO] Devedor ${dev.id} (${dev.nome}): ${errUpd.message}`);
                continue;
            }

            // Registra o estorno no extrato
            await supabase.from('logs').insert([{
                devedor_id:    dev.id,
                evento:        'Estorno de Multa (Isento)',
                detalhes:      `Revertido R$ ${multaTotal.toFixed(2)} em multas indevidas. Cliente isento de multa. ${idsStr}.`,
                valor_fluxo:   0,
                valor_capital: 0,
                valor_juros:   -multaTotal
            }]);

            // Ajusta a parcela em aberto
            const { data: parcAtual } = await supabase
                .from('parcelas')
                .select('id, valor_atual')
                .eq('devedor_id', dev.id)
                .in('status', ['PENDENTE', 'ATRASADO', 'PARCIAL'])
                .order('numero_parcela', { ascending: true })
                .limit(1)
                .maybeSingle();

            if (parcAtual) {
                const novoValorParcela = Math.max(0, Math.round((parseFloat(parcAtual.valor_atual) - multaTotal) * 100) / 100);
                await supabase.from('parcelas').update({ valor_atual: novoValorParcela }).eq('id', parcAtual.id);
            }

            totalRevertidos++;
            relatorio.push({ nome: dev.nome, cpf: dev.cpf, multaRevertida: multaTotal });
        }

        res.json({
            sucesso: true,
            revertidos: totalRevertidos,
            relatorio,
            mensagem: totalRevertidos === 0
                ? 'Nenhuma multa pendente encontrada para clientes isentos.'
                : `${totalRevertidos} cliente(s) tiveram multas revertidas com sucesso.`
        });
    } catch(e) {
        console.error('[REVERTER MULTAS ISENTOS]', e.message);
        res.status(500).json({ erro: e.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Plataforma CMS Ventures operando na porta ${PORT}`));