require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const { supabase } = require('./database');
const { 
    enviarZap, 
    formatarNumero, 
    verificarStatusZapi, 
    enviarLembreteVencimento, 
    enviarAvisoAtraso, 
    enviarAprovacaoComTermos 
} = require('./services/zapService');
const { recalcularDivida } = require('./services/financeService');
const { fazerUploadNoSupabase } = require('./services/uploadService');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); 
app.use(express.urlencoded({ limit: '15mb', extended: true }));
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
// MOTOR DE DECISÃO DE PIX INTELIGENTE
// ==========================================
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
    const rotasPublicas = ['/api/login', '/upload-foto', '/enviar-solicitacao', '/api/enviar-solicitacao', '/validar-extrato', '/cliente-aceitou', '/status-zapi', '/api/config-publica', '/favicon.ico'];
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
// 2. ROTAS PÚBLICAS
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
        for (let img of imagensParaVerificar) { if (img && img.length > 4 * 1024 * 1024) return res.status(413).json({ erro: "Imagem excede o limite de tamanho." }); }

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
        
        enviarZap(process.env.ADMIN_WHATSAPP, `🚀 Nova Solicitação:\n👤 ${d.nome}\n💰 R$ ${d.valor}`).catch(e => {});
        res.status(200).json({ mensagem: "Solicitação recebida com sucesso!" });
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==========================================
// 3. FLUXO DO CLIENTE E CONTRATO
// ==========================================
app.post('/validar-extrato', async (req, res) => { 
    try { 
        let query = supabase.from('devedores').select('*').eq('uuid', req.body.id);
        if (req.body.cpf) query = query.eq('cpf', req.body.cpf.replace(/\D/g, '')); 
        
        const { data: dev, error } = await query.single();
        if (error || !dev) return res.status(404).json({ erro: "Extrato não encontrado." }); 
        
        dev.valor_parcela = (dev.qtd_parcelas > 1) ? (dev.valor_total / dev.qtd_parcelas) : dev.valor_total;
        dev.parcelas_pagas = (dev.qtd_parcelas > 1 && dev.valor_parcela > 0) ? Math.floor((dev.total_ja_pego || 0) / dev.valor_parcela) : ((dev.total_ja_pego >= dev.valor_total) ? 1 : 0);
        res.json(dev); 
    } catch(e) { res.status(500).json({ erro: e.message }); } 
});

app.post('/cliente-aceitou', async (req, res) => { 
    try { 
        const { data: dev } = await supabase.from('devedores').select('*').eq('uuid', req.body.id).single();
        if (!dev) throw new Error("Extrato não encontrado");
        
        if (dev.status === 'ABERTO' || dev.status === 'ATRASADO') return res.json({ status: 'Assinado' });
        
        const momentBRT = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        momentBRT.setDate(momentBRT.getDate() + (dev.frequencia === 'SEMANAL' ? 7 : 30));
        const dataVencimentoReal = momentBRT.toISOString().split('T')[0];

        // MANTEMOS A DATA ORIGINAL GRAVADA NO MOMENTO DA APROVAÇÃO, EM VEZ DE RECALCULAR
        await supabase.from('devedores').update({ status: 'ABERTO' }).eq('id', dev.id);
        await supabase.from('solicitacoes').update({ status: 'ASSINADO' }).eq('cpf', dev.cpf).eq('status', 'APROVADO_CP');
        await supabase.from('logs').insert([{ evento: "Assinatura Digital", detalhes: `Contrato ativado. Vencimento mantido em: ${dev.data_vencimento}.`, devedor_id: dev.id }]); 
        res.json({ status: 'Assinado' }); 
    } catch(e) { res.status(500).json({ erro: e.message }); } 
});

