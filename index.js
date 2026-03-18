require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

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
    enviarResumoDiarioAdmin,
    enviarAprovacaoComTermos 
} = require('./services/zapService');
const financeService = require('./services/financeService');
const { fazerUploadNoSupabase } = require('./services/uploadService');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`;

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
    const valorPorParcela = valorTotal / qtdParcelas;
    const insertData = [];
    let dt = new Date(dataVencimento + 'T12:00:00Z');

    for (let i = 0; i < qtdParcelas; i++) {
        insertData.push({
            devedor_id: devedorId,
            numero_parcela: i + 1,
            valor_original: valorPorParcela,
            valor_atual: valorPorParcela,
            data_vencimento: dt.toISOString().split('T')[0],
            status: 'PENDENTE'
        });
        
        if (frequencia === 'SEMANAL') {
            dt.setDate(dt.getDate() + 7);
        } else {
            // CORREÇÃO: setMonth() estoura em dias 29/30/31 (ex: 31/jan + 1 mês = 03/mar).
            const diaOriginal = dt.getDate();
            dt.setMonth(dt.getMonth() + 1);
            if (dt.getDate() !== diaOriginal) dt.setDate(0); // recua para último dia do mês
        }
    }
    
    const { error } = await supabase.from('parcelas').insert(insertData);
    if (error) console.error("Erro crítico ao gerar parcelas no banco:", error);
}

const formatarContratoCarne = (dev) => {
    const totalAtual = parseFloat(dev.valor_total) || 0;
    const jaPago = parseFloat(dev.total_ja_pego) || 0;
    const capital = parseFloat(dev.valor_emprestado) || 0;
    const taxa = (parseFloat(dev.taxa_juros) || 0) / 100;
    const qtdDB = parseInt(dev.qtd_parcelas) || 1;
    
    if (qtdDB > 1 || jaPago > 0) {
        const globalOriginalComMultas = totalAtual + jaPago;
        let originalQtd = qtdDB;
        let parcela = globalOriginalComMultas / qtdDB; 

        if (capital > 0 && taxa > 0) {
            const calculatedQtd = Math.round((globalOriginalComMultas / capital - 1) / taxa);
            if (calculatedQtd > 0 && calculatedQtd >= qtdDB) {
                originalQtd = calculatedQtd;
                if (originalQtd < 1) originalQtd = 1; // CORREÇÃO: proteger antes de dividir
                parcela = (capital * (1 + (taxa * originalQtd))) / originalQtd;
            } else {
                if (originalQtd < 1) originalQtd = 1; // CORREÇÃO: proteger antes de dividir
                parcela = globalOriginalComMultas / originalQtd;
            }
        } else {
            const parcelaH1 = totalAtual / qtdDB;
            const isPerfect = (val, div) => div > 0 && Math.abs((val / div) - Math.round(val / div)) < 0.02;
            
            if (isPerfect(globalOriginalComMultas, parcelaH1)) {
                originalQtd = Math.round(globalOriginalComMultas / parcelaH1);
                parcela = parcelaH1;
            } else {
                if (originalQtd < 1) originalQtd = 1; // CORREÇÃO: proteger antes de dividir
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
// 1. SISTEMA DE AUTENTICAÇÃO E SESSÕES
// ==========================================
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
        res.json({ token: data.session.access_token, email: data.user?.email });
    } catch (err) { res.status(500).json({ erro: 'Erro interno de autenticação.' }); }
});

const authMiddleware = async (req, res, next) => {
    const rotasPublicas = [
        '/api/login',
        // '/upload-foto' removido: rota nunca definida no servidor — era dead code na lista pública.
        // '/enviar-solicitacao' removido: a rota real é /api/enviar-solicitacao (abaixo).
        '/api/enviar-solicitacao',
        '/validar-extrato', 
        '/cliente-aceitou', 
        '/cliente-gerar-pagamento', 
        '/status-zapi', 
        '/api/config-publica', 
        '/favicon.ico'
    ];
    if (rotasPublicas.includes(req.path) || req.path.startsWith('/api/buscar-cliente-publico')) return next();
    
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
app.get('/status-zapi', async (req, res) => { try { const status = await verificarStatusZapi(); res.json(status); } catch(e) { res.json({ connected: false }); } });
app.get('/api/config-publica', async (req, res) => { try { const { data } = await supabase.from('config').select('*').in('chave', ['valor_minimo', 'juros_unico', 'juros_parcelado', 'pix_avancado']); res.json(data || []); } catch(e) { res.json([]); } });

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

        const { data: bl } = await supabase.from('lista_negra').select('cpf').eq('cpf', d.cpf).single();
        if (bl) return res.status(403).json({ erro: "CPF bloqueado pelo sistema." });

        const { data: solPendente } = await supabase.from('solicitacoes').select('id').eq('cpf', d.cpf).eq('status', 'PENDENTE').maybeSingle();
        if (solPendente) return res.status(429).json({ erro: "Você já possui uma solicitação em análise." });

        tentativasSolicitacao.set(ip, reqCount + 1);
        setTimeout(() => tentativasSolicitacao.delete(ip), 60 * 60 * 1000);

        const ts = Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        let oldFrente = null, oldVerso = null, oldCasa = null;

        if (d.is_recorrente) {
            const { data: dev } = await supabase.from('devedores').select('url_frente, url_verso, url_casa').eq('cpf', d.cpf).limit(1);
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
        
        enviarZap(process.env.ADMIN_WHATSAPP, `🚀 CMS Ventures - Nova Solicitação:\n👤 ${d.nome}\n💰 R$ ${d.valor}`).catch(e => {});
        res.status(200).json({ mensagem: "Solicitação recebida com sucesso!" });
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==========================================
// 3. FLUXO DO CLIENTE E CONTRATO
// ==========================================
app.post('/validar-extrato', async (req, res) => { 
    try { 
        // CORREÇÃO: select(*) foi substituído por campos específicos — rota pública não deve
        // expor CPF, telefone, URLs de documentos e referências pessoais.
        const camposPublicos = 'id, uuid, nome, valor_emprestado, valor_total, qtd_parcelas, frequencia, data_vencimento, status, taxa_juros, total_ja_pego, cobrar_so_em_dinheiro';
        let query = supabase.from('devedores').select(camposPublicos).eq('uuid', req.body.id);
        if (req.body.cpf) query = query.eq('cpf', req.body.cpf.replace(/\D/g, '')); 
        
        const { data: dev, error } = await query.single();
        if (error || !dev) return res.status(404).json({ erro: "Extrato não encontrado." }); 
        
        const devFormatado = formatarContratoCarne(dev);
        res.json(devFormatado); 
    } catch(e) { res.status(500).json({ erro: e.message }); } 
});

app.post('/cliente-aceitou', async (req, res) => { 
    try { 
        const { data: dev } = await supabase.from('devedores').select('*').eq('uuid', req.body.id).single();
        if (!dev) return res.status(404).json({ erro: "Contrato não encontrado." });
        
        // CORREÇÃO: a lógica anterior aceitava contratos ABERTO/ATRASADO como "já assinados",
        // o que permitia qualquer UUID ativo passar sem validação.
        // Agora apenas contratos em APROVADO_AGUARDANDO_ACEITE podem ser assinados.
        if (dev.status === 'ABERTO' || dev.status === 'ATRASADO') {
            return res.status(400).json({ erro: "Este contrato já se encontra ativo no sistema." });
        }
        if (dev.status !== 'APROVADO_AGUARDANDO_ACEITE') {
            return res.status(400).json({ erro: "Este contrato não está disponível para assinatura." });
        }
        
        await supabase.from('devedores').update({ status: 'ABERTO' }).eq('id', dev.id);
        await supabase.from('solicitacoes').update({ status: 'ASSINADO' }).eq('cpf', dev.cpf).eq('status', 'APROVADO_CP');
        await supabase.from('logs').insert([{ evento: "Assinatura Digital", detalhes: `Contrato ativado. Vencimento: ${dev.data_vencimento}.`, devedor_id: dev.id }]); 
        res.json({ status: 'Assinado' }); 
    } catch(e) { res.status(500).json({ erro: e.message }); } 
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
        const { data: devedores } = await supabase.from('devedores').select('nome, valor_total, qtd_parcelas, data_vencimento, status').in('status', ['ABERTO']).gte('data_vencimento', dataApoio.toISOString().split('T')[0]);
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
        
        const { data: parcelasVencidas } = await supabase
            .from('vw_cobranca_ativa_parcelas')
            .select('valor_atual, valor_pago')
            .lt('vencimento_parcela', hojeStr);

        let valorInadimplenciaReal = 0;
        parcelasVencidas?.forEach(p => valorInadimplenciaReal += (parseFloat(p.valor_atual) - parseFloat(p.valor_pago || 0)));

        res.json({ 
            totalAReceber: resumoSeguro.totalAReceber || 0, 
            recebidoHoje: resumoSeguro.recebidoHoje || 0, 
            pendencias: resumoSeguro.pendencias || 0, 
            lucroEstimado: (parseFloat(resumoSeguro.totalAReceber) || 0) - (parseFloat(resumoSeguro.capitalNaRua) || 0), 
            capitalNaRua: resumoSeguro.capitalNaRua || 0,
            // CAIXA REAL:
            // caixa_total (config) = saldo no momento zero (antes de qualquer operação).
            // fluxoLiquidoTotal    = SUM(valor_fluxo) de todos os logs:
            //   + pagamentos recebidos  (positivo)
            //   - empréstimos liberados (negativo)
            //   - saídas de caixa      (negativo — baixadas manualmente pelo admin)
            // Resultado: saldo real atual do caixa.
            caixaDisponivel: caixaGeral + (parseFloat(resumoSeguro.fluxoLiquidoTotal) || 0),
            caixaConfigurado, // false = admin ainda não definiu o saldo inicial em config
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

app.post('/api/aprovar-solicitacao', async (req, res) => {
    const { id, juros, observacao, novoValor, novaFreq, novasParcelas, cobrarSoEmDinheiro, isContraProposta, isentoMulta } = req.body;
    
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
        
        const momentBRT = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        momentBRT.setDate(momentBRT.getDate() + (freqFinal === 'SEMANAL' ? 7 : 30));
        const dtVencimentoProjetado = momentBRT.toISOString().split('T')[0];
        
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

        await gerarParcelasNoBanco(devId, valorTotal, parcelasFinais, dtVencimentoProjetado, freqFinal);
        await supabase.from('solicitacoes').update({ status: 'APROVADO_CP', observacoes: observacao }).eq('id', id);
        await supabase.from('logs').insert([{ evento: 'Empréstimo Liberado', detalhes: `Aprovado R$ ${valorFinal.toFixed(2)}.`, devedor_id: devId, valor_fluxo: -Math.abs(valorFinal) }]);

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
        const { data: sol } = await supabase.from('solicitacoes').select('status').eq('id', req.body.id).single();
        if (sol && sol.status === 'ASSINADO') return res.status(400).json({ erro: "Cliente já assinou este contrato."});
        await supabase.from('solicitacoes').update({ status: 'REJEITADO', observacoes: req.body.motivo }).eq('id', req.body.id);
        await supabase.from('logs').insert([{ evento: "Solicitação Rejeitada", detalhes: `Motivo: ${req.body.motivo}` }]);
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
        res.json(data);
    } catch (error) { res.status(500).json({ erro: "Erro ao buscar parcelas de cobrança." }); }
});

app.get('/api/clientes-lista', async (req, res) => {
    try {
        let todos = []; let buscar = true; let ptr = 0;
        while (buscar) {
            const { data, error } = await supabase.from('devedores').select('cpf, nome, telefone, status').order('nome', { ascending: true }).range(ptr, ptr + 999);
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
        const pixDados = escolherPixInteligente(confPix?.valor, dev.qtd_parcelas > 1 ? (parseFloat(dev.valor_total) / dev.qtd_parcelas) : parseFloat(dev.valor_total));

        const nomeCurto = dev.nome.split(' ')[0];
        const valorFormatado = Number(dev.qtd_parcelas > 1 ? (parseFloat(dev.valor_total) / dev.qtd_parcelas) : parseFloat(dev.valor_total)).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        
        const dataVenc = new Date(dev.data_vencimento + 'T12:00:00Z');
        const hoje = new Date(); hoje.setHours(0,0,0,0);
        let dtFormatada = dataVenc.toLocaleDateString('pt-BR');
        
        let textoAtraso = "";
        if (dataVenc < hoje) {
             const diasAtraso = Math.floor((hoje - dataVenc) / (1000 * 60 * 60 * 24));
             textoAtraso = `\n⚠️ *Atenção:* O contrato está com ${diasAtraso} dias de atraso.`;
        }

        let msg = '';
        if (dev.cobrar_so_em_dinheiro) {
            msg = `Olá ${nomeCurto},\n\nAviso da *CMS Ventures* sobre a sua fatura de *${valorFormatado}* (Vencimento: ${dtFormatada}).${textoAtraso}\n\nConforme acordado, este contrato deve ser pago em *dinheiro físico*.\n\n`;
        } else {
            msg = `Olá ${nomeCurto},\n\nAviso da *CMS Ventures* sobre a sua fatura de *${valorFormatado}* (Vencimento: ${dtFormatada}).${textoAtraso}\n\n`;
            if (pixDados && pixDados.chave) {
                msg += `🏦 *DADOS PIX*\nFavorecido: ${pixDados.nome}\nInstituição: ${pixDados.banco}\nChave:\n${pixDados.chave}\n\n⚠️ _Envie o comprovante por aqui._\n\n`;
            } else { msg += `Para realizar o acerto, por favor, entre em contato.\n\n`; }
        }
        msg += `🤖 _Mensagem automática. Dúvidas? Responda aqui!_`;
        
        await enviarZap(dev.telefone, msg);
        await supabase.from('logs').insert([{ evento: "Envio Manual de Cobrança", detalhes: `Cobrança enviada via WhatsApp.`, devedor_id: dev.id }]);
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
        const { data: tds } = await supabase.from('devedores').select('*').eq('cpf', clientePrincipal.cpf).order('created_at', { ascending: false });
        
        const tdsValidos = (tds || cls).filter(c => c.status !== 'CANCELADO');
        let scoreCalculado = 500; 

        const tdsComParcelas = tdsValidos.map(dev => {
            dev = formatarContratoCarne(dev);
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

        // CORREÇÃO: select explícito com 'data_promessa' causava 500 porque a coluna
        // não existe na view vw_cobranca_ativa_parcelas (apenas em devedores).
        // Usamos select('*') para buscar tudo que a view expõe sem quebrar.
        // A view foi atualizada no SQL para incluir d.data_promessa e d.referencia1_nome.
        const { data, error } = await supabase
            .from('vw_cobranca_ativa_parcelas')
            .select('*')
            .lt('vencimento_parcela', hojeStr)
            .order('vencimento_parcela', { ascending: true });

        if (error) throw error;
        const formatados = (data || []).map(d => ({
            ...d,
            id:          d.devedor_id,
            valor_total: parseFloat(d.valor_atual) - parseFloat(d.valor_pago || 0)
        }));
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

        await supabase.from('logs').insert([{ evento: "Edição Manual", detalhes: `Novo Vencimento: ${novoVencimento}. Saldo Restante: R$ ${limparMoeda(novoTotal)}`, devedor_id: id }]);
        res.json({ sucesso: true });
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
            if ((l.evento.includes('Rolagem') || l.evento.includes('Pagamento') || l.evento.includes('Liquidação') || l.evento.includes('Recebimento')) && l.valor_fluxo > 0) {
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
    try {
        const { id, parcelaId, valorPago, formaPagamento, observacoes, dataRecebimento, novoVencimento } = req.body;
        if (!parcelaId) throw new Error("ID da parcela não foi enviado.");

        const { data: parc } = await supabase.from('parcelas').select('*').eq('id', parcelaId).single();
        const { data: dev } = await supabase.from('devedores').select('*').eq('id', id).single();
        if (!parc || !dev) throw new Error("Dados não encontrados no banco.");

        const valPago     = Math.round((parseFloat(valorPago) || 0) * 100) / 100;
        const totalAtual  = Math.round((parseFloat(dev.valor_total)    || 0) * 100) / 100;
        const capitalAtual = Math.round((parseFloat(dev.valor_emprestado) || 0) * 100) / 100;

        // DRE: proporcionar capital e juros pelo ratio do contrato, arredondado para evitar float drift
        const ratioCapital    = totalAtual > 0 ? (capitalAtual / totalAtual) : 0;
        const amortizaCapital = Math.round(valPago * ratioCapital * 100) / 100;
        const amortizaJuros   = Math.round((valPago - amortizaCapital) * 100) / 100;

        const novoValorTotal      = Math.max(0, Math.round((totalAtual  - valPago)        * 100) / 100);
        const novoValorEmprestado = Math.max(0, Math.round((capitalAtual - amortizaCapital) * 100) / 100);

        // PAGAMENTO PARCIAL:
        // O campo valor_pago na tabela parcelas é acumulativo (SQL faz `valor_pago + p_parcela_pago`).
        // Isso permite que o cliente pague R$100 hoje e R$100 amanhã na mesma parcela.
        // faltaPagarNaParcela já desconta o que foi pago antes — a lógica abaixo é sempre sobre o saldo restante.
        const faltaPagarNaParcela = Math.round((parseFloat(parc.valor_atual) - parseFloat(parc.valor_pago || 0)) * 100) / 100;
        // CORREÇÃO: threshold nunca pode ser negativo (ex: restam R$0,05, threshold = -0,05
        // aceitaria qualquer pagamento como quitação). Math.max garante mínimo de R$0,01.
        const novoStatusParcela = (valPago >= Math.max(0.01, faltaPagarNaParcela - 0.10)) ? 'PAGA' : 'PARCIAL';

        let dataVencGlobal  = novoVencimento ? novoVencimento : dev.data_vencimento;
        const dataEnvioFinal = dataRecebimento
            ? (dataRecebimento.includes('T') ? dataRecebimento : `${dataRecebimento}T12:00:00-03:00`)
            : new Date().toISOString();

        const { error } = await supabase.rpc('processar_transacao_financeira', {
            p_devedor_id: parseInt(id), p_pago: valPago, p_novo_total: novoValorTotal, p_capital: novoValorEmprestado, 
            p_status: null, p_novo_vencimento: dataVencGlobal, p_novas_parcelas: dev.qtd_parcelas, p_limpar_atraso: false,
            p_evento: 'Pagamento de Parcela',
            p_detalhes: `[${formaPagamento}] Recebido R$ ${valPago.toFixed(2)} ref. parcela ${parc.numero_parcela}. ${observacoes ? 'OBS: ' + observacoes : ''}`,
            p_data_pagamento: dataEnvioFinal, p_valor_capital: amortizaCapital, p_valor_juros: amortizaJuros,
            p_parcela_id: parseInt(parcelaId), p_parcela_pago: valPago, p_parcela_status: novoStatusParcela
        });
        if (error) throw error;
        
        const { data: parcAbertas } = await supabase.from('parcelas').select('valor_atual, valor_pago').eq('devedor_id', id).neq('status', 'CANCELADA');
        let saldoAtualizado = 0;
        parcAbertas?.forEach(p => saldoAtualizado += (parseFloat(p.valor_atual) - parseFloat(p.valor_pago || 0)));
        
        if (saldoAtualizado <= 0.10) {
            await supabase.from('devedores').update({ valor_total: 0, valor_emprestado: 0, status: 'QUITADO', pago: true }).eq('id', id);
            await supabase.from('logs').insert([{ evento: 'Quitação Total', detalhes: 'Contrato liquidado com sucesso.', devedor_id: id }]);
        }

        // Confirmação de pagamento para o cliente via WhatsApp (não bloqueia a resposta)
        const novoSaldoFinal = saldoAtualizado <= 0.10 ? 0 : Math.round(saldoAtualizado * 100) / 100;
        enviarConfirmacaoBaixa(
            dev.telefone, dev.nome,
            valPago,
            novoSaldoFinal,
            novoSaldoFinal > 0 ? dataVencGlobal : null,
            formaPagamento || 'PIX'
        ).catch(e => console.warn('[CONFIRM BAIXA] Falha ao enviar WhatsApp:', e.message));

        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message || "Erro interno ao processar baixa." }); }
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

        const tinhaMulta = logOriginal.detalhes.toLowerCase().includes('multa') || logOriginal.evento.toLowerCase().includes('atraso');
        const tagMulta = tinhaMulta ? ' [MULTA]' : '';

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

        const { error: errEstorno } = await supabase.rpc('processar_transacao_financeira', {
            p_devedor_id: logOriginal.devedor_id, p_pago: -Math.abs(valorEstornarBruto), p_novo_total: 0, p_capital: 0,
            p_status: 'ABERTO', p_evento: 'Estorno de Pagamento', p_detalhes: `Estorno (Ref. Log #${logId}). Valores devolvidos.${tagMulta}`,
            p_valor_capital: -Math.abs(parseFloat(logOriginal.valor_capital || 0)), p_valor_juros: -Math.abs(parseFloat(logOriginal.valor_juros || 0)),
            p_limpar_atraso: false, p_parcela_id: p_parcela_id, p_parcela_pago: p_parcela_pago_negativo, p_parcela_status: p_parcela_status
        });

        if (errEstorno) throw errEstorno;
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
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
    try { await supabase.from('logs').insert([{ evento: "SAÍDA DE CAIXA", detalhes: req.body.motivo, valor_fluxo: -Math.abs(limparMoeda(req.body.valor)) }]); res.json({ sucesso: true }); } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/lista-negra', async (req, res) => {
    try { const { data } = await supabase.from('lista_negra').select('*').order('created_at', { ascending: false }); res.json(data || []); } catch(e) { res.status(500).json({ erro: e.message }); }
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
    try { await supabase.from('promotores').insert([{ nome: req.body.nome, cpf: req.body.cpf }]); await supabase.from('logs').insert([{ evento: "Novo Parceiro", detalhes: `Promotor ${req.body.nome} integrado.` }]); res.json({ sucesso: true }); } catch (e) { res.status(500).json({ erro: e.message }); }
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

        // Projeção de risco: multa se ficar 15 dias atrasado (1%/dia sobre capital)
        const multaDiaria15         = Math.round(valor * 0.01 * 15 * 100) / 100;
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

        const { data: logs, error: errLogs } = await supabase.from('logs')
            .select('id, valor_fluxo, valor_capital, valor_juros, evento, detalhes, created_at, devedor_id, devedores(nome, status)')
            .gte('created_at', inicio)
            .lte('created_at', fim)
            .order('created_at', { ascending: false });

        if (errLogs) {
            console.error("ERRO SUPABASE:", errLogs);
            throw new Error(`Erro do Banco de Dados: ${errLogs.message}`);
        }

        let totalEmprestado = 0, totalRecebido = 0, totalDespesas = 0;
        let jurosAtrasoGerado = 0, jurosMensalidadeFix = 0;
        let qtdCadastros = 0, qtdQuitados = 0;

        // ── CONTROLE DE ESTORNOS ─────────────────────────────────────────────
        // Cada estorno é rastreado individualmente para aparecer em destaque
        // no relatório — evita que o admin passe batido achando que não foi estornado.
        let qtdEstornos   = 0;
        let totalEstornado = 0; // valor absoluto total revertido no período
        const listaEstornos = []; // detalhes de cada estorno para o frontend destacar
        // ─────────────────────────────────────────────────────────────────────

        (logs || []).forEach(log => {
            const dev = Array.isArray(log.devedores) ? log.devedores[0] : log.devedores; 
            if (dev && dev.status === 'CANCELADO') return;

            const v           = Number(log.valor_fluxo) || 0;
            const jurosOrig   = Number(log.valor_juros)  || 0;
            const capitalOrig = Number(log.valor_capital) || 0;
            const ev  = log.evento  || "";
            const det = log.detalhes || "";

            if (ev.includes('Estorno')) {
                // v é negativo — abate corretamente o totalRecebido no DRE
                totalRecebido += v;
                if (det.includes('[MULTA]')) jurosAtrasoGerado += jurosOrig;
                else jurosMensalidadeFix += jurosOrig;

                // Registro individual do estorno para destaque no frontend
                qtdEstornos++;
                totalEstornado += Math.abs(v);
                listaEstornos.push({
                    log_id:      log.id,
                    data:        log.created_at,
                    cliente:     dev?.nome || 'Desconhecido',
                    valor:       Math.abs(v),
                    capital_revertido: Math.abs(capitalOrig),
                    juros_revertido:   Math.abs(jurosOrig),
                    detalhes:    det,
                    tipo_multa:  det.includes('[MULTA]'),
                });
            }
            else if (ev === 'Empréstimo Liberado' || (ev.includes('Ajuste') && v < 0)) {
                totalEmprestado += Math.abs(v);
                if (ev === 'Empréstimo Liberado') qtdCadastros++;
            }
            else if (ev === 'SAÍDA DE CAIXA') {
                totalDespesas += Math.abs(v);
            }
            else if (v > 0) {
                totalRecebido += v;
                if (ev.includes('Atraso') || det.includes('Multa') || det.includes('Atraso')) {
                    jurosAtrasoGerado += jurosOrig;
                } else {
                    jurosMensalidadeFix += jurosOrig;
                }
                if (ev === 'Quitação Total') qtdQuitados++;
            }
        });

        const lucroLiquidoReal = jurosMensalidadeFix + jurosAtrasoGerado - totalDespesas;

        let valorTotalAtrasadoReal = 0;
        try {
            const hojeStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
            const { data: parcGargalo } = await supabase.from('vw_cobranca_ativa_parcelas').select('valor_atual, valor_pago').lt('vencimento_parcela', hojeStr);
            parcGargalo?.forEach(p => valorTotalAtrasadoReal += (parseFloat(p.valor_atual) - parseFloat(p.valor_pago || 0)));
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

        res.json({
            totalEmprestado,
            // totalRecebido já é líquido: entradas brutas menos estornos
            totalRecebido,
            totalDespesas,
            lucro:              lucroLiquidoReal,
            jurosAtrasoGerado,
            jurosMensalidade:   jurosMensalidadeFix,
            qtdCadastros,
            qtdQuitados,
            totalGarantias,
            valor_inadimplencia: valorTotalAtrasadoReal,
            // ── RESUMO DE ESTORNOS ──────────────────────────────────────────
            // Permite ao frontend mostrar um aviso em destaque quando existirem
            // estornos no período — ex: "⚠️ 2 estornos (R$600 devolvidos)"
            estornos: {
                quantidade:     qtdEstornos,
                total_revertido: Math.round(totalEstornado * 100) / 100,
                lista:          listaEstornos,    // detalhe de cada estorno
            },
            // ────────────────────────────────────────────────────────────────
            movimentacoes: movFormatadas,
        });

    } catch (e) {
        console.error("[CRÍTICO] Falha geral no relatorio-periodo:", e.message);
        // Agora, o erro volta para o Chrome para você ver o que é!
        res.status(500).json({ erro: "Erro interno: " + e.message, movimentacoes: [] });
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
                    // 1. Aplica multa diária sobre o capital
                    if (financeService?.aplicarMultaDiaria) {
                        await financeService.aplicarMultaDiaria(dev, hoje);
                    }

                    // 2. Calcula dias em atraso a partir do vencimento original
                    const dtVenc   = new Date(dev.data_vencimento + 'T00:00:00-03:00');
                    const diasAtraso = Math.max(1, Math.floor((hojeDate - dtVenc) / (1000 * 60 * 60 * 24)));

                    // 3. Busca saldo atualizado (após multa recém aplicada) para mostrar na mensagem
                    const { data: devAtualizado } = await supabase
                        .from('devedores').select('valor_total, valor_emprestado').eq('id', dev.id).single();
                    const saldoAtual   = parseFloat(devAtualizado?.valor_total   || dev.valor_total);
                    const capitalBase  = parseFloat(devAtualizado?.valor_emprestado || dev.valor_emprestado);

                    // 4. Escolhe chave PIX conforme configuração
                    const valorParaPix = dev.qtd_parcelas > 1
                        ? saldoAtual / dev.qtd_parcelas
                        : saldoAtual;
                    const pixDados = escolherPixInteligente(confPix?.valor, valorParaPix);

                    // 5. Dispara a mensagem escalonada
                    if (!dev.cobrar_so_em_dinheiro || diasAtraso >= 25) {
                        await enviarReguaCobranca(
                            dev.telefone, dev.nome,
                            saldoAtual, capitalBase,
                            diasAtraso,
                            dev.cobrar_so_em_dinheiro ? null : pixDados,
                            dev.referencia1_nome || null
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

        const [resumoDB, solPend, parcHoje, parcAmanha, atrasados, logsOntem, configs] = await Promise.all([
            supabase.rpc('obter_resumo_dashboard', { p_inicio: null, p_fim: null }),
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
        const resumo         = resumoDB.data || {};
        const caixaDisponivel = caixaGeral + (parseFloat(resumo.fluxoLiquidoTotal) || 0);

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

// Rotas de cron protegidas por CRON_SECRET
const verificarCronSecret = (req, res, next) => {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers['x-cron-secret'] !== secret) {
        return res.status(403).json({ erro: "Acesso negado ao endpoint de cron." });
    }
    next();
};
app.get('/api/forcar-robo',         verificarCronSecret, async (req, res) => res.json(await rodarRoboCobranca()      || { status: "OK" }));
app.get('/api/forcar-lembretes',    verificarCronSecret, async (req, res) => res.json(await rodarRoboLembretes()     || { status: "OK" }));
app.get('/api/forcar-resumo-admin', verificarCronSecret, async (req, res) => res.json(await rodarResumoDiarioAdmin() || { status: "OK" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Plataforma CMS Ventures operando na porta ${PORT}`));