// ==========================================
// 4. MÓDULOS DE PREVISÃO E GARANTIAS
// ==========================================
app.get('/api/previsao-caixa', async (req, res) => {
    try {
        const dataApoio = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        dataApoio.setHours(0,0,0,0);
        
        const { data: devedores } = await supabase.from('devedores')
            .select('nome, valor_total, qtd_parcelas, data_vencimento, status')
            .in('status', ['ABERTO'])
            .gte('data_vencimento', dataApoio.toISOString().split('T')[0]);

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
    try {
        await supabase.from('garantias').update({ status: req.body.status }).eq('id', req.params.id);
        res.json({ sucesso: true });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// 5. ROTAS DE GESTÃO, DASHBOARD E APROVAÇÕES
// ==========================================
app.get(['/api/dashboard', '/api/dashboard-master'], async (req, res) => {
    try {
        const { data: configs } = await supabase.from('config').select('*');
        let caixaGeral = 50000; 
        configs?.forEach(c => { if (c.chave === 'caixa_total') caixaGeral = parseFloat(c.valor) || 0; });

        const p_inicio = req.query.inicio || null;
        const p_fim = req.query.fim || null;

        const { data: dbResumo, error: rpcErr } = await supabase.rpc('obter_resumo_dashboard', { p_inicio: p_inicio, p_fim: p_fim });
        if (rpcErr) throw new Error(rpcErr.message);
        
        const resumoSeguro = dbResumo || {};

        res.json({ 
            totalAReceber: resumoSeguro.totalAReceber || 0, 
            recebidoHoje: resumoSeguro.recebidoHoje || 0, 
            pendencias: resumoSeguro.pendencias || 0, 
            lucroEstimado: (parseFloat(resumoSeguro.totalAReceber) || 0) - (parseFloat(resumoSeguro.capitalNaRua) || 0), 
            capitalNaRua: resumoSeguro.capitalNaRua || 0, 
            caixaDisponivel: caixaGeral + (parseFloat(resumoSeguro.fluxoLiquidoTotal) || 0),
            total_a_receber: resumoSeguro.totalAReceber || 0,
            recebido_hoje: resumoSeguro.recebidoHoje || 0,
            capital_na_rua: resumoSeguro.capitalNaRua || 0,
            caixa_disponivel: caixaGeral + (parseFloat(resumoSeguro.fluxoLiquidoTotal) || 0)
        });
    } catch (err) { 
        res.json({ totalAReceber: 0, recebidoHoje: 0, pendencias: 0, lucroEstimado: 0, capitalNaRua: 0, caixaDisponivel: 0 }); 
    }
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
            cobrar_so_em_dinheiro: cobrarSoEmDinheiro || false,
            isento_multa: isentoMulta || false
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

        await supabase.from('solicitacoes').update({ status: 'APROVADO_CP', observacoes: observacao }).eq('id', id);
        await supabase.from('logs').insert([{ evento: 'Empréstimo Liberado', detalhes: `Aprovado R$ ${valorFinal.toFixed(2)}.`, devedor_id: devId, valor_fluxo: -Math.abs(valorFinal) }]);

        const linkAceite = `${APP_URL}/aceitar.html?id=${devUuid}`;
        try { 
            const valorDaParcela = parcelasFinais > 1 ? (valorTotal / parcelasFinais) : valorTotal;
            await enviarAprovacaoComTermos(payload.telefone, payload.nome, valorFinal, parcelasFinais, freqFinal, valorDaParcela, linkAceite, isContraProposta);
        } catch(e) {}
        
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); } finally { setTimeout(() => travasAtivasPainel.delete(lockKey), 3000); }
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
        let tds = []; let b = true; let p = 0;
        while (b) {
            const { data, error } = await supabase.from('devedores').select('*').in('status', ['ABERTO', 'ATRASADO', 'APROVADO_AGUARDANDO_ACEITE']).order('data_vencimento', { ascending: true }).range(p, p + 999);
            if (error || !data || data.length === 0) break; tds = tds.concat(data); if (data.length < 1000) b = false; p += 1000;
        }
        tds = tds.map(dev => {
            dev.valor_parcela = (dev.qtd_parcelas > 1) ? (dev.valor_total / dev.qtd_parcelas) : dev.valor_total;
            dev.parcelas_pagas = (dev.qtd_parcelas > 1 && dev.valor_parcela > 0) ? Math.floor((dev.total_ja_pego || 0) / dev.valor_parcela) : ((dev.total_ja_pego >= dev.valor_total) ? 1 : 0);
            return dev;
        });
        res.json(tds);
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/enviar-cobranca-manual', async (req, res) => {
    try {
        const { data: dev } = await supabase.from('devedores').select('*').eq('id', req.body.id).single();
        if (!dev) throw new Error("Cliente não encontrado");
        
        const { data: confPix } = await supabase.from('config').select('valor').eq('chave', 'pix_avancado').maybeSingle();
        
        let valorMensalidadeOuTotal = dev.qtd_parcelas > 1 ? (parseFloat(dev.valor_total) / dev.qtd_parcelas) : parseFloat(dev.valor_total);
        const pixDados = escolherPixInteligente(confPix?.valor, valorMensalidadeOuTotal);

        let msg = '';
        const nomeCurto = dev.nome.split(' ')[0];
        const valorFormatado = Number(valorMensalidadeOuTotal).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        
        const dataVenc = new Date(dev.data_vencimento + 'T12:00:00Z');
        const hoje = new Date(); 
        hoje.setHours(0,0,0,0);
        let dtFormatada = dataVenc.toLocaleDateString('pt-BR');
        
        let textoAtraso = "";
        if (dataVenc < hoje) {
             const diasAtraso = Math.floor((hoje - dataVenc) / (1000 * 60 * 60 * 24));
             textoAtraso = `\n⚠️ *Atenção:* Identificámos que o seu contrato está com ${diasAtraso} dias de atraso.`;
        }

        if (dev.cobrar_so_em_dinheiro) {
            msg = `Olá ${nomeCurto},\n\nEste é um aviso da *CMS Ventures* sobre a sua fatura no valor de *${valorFormatado}* (Vencimento: ${dtFormatada}).${textoAtraso}\n\nConforme acordado, este contrato deve ser regularizado em *dinheiro físico*. Por favor, prepare o valor para o nosso cobrador ou entre em contato.`;
        } else {
            msg = `Olá ${nomeCurto},\n\nEste é um aviso da *CMS Ventures* sobre a sua fatura no valor de *${valorFormatado}* (Vencimento: ${dtFormatada}).${textoAtraso}\n\n`;
            
            if (pixDados && pixDados.chave) {
                msg += `🏦 *DADOS PARA PAGAMENTO (PIX)*\n`;
                msg += `Favorecido: ${pixDados.nome}\n`;
                msg += `Instituição: ${pixDados.banco}\n\n`;
                msg += `Copie a chave abaixo e cole no aplicativo do seu banco:\n`;
                msg += `${pixDados.chave}\n\n`;
                msg += `⚠️ _Após o pagamento, envie o comprovante de pagamento por aqui para validarmos a baixa._\n\n`;
            }
        }
        
        await enviarZap(dev.telefone, msg);
        
        await supabase.from('logs').insert([{ 
            evento: "Envio Manual de Cobrança", 
            detalhes: `Cobrança PIX enviada via WhatsApp.`, 
            devedor_id: dev.id 
        }]);
        
        res.json({ sucesso: true });
    } catch (e) { 
        res.status(500).json({ erro: e.message }); 
    }
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
        
        const { data: cls } = await queryMain.order('created_at', { ascending: false });
        if (!cls || cls.length === 0) {
            return res.status(404).json({ erro: "Cliente não encontrado na base de dados." });
        }
        
        const clientePrincipal = cls[0]; 
        const { data: tds } = await supabase.from('devedores').select('*').eq('cpf', clientePrincipal.cpf).order('created_at', { ascending: false });
        
        let scoreCalculado = 500; // Base Score Padrão

        const tdsComParcelas = (tds || cls).map(dev => {
            dev.valor_parcela = (dev.qtd_parcelas > 1) ? (dev.valor_total / dev.qtd_parcelas) : dev.valor_total;
            dev.parcelas_pagas = (dev.qtd_parcelas > 1 && dev.valor_parcela > 0) ? Math.floor((dev.total_ja_pego || 0) / dev.valor_parcela) : ((dev.total_ja_pego >= dev.valor_total) ? 1 : 0);
            
            // Lógica de Recompensa
            if (dev.status === 'QUITADO') {
                scoreCalculado += 150;
            }
            
            // Lógica de Punição
            if (dev.status === 'ATRASADO') {
                const dtVenc = new Date(dev.data_vencimento + 'T12:00:00Z');
                const hj = new Date(); 
                hj.setHours(0,0,0,0);
                
                if (dtVenc < hj) {
                    const diasOff = Math.floor((hj - dtVenc) / (1000 * 60 * 60 * 24));
                    scoreCalculado -= (diasOff * 5); // Perde 5 pontos por cada dia de atraso
                }
            }
            return dev;
        });

        // Limita o Score para não passar dos limites do Serasa
        scoreCalculado = Math.min(1000, Math.max(0, scoreCalculado));

        const idsArray = (tds || []).map(c => c.id);
        const { data: logs } = await supabase.from('logs').select('*').in('devedor_id', idsArray).order('created_at', { ascending: false }).limit(300);
        
        res.json({ 
            cliente: tdsComParcelas[0], 
            todos_contratos: tdsComParcelas, 
            logs: logs || [], 
            score: scoreCalculado 
        });
        
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.get('/api/buscar-cliente-admin/:busca', async (req, res) => {
    try {
        const b = decodeURIComponent(req.params.busca); 
        const hasNum = /\d/.test(b); 
        
        let q = supabase.from('devedores').select('id, nome, cpf, telefone, status');
        if (hasNum) {
            const numL = b.replace(/\D/g, '');
            q = q.or(`cpf.eq.${numL},telefone.ilike.%${numL}%`); 
        } else { 
            q = q.ilike('nome', `%${b}%`); 
        }
        
        const { data: cls } = await q.limit(10);
        
        const uniqueClients = []; 
        const cpfs = new Set();
        
        (cls || []).forEach(c => { 
            if (!cpfs.has(c.cpf)) { 
                cpfs.add(c.cpf); 
                uniqueClients.push(c); 
            } 
        });
        
        res.json(uniqueClients);
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

// ==========================================
// 🚨 FASE 3: CRM KANBAN E ANÁLISE DE SAFRAS
// ==========================================
app.get('/api/crm', async (req, res) => {
    try {
        const { data, error } = await supabase.from('devedores')
            .select('id, uuid, nome, telefone, valor_total, qtd_parcelas, total_ja_pego, data_vencimento, crm_status, cpf, data_promessa')
            .eq('status', 'ATRASADO')
            .order('data_vencimento', { ascending: true });
            
        if (error) throw error;
        res.json(data || []);
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.put('/api/crm/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, data_promessa } = req.body;
        
        let payload = { crm_status: status };
        if (data_promessa) {
            payload.data_promessa = data_promessa;
        }
        
        await supabase.from('devedores').update(payload).eq('id', id);
        
        let detalhesLog = `Etapa da Gestão movida para: ${status}`;
        if (data_promessa) detalhesLog += ` | Prometeu pagar em: ${data_promessa}`;

        await supabase.from('logs').insert([{ 
            evento: "CRM Workflow Atualizado", 
            detalhes: detalhesLog, 
            devedor_id: id 
        }]);
        
        res.json({ sucesso: true });
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.get('/api/safras', async (req, res) => {
    try {
        const { data, error } = await supabase.from('devedores').select('created_at, status, valor_emprestado');
        if (error) throw error;

        const safras = {};
        
        (data || []).forEach(d => {
            const mes = d.created_at.substring(0, 7); 
            
            if (!safras[mes]) {
                safras[mes] = { mes, total_clientes: 0, volume_emprestado: 0, quitados: 0, atrasados: 0, abertos: 0 };
            }
            
            safras[mes].total_clientes++;
            safras[mes].volume_emprestado += parseFloat(d.valor_emprestado) || 0;
            
            if (d.status === 'QUITADO') {
                safras[mes].quitados++;
            } else if (d.status === 'ATRASADO') {
                safras[mes].atrasados++;
            } else {
                safras[mes].abertos++;
            }
        });

        const resultado = Object.values(safras).sort((a, b) => b.mes.localeCompare(a.mes));
        res.json(resultado);
        
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

// ==========================================
// 8. EDIÇÃO E BAIXAS MANUAIS
// ==========================================
app.post('/api/editar-contrato', async (req, res) => {
    try {
        const { id, novoVencimento, novoCapital, novoTotal, novaFrequencia, cobrarSoEmDinheiro, novasParcelas, novaTaxa, isentoMulta } = req.body;
        
        const { data: devAntigo } = await supabase.from('devedores').select('valor_emprestado, status').eq('id', id).maybeSingle();
        if (devAntigo?.status === 'APROVADO_AGUARDANDO_ACEITE') {
            return res.status(400).json({ erro: "Contrato pendente não editável." });
        }

        let payload = { 
            data_vencimento: novoVencimento, 
            valor_emprestado: limparMoeda(novoCapital), 
            valor_total: limparMoeda(novoTotal), 
            frequencia: novaFrequencia, 
            status: 'ABERTO', 
            ultima_cobranca_atraso: null, 
            pago: false, 
            cobrar_so_em_dinheiro: cobrarSoEmDinheiro,
            isento_multa: isentoMulta || false
        };

        if (novasParcelas) payload.qtd_parcelas = parseInt(novasParcelas);
        if (novaTaxa) payload.taxa_juros = limparMoeda(novaTaxa);

        await supabase.from('devedores').update(payload).eq('id', id);
        
        await supabase.from('logs').insert([{ 
            evento: "Edição Manual", 
            detalhes: `Estrutura reajustada. Novo Vencimento: ${novoVencimento}. Saldo Restante: R$ ${limparMoeda(novoTotal)}`, 
            devedor_id: id 
        }]);
        
        res.json({ sucesso: true });
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
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
        if (new Date() > venc) {
            diasAtraso = Math.floor((new Date() - venc) / (1000 * 60 * 60 * 24));
        }
        
        const saldoAtual = parseFloat(dev.valor_total || 0);

        res.json({ 
            data_emprestimo: dev.created_at, 
            capital_original: dev.valor_emprestado, 
            saldo_atual: saldoAtual, 
            dias_atraso: Math.max(0, diasAtraso), 
            total_pago: totalPago 
        });
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.post('/api/baixar-manual', async (req, res) => {
    // 🚨 ATUALIZADO: Recebe a instrução 'recalculoTratamento'
    const { id, valorPago, observacoes, recalculoAjuste, recalculoTaxa, recalculoParcelas, dataRecebimento, formaPagamento, recalculoTratamento } = req.body;
    
    const lockKey = `baixa_${id}`;
    if (travasAtivasPainel.has(lockKey)) {
        return res.status(429).json({ erro: "Aguarde processamento..." });
    }
    travasAtivasPainel.add(lockKey);

    try { 
        let resRecalculo = { sucesso: true, status: 'apenas_ajuste' };
        const vPago = limparMoeda(valorPago); 

        // Invoca o Motor ACID Externo
        if (vPago > 0) {
            resRecalculo = await recalcularDivida(id, vPago, null, dataRecebimento, formaPagamento, recalculoTratamento); 
            if (resRecalculo.erro) throw new Error(resRecalculo.erro);
        }
        
        let atualizacoes = {}; 
        let notas = [];
        
        const { data: dev } = await supabase.from('devedores').select('*').eq('id', id).single();
        
        if (dev && ['ABERTO', 'ATRASADO', 'QUITADO'].includes(dev.status)) {
            let novoTotal = parseFloat(dev.valor_total || 0);
            let parcelasAtuais = dev.qtd_parcelas || 1;
            
            if (recalculoParcelas && parseInt(recalculoParcelas) > 0) { 
                parcelasAtuais = parseInt(recalculoParcelas); 
                atualizacoes.qtd_parcelas = parcelasAtuais; 
                notas.push(`Reestruturado para ${parcelasAtuais} parcelas`); 
            }
            
            if (limparMoeda(recalculoTaxa) > 0) {
                const tDec = limparMoeda(recalculoTaxa) / 100;
                let txApli = parcelasAtuais > 1 ? tDec * parcelasAtuais : tDec;
                novoTotal = parseFloat(dev.valor_emprestado || 0) * (1 + txApli); 
                atualizacoes.taxa_juros = limparMoeda(recalculoTaxa); 
                notas.push(`Taxa Base alterada para ${limparMoeda(recalculoTaxa)}%`);
            }
            
            if (limparMoeda(recalculoAjuste) !== 0) { 
                novoTotal += limparMoeda(recalculoAjuste); 
                notas.push(`Ajuste de Saldo de Gaveta: R$ ${limparMoeda(recalculoAjuste)}`); 
            }
            
            if (observacoes) { 
                atualizacoes.observacoes = (dev.observacoes ? dev.observacoes + " | " : "") + `[${new Date().toLocaleDateString()}] ${observacoes}`; 
            }

            if (novoTotal <= 0.05) { 
                atualizacoes.valor_total = 0; 
                atualizacoes.status = 'QUITADO'; 
                atualizacoes.pago = true; 
            } else { 
                atualizacoes.valor_total = Math.max(0, novoTotal); 
                if (dev.status === 'QUITADO') { 
                    atualizacoes.status = 'ABERTO'; 
                    atualizacoes.pago = false; 
                } 
            }

            if (Object.keys(atualizacoes).length > 0) {
                await supabase.from('devedores').update(atualizacoes).eq('id', id);
            }
            if (notas.length > 0) {
                await supabase.from('logs').insert([{ evento: "Ajuste Manual de Balcão", detalhes: notas.join(' | '), devedor_id: id }]);
            }
        }
        res.json(resRecalculo);
    } catch (e) { 
        res.status(500).json({ erro: e.message }); 
    } finally { 
        travasAtivasPainel.delete(lockKey); 
    }
});

// ==========================================
// 9. CADASTRO MANUAL (Ficha Branca)
// ==========================================
app.post('/api/cadastrar-cliente-manual', async (req, res) => {
    try {
        const d = req.body;
        const cpfLimpo = d.cpf.replace(/\D/g, '');

        const { data: exDevs } = await supabase.from('devedores').select('*').eq('cpf', cpfLimpo).order('created_at', { ascending: false }).limit(1);
        const oldDev = exDevs && exDevs.length > 0 ? exDevs[0] : null;

        const uS = d.img_selfie ? await fazerUploadNoSupabase(d.img_selfie, `${cpfLimpo}_s_${Date.now()}.jpg`) : (oldDev?.url_selfie || null);
        const uF = d.img_frente ? await fazerUploadNoSupabase(d.img_frente, `${cpfLimpo}_f_${Date.now()}.jpg`) : (oldDev?.url_frente || null);
        const uV = d.img_verso ? await fazerUploadNoSupabase(d.img_verso, `${cpfLimpo}_v_${Date.now()}.jpg`) : (oldDev?.url_verso || null);
        const uR = d.img_residencia ? await fazerUploadNoSupabase(d.img_residencia, `${cpfLimpo}_r_${Date.now()}.jpg`) : (oldDev?.url_residencia || null);
        const uC = d.img_casa ? await fazerUploadNoSupabase(d.img_casa, `${cpfLimpo}_c_${Date.now()}.jpg`) : (oldDev?.url_casa || null);
        
        let db = { 
            nome: d.nome, 
            cpf: cpfLimpo, 
            telefone: d.whatsapp, 
            observacoes: d.observacoes ? `[Manual] ${d.observacoes}` : "[Via Cadastro Manual de Balcão]", 
            cobrar_so_em_dinheiro: d.cobrar_so_em_dinheiro || false,
            isento_multa: d.isento_multa || false,
            url_selfie: uS, 
            url_frente: uF, 
            url_verso: uV, 
            url_residencia: uR, 
            url_casa: uC
        };

        if (!d.is_precadastro) {
            db.valor_emprestado = limparMoeda(d.valor_emprestado); 
            db.valor_total = limparMoeda(d.valor_total);
            db.data_vencimento = new Date(d.data_vencimento + 'T12:00:00Z').toISOString().split('T')[0];
            db.frequencia = d.frequencia; 
            db.qtd_parcelas = Math.max(1, parseInt(d.qtd_parcelas) || 1);
            
            const vEmp = db.valor_emprestado; 
            const vTot = db.valor_total; 
            let taxaCalc = 30;
            
            if (vEmp > 0) {
                taxaCalc = (((vTot / vEmp) - 1) / db.qtd_parcelas) * 100;
            }
            
            db.taxa_juros = Math.round(taxaCalc * 100) / 100;
            db.status = 'ABERTO'; 
            db.pago = false;
        } else {
            db.status = 'PRE_CADASTRO'; 
            db.pago = true; 
            db.valor_emprestado = 0; 
            db.valor_total = 0;
        }

        let dId;
        
        if (!d.is_precadastro) {
            const { data: i, error: iErr } = await supabase.from('devedores').insert([db]).select().single();
            if (iErr) throw iErr;
            dId = i.id;
            await supabase.from('logs').insert([{ 
                evento: 'Empréstimo Liberado', 
                detalhes: `Lançado Manualmente pela Administração.`, 
                devedor_id: dId, 
                valor_fluxo: -Math.abs(db.valor_emprestado) 
            }]);
        } else {
            if (oldDev && oldDev.status === 'PRE_CADASTRO') {
                const { data: u, error: uErr } = await supabase.from('devedores').update(db).eq('id', oldDev.id).select().single();
                if (uErr) throw uErr;
                dId = u.id;
                await supabase.from('logs').insert([{ evento: 'Pré-Cadastro', detalhes: `Ficha de Perfil Atualizada.`, devedor_id: dId }]);
            } else {
                const { data: i, error: iErr } = await supabase.from('devedores').insert([db]).select().single();
                if (iErr) throw iErr;
                dId = i.id;
                await supabase.from('logs').insert([{ evento: 'Pré-Cadastro', detalhes: `Ficha em Branco Salva.`, devedor_id: dId }]); 
            }
        }

        res.json({ sucesso: true });
    } catch (err) { 
        res.status(500).json({ erro: err.message }); 
    }
});

// ==========================================
// 10. LISTA NEGRA, PROMOTORES E CONFIGURAÇÕES
// ==========================================
app.get('/api/extrato-caixa', async (req, res) => {
    try { 
        const { data } = await supabase.from('logs').select('*').eq('evento', 'SAÍDA DE CAIXA').order('created_at', { ascending: false }).limit(50); 
        res.json(data || []); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.post('/api/saida-caixa', async (req, res) => {
    try { 
        await supabase.from('logs').insert([{ 
            evento: "SAÍDA DE CAIXA", 
            detalhes: req.body.motivo, 
            valor_fluxo: -Math.abs(limparMoeda(req.body.valor)) 
        }]); 
        res.json({ sucesso: true }); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.get('/api/lista-negra', async (req, res) => {
    try { 
        const { data } = await supabase.from('lista_negra').select('*').order('created_at', { ascending: false }); 
        res.json(data || []); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.post('/api/lista-negra', async (req, res) => {
    try { 
        await supabase.from('lista_negra').insert([{ cpf: req.body.cpf, motivo: req.body.motivo }]); 
        await supabase.from('logs').insert([{ evento: "Bloqueio na Lista Negra", detalhes: `CPF ${req.body.cpf} embargado por segurança.` }]); 
        res.json({ sucesso: true }); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.delete('/api/lista-negra/:cpf', async (req, res) => {
    try { 
        await supabase.from('lista_negra').delete().eq('cpf', req.params.cpf); 
        res.json({ sucesso: true }); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.get('/api/promotores', async (req, res) => {
    try { 
        const { data: promotores } = await supabase.from('promotores').select('*').order('created_at', { ascending: false }); 
        const { data: devedores } = await supabase.from('devedores').select('indicado_por, valor_emprestado');
        
        const stats = {};
        if (devedores) {
            devedores.forEach(d => {
                const nomeIndicador = d.indicado_por || 'DIRETO';
                stats[nomeIndicador] = (stats[nomeIndicador] || 0) + (parseFloat(d.valor_emprestado) || 0);
            });
        }

        const resultado = (promotores || []).map(p => ({
            ...p,
            volume_gerado: stats[p.nome] || 0
        }));

        res.json(resultado); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.post('/api/adicionar-promotor', async (req, res) => {
    try { 
        await supabase.from('promotores').insert([{ nome: req.body.nome, cpf: req.body.cpf }]); 
        await supabase.from('logs').insert([{ evento: "Novo Parceiro", detalhes: `Promotor ${req.body.nome} integrado à força de vendas.` }]); 
        res.json({ sucesso: true }); 
    } catch (e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.get('/api/config', async (req, res) => {
    try { 
        const { data } = await supabase.from('config').select('*'); 
        res.json(data || []); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.post('/api/config', async (req, res) => {
    try { 
        for (const c of req.body.configs) { 
            await supabase.from('config').upsert({ chave: c.chave, valor: c.valor }); 
        } 
        res.json({ sucesso: true }); 
    } catch (e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.get('/api/logs-auditoria', async (req, res) => { 
    try { 
        const { data } = await supabase.from('logs').select('*, devedores(nome)').order('created_at', { ascending: false }).limit(300); 
        res.json(data || []); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

// ==========================================
// 11. MATEMÁTICA DE LUCRO LÍQUIDO REAL E EXATO
// ==========================================
app.post('/api/relatorio-periodo', async (req, res) => {
    try {
        const dtInicio = req.body.dataInicio || req.body.inicio || new Date().toISOString().split('T')[0];
        const dtFim = req.body.dataFim || req.body.fim || new Date().toISOString().split('T')[0];

        const inicio = dtInicio.includes('T') ? new Date(dtInicio).toISOString() : new Date(`${dtInicio}T00:00:00-03:00`).toISOString(); 
        const fim = dtFim.includes('T') ? new Date(dtFim).toISOString() : new Date(`${dtFim}T23:59:59-03:00`).toISOString();

        let todosLogs = []; 
        let buscar = true; 
        let ptr = 0;
        
        while (buscar) {
            const { data, error } = await supabase.from('logs')
                .select('valor_fluxo, evento, detalhes, created_at, devedor_id, devedores(nome)')
                .gte('created_at', inicio)
                .lte('created_at', fim)
                .order('created_at', { ascending: true })
                .range(ptr, ptr + 999);
                
            if (error || !data || data.length === 0) break;
            
            todosLogs = todosLogs.concat(data); 
            if (data.length < 1000) buscar = false; 
            ptr += 1000;
        }

        let totalEmprestado = 0; 
        let totalRecebido = 0; 
        let totalDespesas = 0; 
        let jurosAtrasoGerado = 0; 
        let qtdCadastros = 0; 
        let qtdQuitados = 0;
        let jurosMensalidadeFix = 0; 
        let movimentacoes = [];

        const devedorIdsPeriodo = [...new Set(todosLogs.filter(l => l.valor_fluxo > 0 && l.devedor_id).map(l => l.devedor_id))];
        let taxasDevedores = {};

        if (devedorIdsPeriodo.length > 0) {
            for (let i = 0; i < devedorIdsPeriodo.length; i += 200) {
                const chunk = devedorIdsPeriodo.slice(i, i + 200);
                const { data: devs } = await supabase.from('devedores').select('id, taxa_juros, qtd_parcelas').in('id', chunk);
                
                if (devs) {
                    devs.forEach(d => { 
                        taxasDevedores[d.id] = { taxa: parseFloat(d.taxa_juros) || 30, parcelas: parseInt(d.qtd_parcelas) || 1 }; 
                    });
                }
            }
        }

        todosLogs.forEach(log => {
            const v = Number(log.valor_fluxo) || 0; 
            const ev = log.evento || "";
            
            if (ev === 'Empréstimo Liberado' || (ev.includes('Ajuste de Capital') && v < 0)) {
                totalEmprestado += Math.abs(v);
                if (ev === 'Empréstimo Liberado') qtdCadastros++;
            }
            else if (ev === 'SAÍDA DE CAIXA') {
                totalDespesas += Math.abs(v);
            }
            else if (v > 0 && !ev.includes('Histórico Antigo')) {
                totalRecebido += v;
                if (ev === 'Quitação Total') qtdQuitados++;
                
                // 🚨 MATEMÁTICA DEFINITIVA DE LUCRO REAL (À PROVA DE ERROS)
                let lucroExtra = 0;
                // 1. Extrai juros extras sem quebrar casas decimais (ex: 200.00 não vira 20000)
                const matchExtra1 = (log.detalhes || "").match(/R\$ ([\d.,]+) convertidos/);
                const matchExtra2 = (log.detalhes || "").match(/Excedente de R\$ ([\d.,]+)/);
                
                if (matchExtra1) lucroExtra = limparMoeda(matchExtra1[1]);
                else if (matchExtra2) lucroExtra = limparMoeda(matchExtra2[1]);

                let basePaid = v - lucroExtra;
                if (basePaid < 0) basePaid = 0;

                let jurosBaseCalculado = 0;

                // 2. Rolagem: O cliente paga os juros vencidos para manter o capital na rua
                if (ev.includes('Rolagem')) {
                    const matchCap = (log.detalhes || "").match(/Cap Reajustado: R\$ ([\d.,]+)/);
                    if (matchCap && log.devedor_id && taxasDevedores[log.devedor_id]) {
                        let cNew = limparMoeda(matchCap[1]);
                        let info = taxasDevedores[log.devedor_id];
                        let R = info.taxa / 100;
                        // Cálculo Algébrico Exato do Juro Pago na Rolagem: J = (CapitalNovo + BasePaga) * Taxa / (1 + Taxa)
                        jurosBaseCalculado = ((cNew + basePaid) * R) / (1 + R);
                    } else {
                        // Fallback seguro: toda a base da rolagem costuma ser juros
                        jurosBaseCalculado = basePaid;
                    }
                } 
                // 3. Pagamentos Proporcionais (Parcela Normal ou Quitação)
                else if (ev.includes('Pagamento') || ev.includes('Recebimento') || ev.includes('Quitação')) {
                    if (log.devedor_id && taxasDevedores[log.devedor_id]) {
                        const info = taxasDevedores[log.devedor_id];
                        let tDec = info.taxa / 100;
                        let taxaAp = info.parcelas > 1 ? tDec * info.parcelas : tDec;
                        // Fórmula Proporcional de Amortização
                        jurosBaseCalculado = basePaid - (basePaid / (1 + taxaAp));
                    }
                }

                // Soma o Juro da Parcela + O Juro Extra Retido
                jurosMensalidadeFix += (lucroExtra + jurosBaseCalculado);
            }
            
            if (ev.includes('Juros de Atraso')) {
                const match = (log.detalhes || "").match(/R\$ ([\d.,]+)/);
                if (match) { 
                    const mVal = limparMoeda(match[1]); 
                    if (!isNaN(mVal)) jurosAtrasoGerado += mVal; 
                }
            }
            
            if (v !== 0 && !ev.includes('Histórico Antigo')) {
                log.devedores = log.devedores || { nome: 'Movimento de Caixa Geral' };
                movimentacoes.push(log);
            }
        });

        movimentacoes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        
        const { data: devedoresAtrasados } = await supabase.from('devedores').select('data_vencimento').eq('status', 'ATRASADO');
        let diasAtrasados = 0; 
        const hojeObj = new Date(); 
        hojeObj.setHours(0,0,0,0);
        
        (devedoresAtrasados || []).forEach(d => {
            const dt = new Date(d.data_vencimento + 'T12:00:00Z');
            if (dt < hojeObj) {
                diasAtrasados += Math.floor((hojeObj - dt) / (1000 * 60 * 60 * 24));
            }
        });

        const lucroLiquidoReal = jurosMensalidadeFix + jurosAtrasoGerado - totalDespesas;
        const { data: garantiasAtivas } = await supabase.from('garantias').select('valor_estimado').eq('status', 'ATIVO');
        const totalGarantias = (garantiasAtivas || []).reduce((acc, g) => acc + (parseFloat(g.valor_estimado) || 0), 0);

        res.json({ 
            totalEmprestado: totalEmprestado, 
            totalRecebido: totalRecebido, 
            totalDespesas: totalDespesas,
            lucro: lucroLiquidoReal, 
            jurosAtrasoGerado: jurosAtrasoGerado, 
            jurosMensalidade: jurosMensalidadeFix,
            qtdCadastros: qtdCadastros, 
            qtdQuitados: qtdQuitados, 
            diasAtrasados: diasAtrasados,
            totalGarantias: totalGarantias,
            movimentacoes: movimentacoes.slice(0, 1500)
        });
        
    } catch (e) { 
        res.json({ totalEmprestado: 0, totalRecebido: 0, totalDespesas: 0, lucro: 0, totalGarantias: 0, movimentacoes: [] }); 
    }
});

// ==========================================
// 🚨 O GRANDE CRON JOB DE AUTOMAÇÃO E COBRANÇA
// ==========================================
cron.schedule('0 * * * *', async () => {
    console.log('[CRON] Iniciando verificação de atrasos e juros...');

    try {
        // 1. Puxa a taxa de juros diária das Configurações do Sistema
        const { data: configMulta } = await supabase
            .from('config')
            .select('valor')
            .eq('chave', 'multa_diaria') // Certifique-se de criar essa chave na tabela 'config'
            .maybeSingle();

        // Se não tiver configurado no painel, o padrão é 2% (2.0)
        let taxaDiariaPercentual = 2.0; 
        if (configMulta && configMulta.valor) {
            taxaDiariaPercentual = parseFloat(configMulta.valor) || 2.0;
        }
        const taxaMultaDec = taxaDiariaPercentual / 100;

        // Pega a data atual no fuso horário do Brasil
        const momentoBRT = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        momentoBRT.setHours(0,0,0,0);
        const dataHojeStr = momentoBRT.toISOString().split('T')[0];

        // 2. Busca configurações de PIX para enviar na mensagem (se usar)
        const { data: configPixData } = await supabase.from('config').select('valor').eq('chave', 'pix_avancado').maybeSingle();
        const configPixString = configPixData ? configPixData.valor : null;

        let runAtraso = true;
        let pA = 0;
        const clientesOff = new Set();

        while (runAtraso) {
            const { data: emAtraso, error } = await supabase
                .from('devedores')
                .select('*')
                .in('status', ['ABERTO', 'ATRASADO'])
                .lt('data_vencimento', dataHojeStr) // Venceu antes de hoje
                .range(pA, pA + 999);

            if (error || !emAtraso || emAtraso.length === 0) break;

            for (const dev of emAtraso) {
                if (clientesOff.has(dev.id) || dev.isento_multa) continue;

                try {
                    // TRAVA DE SEGURANÇA: Se já cobrou juros HOJE, ignora e vai pro próximo cliente.
                    if (dev.ultima_cobranca_atraso === dataHojeStr) {
                        continue; 
                    }

                    const dtVenc = new Date(dev.data_vencimento + 'T12:00:00Z');
                    dtVenc.setHours(0,0,0,0);
                    
                    const totalDiasAtraso = Math.floor((momentoBRT - dtVenc) / (1000 * 60 * 60 * 24));
                    
                    if (totalDiasAtraso > 0 && totalDiasAtraso <= 365) {
                        // Calcula a multa apenas sobre o Capital Emprestado (Raiz) para 1 DIA
                        const capitalRaiz = parseFloat(dev.valor_emprestado) || parseFloat(dev.valor_total);
                        const valorMultaDeHoje = capitalRaiz * taxaMultaDec;
                        
                        const saldoAtual = parseFloat(dev.valor_total) || 0;
                        const novoValor = saldoAtual + valorMultaDeHoje;

                        // 3. Atualiza o banco, cravando que HOJE já foi cobrado
                        await supabase.from('devedores').update({ 
                            valor_total: novoValor, 
                            status: 'ATRASADO',
                            ultima_cobranca_atraso: dataHojeStr // <-- ISSO EVITA O BUG DA DUPLICIDADE!
                        }).eq('id', dev.id);
                        
                        // Registra no Log
                        await supabase.from('logs').insert([{ 
                            evento: `Juros de Atraso (${taxaDiariaPercentual.toFixed(1)}%/dia)`, 
                            detalhes: `Cobrança de 1 dia aplicado. Multa: R$ ${valorMultaDeHoje.toFixed(2)}. Saldo Final: R$ ${novoValor.toFixed(2)}`, 
                            devedor_id: dev.id 
                        }]);

                        let valorParcelaComAtraso = dev.qtd_parcelas > 1 ? (novoValor / dev.qtd_parcelas) : novoValor;
                        const pixDaVezAtraso = escolherPixInteligente(configPixString, valorParcelaComAtraso);
                        
                        // Envia aviso no Zap (opcional, comente se não quiser mandar msg todo dia)
                        await enviarAvisoAtraso(dev.telefone, dev.nome, valorParcelaComAtraso, totalDiasAtraso, pixDaVezAtraso);
                        await sleep(2500); // Pausa para não banir o WhatsApp
                        
                    } else if (totalDiasAtraso > 365) {
                        clientesOff.add(dev.id); // Cliente muito atrasado, para de rodar para economizar processamento
                    }
                } catch (e) { 
                    clientesOff.add(dev.id); 
                }
            }
            if (emAtraso.length < 1000) runAtraso = false;
            pA += 1000;
        }
        
    } catch (err) {
        console.log('[CRON] Erro ao processar atrasados: ', err.message);
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Servidor Alta Performance a rodar na porta ${PORT}`));