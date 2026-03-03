require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const { supabase } = require('./database');
const { enviarZap, formatarNumero, verificarStatusZapi, enviarLembreteVencimento, enviarAvisoAtraso } = require('./services/zapService');
const { recalcularDivida } = require('./services/financeService');
const { fazerUploadNoSupabase } = require('./services/uploadService');
const { gerarLinkCobranca } = require('./services/infinity');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // 🛡️ Proteção DoS
app.use(express.urlencoded({ limit: '15mb', extended: true }));
app.use(express.static('public'));

const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`;

// Estruturas de Memória e Proteção
const processandoWebhooks = new Set();
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
// 1. SISTEMA DE AUTENTICAÇÃO E SESSÕES
// ==========================================
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const tentativas = tentativasLogin.get(ip) || 0;
    if (tentativas >= 5) {
        return res.status(429).json({ erro: 'Muitas tentativas falhadas. Por favor, aguarde 5 minutos.' });
    }

    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
            tentativasLogin.set(ip, tentativas + 1);
            setTimeout(() => tentativasLogin.delete(ip), 5 * 60 * 1000); 
            return res.status(401).json({ erro: 'E-mail ou palavra-passe incorretos.' });
        }
        
        tentativasLogin.delete(ip); 
        res.json({ token: data.session.access_token, email: data.user?.email });
    } catch (err) { 
        res.status(500).json({ erro: 'Erro interno de autenticação.' }); 
    }
});

const authMiddleware = async (req, res, next) => {
    const rotasPublicas = [
        '/api/login', '/upload-foto', '/enviar-solicitacao', '/api/enviar-solicitacao', 
        '/validar-extrato', '/cliente-aceitou', '/cliente-gerar-pagamento', 
        '/status-zapi', '/api/config-publica', '/favicon.ico'
    ];
    
    if (rotasPublicas.includes(req.path) || req.path.startsWith('/webhook-infinitepay') || req.path.startsWith('/api/buscar-cliente-publico')) {
        return next();
    }
    
    const tokenHeader = req.headers['authorization'];
    if (!tokenHeader || !tokenHeader.startsWith('Bearer ')) {
        return res.status(401).json({ erro: 'Acesso Restrito.' });
    }
    
    const token = tokenHeader.split(' ')[1];
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) throw new Error("Sessão Inválida");
        req.user = user; 
        return next();
    } catch(err) { 
        return res.status(401).json({ erro: 'Sessão expirada.' }); 
    }
};
app.use(authMiddleware);

app.get('/api/verify-session', (req, res) => res.json({ autenticado: true, email: req.user?.email }));

// ==========================================
// 2. ROTAS PÚBLICAS E INTEGRAÇÕES EXTERNAS
// ==========================================
app.get('/status-zapi', async (req, res) => { 
    try { const status = await verificarStatusZapi(); res.json(status); } catch(e) { res.json({ connected: false }); } 
});

app.get('/api/config-publica', async (req, res) => {
    try { const { data } = await supabase.from('config').select('*').in('chave', ['valor_minimo', 'juros_unico', 'juros_parcelado']); res.json(data || []); } catch(e) { res.json([]); }
});

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
    if (reqCount >= 3) return res.status(429).json({ erro: "Muitas solicitações enviadas. Aguarde algumas horas." });
    
    try {
        const d = req.body;
        const imagensParaVerificar = [d.url_selfie, d.url_residencia, d.url_frente, d.url_verso, d.url_casa];
        for (let img of imagensParaVerificar) { 
            if (img && img.length > 4 * 1024 * 1024) return res.status(413).json({ erro: "Imagem excede o limite." }); 
        }

        const { data: bl } = await supabase.from('lista_negra').select('cpf').eq('cpf', d.cpf).single();
        if (bl) return res.status(403).json({ erro: "CPF bloqueado." });

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
        
        // Cálculo de Parcelas para o Front-end
        dev.valor_parcela = (dev.qtd_parcelas > 1) ? (dev.valor_total / dev.qtd_parcelas) : dev.valor_total;
        dev.parcelas_pagas = (dev.qtd_parcelas > 1 && dev.valor_parcela > 0) ? Math.floor((dev.total_ja_pego || 0) / dev.valor_parcela) : ((dev.total_ja_pego >= dev.valor_total) ? 1 : 0);

        res.json(dev); 
    } catch(e) { res.status(500).json({ erro: e.message }); } 
});

app.post('/cliente-aceitou', async (req, res) => { 
    try { 
        const { data: dev } = await supabase.from('devedores').select('*').eq('uuid', req.body.id).single();
        if (!dev) throw new Error("Não encontrado");
        
        if (dev.status === 'ABERTO' || dev.status === 'ATRASADO') return res.json({ status: 'Assinado' });
        
        const momentBRT = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        momentBRT.setDate(momentBRT.getDate() + (dev.frequencia === 'SEMANAL' ? 7 : 30));
        const dataVencimentoReal = momentBRT.toISOString().split('T')[0];

        await supabase.from('devedores').update({ status: 'ABERTO', data_vencimento: dataVencimentoReal }).eq('id', dev.id);
        await supabase.from('solicitacoes').update({ status: 'ASSINADO' }).eq('cpf', dev.cpf).eq('status', 'APROVADO_CP');
        await supabase.from('logs').insert([{ evento: "Assinatura Digital", detalhes: `Contrato ativado. Venc: ${dataVencimentoReal}.`, devedor_id: dev.id }]); 
        res.json({ status: 'Assinado' }); 
    } catch(e) { res.status(500).json({ erro: e.message }); } 
});

app.post('/cliente-gerar-pagamento', async (req, res) => { 
    try { 
        if (!req.body.id || typeof req.body.id !== 'string') return res.status(400).json({ erro: "Identificador inválido." });

        const { data: dev } = await supabase.from('devedores').select('*').eq('uuid', req.body.id).single(); 
        if (!dev) throw new Error("Extrato não encontrado.");
        
        const link = await gerarLinkCobranca(dev, parseFloat(req.body.valorParaPagar)); 
        res.json({ checkout_url: link }); 
    } catch(e) { res.status(500).json({ erro: e.message }); } 
});

// ==========================================
// 4. WEBHOOK DA INFINITEPAY
// ==========================================
app.post('/webhook-infinitepay/:token', async (req, res) => {
    try {
        if (req.params.token !== (process.env.WEBHOOK_SECRET || "cms_seguro_2024")) return res.status(403).send('Acesso Negado');

        const payload = req.body;
        const statusPgto = (payload.status || payload.state || '').toLowerCase();
        
        if (!statusPgto || !['approved', 'paid', 'settled', 'authorized'].includes(statusPgto)) return res.status(200).send('OK - Status ignorado');

        const devUuid = payload.order_nsu || payload.metadata?.order_nsu || payload.metadata?.custom_id; 
        const valorReais = (payload.paid_amount || payload.amount) / 100;
        const transactionId = payload.id; 

        if (devUuid && valorReais > 0 && transactionId) {
            if (processandoWebhooks.has(transactionId)) return res.status(200).send('OK - Em processamento');
            processandoWebhooks.add(transactionId);
            
            try {
                const { data: dev, error: devErr } = await supabase.from('devedores').select('*').eq('uuid', devUuid).maybeSingle();
                if (devErr) throw devErr;
                if (!dev) return res.status(200).send('OK - Cliente inexistente.');

                const resultadoRecalculo = await recalcularDivida(dev.id, valorReais, transactionId, null, 'CONTA');
                if (resultadoRecalculo.erro) {
                    if (resultadoRecalculo.erro === "Webhook Duplicado - Transação Abortada.") return res.status(200).send('OK - Já Processado');
                    throw new Error(resultadoRecalculo.erro);
                }
                res.status(200).send('OK');
            } finally { setTimeout(() => processandoWebhooks.delete(transactionId), 5000); }
        } else { res.status(400).send('Bad Request'); }
    } catch(e) { if (!res.headersSent) res.status(500).send('Falha Interna'); }
});

// ==========================================
// 5. ROTAS DE GESTÃO E DASHBOARD
// ==========================================
app.get(['/api/dashboard', '/api/dashboard-master'], async (req, res) => {
    try {
        const { data: configs } = await supabase.from('config').select('*');
        let caixaGeral = 50000; 
        configs?.forEach(c => { if (c.chave === 'caixa_total') caixaGeral = parseFloat(c.valor) || 0; });

        const p_inicio = req.query.inicio || null;
        const p_fim = req.query.fim || null;

        const { data: dbResumo, error: rpcErr } = await supabase.rpc('obter_resumo_dashboard', {
            p_inicio: p_inicio,
            p_fim: p_fim
        });
        
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
    const { id, juros, observacao, novoValor, novaFreq, novasParcelas, cobrarSoEmDinheiro } = req.body;
    const lockKey = `aprovar_${id}`;
    if (travasAtivasPainel.has(lockKey)) return res.status(429).json({ erro: "Operação em andamento." });
    travasAtivasPainel.add(lockKey);

    try {
        const { data: sol, error: errSol } = await supabase.from('solicitacoes').select('*').eq('id', id).single();
        if (errSol || !sol) throw new Error("Não encontrada.");
        if (sol.status !== 'PENDENTE') return res.status(400).json({ erro: "Já foi tratada." });

        const jurosDecimal = Math.max(0, (limparMoeda(juros) || 30) / 100);
        const valorFinal = novoValor ? Math.max(0, limparMoeda(novoValor)) : Math.max(0, limparMoeda(sol.valor));
        const freqFinal = novaFreq || sol.frequencia || 'MENSAL';
        
        let parcelasFinais = novasParcelas ? parseInt(novasParcelas) : (parseInt(sol.qtd_parcelas) || 1);
        parcelasFinais = Math.max(1, parcelasFinais);

        let taxaAplicada = jurosDecimal;
        if (parcelasFinais > 1) taxaAplicada = jurosDecimal * parcelasFinais;
        const valorTotal = Math.round((valorFinal * (1 + taxaAplicada)) * 100) / 100;
        
        const momentBRT = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        momentBRT.setDate(momentBRT.getDate() + (freqFinal === 'SEMANAL' ? 7 : 30));
        const dtVencimentoProjetado = momentBRT.toISOString().split('T')[0];
        
        const cpfLimpo = String(sol.cpf || '').replace(/\D/g, '');

        const { data: active } = await supabase.from('devedores').select('id').eq('cpf', cpfLimpo).in('status', ['ABERTO', 'ATRASADO', 'APROVADO_AGUARDANDO_ACEITE']).limit(1);
        if (active && active.length > 0) return res.status(400).json({ erro: "Cliente possui contrato ativo." });

        const { data: exDevs } = await supabase.from('devedores').select('id, uuid, status').eq('cpf', cpfLimpo).order('created_at', { ascending: false }).limit(1);
        const exDev = exDevs && exDevs.length > 0 ? exDevs[0] : null;

        let devId; let devUuid;
        let payload = {
            nome: sol.nome, telefone: sol.whatsapp || sol.telefone || 'N/A', valor_emprestado: valorFinal, valor_total: valorTotal,
            frequencia: freqFinal, qtd_parcelas: parcelasFinais, status: 'APROVADO_AGUARDANDO_ACEITE', data_vencimento: dtVencimentoProjetado, 
            taxa_juros: jurosDecimal * 100, observacoes: observacao || '', url_selfie: sol.url_selfie, url_frente: sol.url_frente, 
            url_verso: sol.url_verso, url_residencia: sol.url_residencia, url_casa: sol.url_casa, referencia1_nome: sol.referencia1_nome, 
            referencia1_tel: sol.referencia1_tel, indicado_por: sol.indicado_por, pago: false, cobrar_so_em_dinheiro: cobrarSoEmDinheiro || false
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
        try { await enviarZap(payload.telefone, `🎉 Seu crédito foi APROVADO!\nAssine para receber: ${linkAceite}`); } catch(e) {}
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); } finally { setTimeout(() => travasAtivasPainel.delete(lockKey), 3000); }
});

app.post('/api/rejeitar-solicitacao', async (req, res) => {
    try {
        const { data: sol } = await supabase.from('solicitacoes').select('status').eq('id', req.body.id).single();
        if (sol && sol.status === 'ASSINADO') return res.status(400).json({ erro: "Cliente já assinou."});
        await supabase.from('solicitacoes').update({ status: 'REJEITADO', observacoes: req.body.motivo }).eq('id', req.body.id);
        await supabase.from('logs').insert([{ evento: "Solicitação Rejeitada", detalhes: `Motivo: ${req.body.motivo}` }]);
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

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
        if (!dev) throw new Error("Não encontrado");
        let msg = '';
        if (dev.cobrar_so_em_dinheiro) msg = `Olá ${dev.nome.split(' ')[0]},\n\nEste é um lembrete da sua fatura em aberto. Por favor, prepare o valor em espécie para o nosso cobrador.`;
        else msg = `Olá ${dev.nome.split(' ')[0]},\n\nAqui está o link para pagamento seguro:\n🔗 ${APP_URL}/pagar.html?id=${dev.uuid}`;
        
        await enviarZap(dev.telefone, msg);
        await supabase.from('logs').insert([{ evento: "Envio Manual de Cobrança", detalhes: `Link/Aviso via WhatsApp.`, devedor_id: dev.id }]);
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/cliente-extrato/:busca', async (req, res) => {
    try {
        const b = decodeURIComponent(req.params.busca); const hasNum = /\d/.test(b); let q = supabase.from('devedores').select('*');
        if (hasNum) { const num = b.replace(/\D/g, ''); q = q.or(`cpf.eq.${num},telefone.ilike.%${num}%`); } else { q = q.ilike('nome', `%${b}%`); }
        
        const { data: cls, error } = await q;
        if (error || !cls || cls.length === 0) return res.status(404).json({ erro: "Não encontrado" });
        
        const main = cls.find(c => c.status === 'ABERTO' || c.status === 'ATRASADO') || cls[0];
        const { data: tds } = await supabase.from('devedores').select('*').eq('cpf', main.cpf);
        
        const tdsComParcelas = (tds || cls).map(dev => {
            dev.valor_parcela = (dev.qtd_parcelas > 1) ? (dev.valor_total / dev.qtd_parcelas) : dev.valor_total;
            dev.parcelas_pagas = (dev.qtd_parcelas > 1 && dev.valor_parcela > 0) ? Math.floor((dev.total_ja_pego || 0) / dev.valor_parcela) : ((dev.total_ja_pego >= dev.valor_total) ? 1 : 0);
            return dev;
        });
        const mainComParcelas = tdsComParcelas.find(c => c.id === main.id) || main;

        const idsArray = (tds || []).map(c => c.id);
        const { data: logs } = await supabase.from('logs').select('*').in('devedor_id', idsArray).order('created_at', { ascending: false }).limit(200);
        
        res.json({ cliente: mainComParcelas, todos_contratos: tdsComParcelas, logs: logs || [] });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/buscar-cliente-admin/:busca', async (req, res) => {
    try {
        const b = decodeURIComponent(req.params.busca); 
        const hasNum = /\d/.test(b); 
        let q = supabase.from('devedores').select('id, nome, cpf, telefone, status');
        if (hasNum) { 
            const num = b.replace(/\D/g, ''); 
            q = q.or(`cpf.eq.${num},telefone.ilike.%${num}%`); 
        } else { 
            q = q.ilike('nome', `%${b}%`); 
        }
        const { data: cls, error } = await q.limit(10);
        if (error || !cls || cls.length === 0) return res.status(404).json({ erro: "Nenhum cliente encontrado" });
        
        const uniqueClients = [];
        const cpfs = new Set();
        for (const c of cls) {
            if (!cpfs.has(c.cpf)) {
                cpfs.add(c.cpf);
                uniqueClients.push(c);
            }
        }
        res.json(uniqueClients);
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/editar-contrato', async (req, res) => {
    try {
        const { id, novoVencimento, novoCapital, novoTotal, novaFrequencia, cobrarSoEmDinheiro } = req.body;
        const { data: devAntigo } = await supabase.from('devedores').select('valor_emprestado, status').eq('id', id).maybeSingle();
        if (devAntigo?.status === 'APROVADO_AGUARDANDO_ACEITE') return res.status(400).json({ erro: "Contrato pendente não editável." });

        await supabase.from('devedores').update({ 
            data_vencimento: novoVencimento, valor_emprestado: limparMoeda(novoCapital), valor_total: limparMoeda(novoTotal), 
            frequencia: novaFrequencia, status: 'ABERTO', ultima_cobranca_atraso: null, pago: false, cobrar_so_em_dinheiro: cobrarSoEmDinheiro
        }).eq('id', id);
        
        await supabase.from('logs').insert([{ evento: "Edição Manual", detalhes: `Vencimento para ${novoVencimento}. Saldo: R$ ${limparMoeda(novoTotal)}`, devedor_id: id }]);
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
        if (new Date() > venc) {
            diasAtraso = Math.floor((new Date() - venc) / (1000 * 60 * 60 * 24));
        }
        const saldoAtual = parseFloat(dev.valor_total || 0);

        res.json({ data_emprestimo: dev.created_at, capital_original: dev.valor_emprestado, saldo_atual: saldoAtual, dias_atraso: Math.max(0, diasAtraso), total_pago: totalPago });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/baixar-manual', async (req, res) => {
    const { id, valorPago, observacoes, recalculoAjuste, recalculoTaxa, recalculoParcelas, dataRecebimento, formaPagamento } = req.body;
    
    const lockKey = `baixa_${id}`;
    if (travasAtivasPainel.has(lockKey)) return res.status(429).json({ erro: "Aguarde processamento..." });
    travasAtivasPainel.add(lockKey);

    try { 
        let resRecalculo = { sucesso: true, status: 'apenas_ajuste' };
        const vPago = limparMoeda(valorPago); 
        const calcAjuste = limparMoeda(recalculoAjuste); 
        const calcTaxa = limparMoeda(recalculoTaxa);

        if (vPago > 0) {
            resRecalculo = await recalcularDivida(id, vPago, null, dataRecebimento, formaPagamento); 
            if (resRecalculo.erro) throw new Error(resRecalculo.erro);
        }
        
        let atualizacoes = {}; let notas = [];
        const { data: dev } = await supabase.from('devedores').select('*').eq('id', id).single();
        
        if (dev && ['ABERTO', 'ATRASADO', 'QUITADO'].includes(dev.status)) {
            let novoTotal = parseFloat(dev.valor_total || 0);
            let parcelasAtuais = dev.qtd_parcelas || 1;
            
            if (recalculoParcelas && parseInt(recalculoParcelas) > 0) { 
                parcelasAtuais = parseInt(recalculoParcelas); atualizacoes.qtd_parcelas = parcelasAtuais; notas.push(`Para ${parcelasAtuais} parcelas`); 
            }
            if (calcTaxa > 0) {
                const cap = parseFloat(dev.valor_emprestado || 0); 
                const tDec = calcTaxa / 100;
                let taxaAplicada = tDec;
                if (parcelasAtuais > 1) taxaAplicada = tDec * parcelasAtuais;
                novoTotal = cap * (1 + taxaAplicada); atualizacoes.taxa_juros = calcTaxa; notas.push(`Taxa ${calcTaxa}%`);
            }
            if (calcAjuste !== 0) { novoTotal += calcAjuste; notas.push(`Ajuste: R$ ${calcAjuste}`); }
            if (observacoes) { notas.push(`Obs: ${observacoes}`); atualizacoes.observacoes = (dev.observacoes ? dev.observacoes + " | " : "") + `[${new Date().toLocaleDateString()}] ${observacoes}`; }

            if (novoTotal <= 0.05) { atualizacoes.valor_total = 0; atualizacoes.valor_emprestado = 0; atualizacoes.status = 'QUITADO'; atualizacoes.pago = true; } 
            else { atualizacoes.valor_total = Math.max(0, novoTotal); if(dev.status === 'QUITADO' && atualizacoes.valor_total > 0) { atualizacoes.status = 'ABERTO'; atualizacoes.pago = false; } }

            if (Object.keys(atualizacoes).length > 0) await supabase.from('devedores').update(atualizacoes).eq('id', id);
            if (notas.length > 0) await supabase.from('logs').insert([{ evento: "Ajuste Manual", detalhes: notas.join(' | '), devedor_id: id }]);
        }
        res.json(resRecalculo);
    } catch (e) { res.status(500).json({ erro: e.message }); } finally { setTimeout(() => travasAtivasPainel.delete(lockKey), 3000); }
});

// 🚨 NOVO: Rota de Cadastro Manual com processamento de fotos e tratamento de erros do DB
app.post('/api/cadastrar-cliente-manual', async (req, res) => {
    try {
        const d = req.body;
        
        // 🚨 Processa de forma independente as fotos que tenham sido enviadas via painel manual
        const uS = d.img_selfie ? await fazerUploadNoSupabase(d.img_selfie, `${d.cpf}_s_${Date.now()}.jpg`) : null;
        const uF = d.img_frente ? await fazerUploadNoSupabase(d.img_frente, `${d.cpf}_f_${Date.now()}.jpg`) : null;
        const uV = d.img_verso ? await fazerUploadNoSupabase(d.img_verso, `${d.cpf}_v_${Date.now()}.jpg`) : null;
        const uR = d.img_residencia ? await fazerUploadNoSupabase(d.img_residencia, `${d.cpf}_r_${Date.now()}.jpg`) : null;
        const uC = d.img_casa ? await fazerUploadNoSupabase(d.img_casa, `${d.cpf}_c_${Date.now()}.jpg`) : null;
        
        let db = { nome: d.nome, cpf: d.cpf, telefone: d.whatsapp, observacoes: "[Manual]", cobrar_so_em_dinheiro: d.cobrar_so_em_dinheiro || false };
        
        // 🚨 Substitui apenas as fotos que você enviou agora. Mantém as antigas que não foram alteradas
        if(uS) db.url_selfie = uS; 
        if(uF) db.url_frente = uF; 
        if(uV) db.url_verso = uV; 
        if(uR) db.url_residencia = uR; 
        if(uC) db.url_casa = uC; 

        if (!d.is_precadastro) {
            db.valor_emprestado = limparMoeda(d.valor_emprestado); db.valor_total = limparMoeda(d.valor_total);
            db.data_vencimento = new Date(d.data_vencimento + 'T12:00:00Z').toISOString().split('T')[0];
            db.frequencia = d.frequencia; db.qtd_parcelas = Math.max(1, parseInt(d.qtd_parcelas) || 1);
            
            const vEmp = db.valor_emprestado; const vTot = db.valor_total; let taxaCalc = 30;
            if (vEmp > 0) taxaCalc = (((vTot / vEmp) - 1) / db.qtd_parcelas) * 100;
            db.taxa_juros = Math.round(taxaCalc * 100) / 100;
            db.status = 'ABERTO'; db.pago = false;
        } else {
            db.status = 'PRE_CADASTRO'; db.pago = true; db.valor_emprestado = 0; db.valor_total = 0;
        }

        let dId;
        
        if (d.id_existente) {
            const { data: o, error: errBusca } = await supabase.from('devedores').select('status').eq('id', d.id_existente).single();
            if (errBusca) throw errBusca;
            
            if (o?.status === 'PRE_CADASTRO' || o?.status === 'QUITADO') {
                if (!d.is_precadastro) { db.created_at = new Date().toISOString(); db.ultima_cobranca_atraso = null; }
                
                // 🚨 Tenta atualizar. Se houver falha de constrição na DB (ex: tem outro ativo), lança o erro real.
                const { data: u, error: uErr } = await supabase.from('devedores').update(db).eq('id', d.id_existente).select().single();
                if (uErr) throw uErr;
                dId = u.id;
            } else {
                // Tenta criar novo registo. A DB vai bloquear se o CPF já estiver em uso (ABERTO/ATRASADO).
                const { data: i, error: iErr } = await supabase.from('devedores').insert([db]).select().single();
                if (iErr) throw iErr;
                dId = i.id;
            }
        } else {
            const { data: i, error: iErr } = await supabase.from('devedores').insert([db]).select().single();
            if (iErr) throw iErr;
            dId = i.id;
        }

        if (!d.is_precadastro) {
            await supabase.from('logs').insert([{ evento: 'Empréstimo Liberado', detalhes: `Lançado.`, devedor_id: dId, valor_fluxo: -Math.abs(db.valor_emprestado) }]);
        } else {
            await supabase.from('logs').insert([{ evento: 'Pré-Cadastro', detalhes: `Salvo.`, devedor_id: dId }]); 
        }
        res.json({ sucesso: true });
    } catch (err) { 
        // Envia a mensagem exata do erro da base de dados para o frontend traduzir
        res.status(500).json({ erro: err.message }); 
    }
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
    try { const { data } = await supabase.from('promotores').select('*').order('created_at', { ascending: false }); res.json(data || []); } catch(e) { res.status(500).json({ erro: e.message }); }
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
        let movimentacoes = [];

        const chunkArray = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));

        const devedorIdsPeriodo = [...new Set(todosLogs.filter(l => l.valor_fluxo > 0 && l.devedor_id).map(l => l.devedor_id))];
        let taxasDevedores = {};

        if (devedorIdsPeriodo.length > 0) {
            const chunks = chunkArray(devedorIdsPeriodo, 200);
            let devsEncontrados = [];
            
            for (const chunk of chunks) {
                const { data: devs } = await supabase.from('devedores')
                    .select('id, taxa_juros, qtd_parcelas')
                    .in('id', chunk);
                if (devs) devsEncontrados = devsEncontrados.concat(devs);
            }

            devsEncontrados.forEach(d => {
                taxasDevedores[d.id] = {
                    taxa: parseFloat(d.taxa_juros) || 30,
                    parcelas: parseInt(d.qtd_parcelas) || 1
                };
            });
        }

        let jurosMensalidade = 0;

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

                if (log.devedor_id && taxasDevedores[log.devedor_id]) {
                    const info = taxasDevedores[log.devedor_id];
                    let taxaAplicada = info.taxa / 100;
                    if (info.parcelas > 1) {
                        taxaAplicada = (info.taxa / 100) * info.parcelas;
                    }
                    const multiplicador = 1 + taxaAplicada;
                    const jurosDestaParcela = v - (v / multiplicador);
                    jurosMensalidade += jurosDestaParcela;
                } else {
                    jurosMensalidade += v - (v / 1.3);
                }
            }
            
            if (ev.includes('Juros de Atraso')) {
                const match = (log.detalhes || "").match(/R\$ ([\d.,]+)/);
                if (match) { 
                    const parsedMulta = parseFloat(match[1].replace(/\./g, '').replace(',', '.')); 
                    if (!isNaN(parsedMulta)) jurosAtrasoGerado += parsedMulta; 
                }
            }
            
            if (v !== 0 && !ev.includes('Histórico Antigo')) {
                log.devedores = log.devedores || { nome: 'Empresa / Caixa Interno' };
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

        const lucro = jurosMensalidade - totalDespesas;

        res.json({ 
            totalEmprestado: totalEmprestado || 0, 
            totalRecebido: totalRecebido || 0, 
            totalDespesas: totalDespesas || 0,
            lucro: lucro || 0,
            jurosAtrasoGerado: jurosAtrasoGerado || 0,
            jurosMensalidade: jurosMensalidade || 0,
            qtdCadastros: qtdCadastros || 0,
            qtdQuitados: qtdQuitados || 0,
            diasAtrasados: diasAtrasados || 0,
            movimentacoes: movimentacoes.slice(0, 1500),

            emprestimos_realizados: qtdCadastros || 0,
            emprestimosRealizados: qtdCadastros || 0,
            finalizados: qtdQuitados || 0,
            liquidados: qtdQuitados || 0,
            finalizados_liquidados: qtdQuitados || 0,
            capital_emprestado: totalEmprestado || 0,
            capitalEmprestado: totalEmprestado || 0,
            retorno_conta: totalRecebido || 0,
            retornoConta: totalRecebido || 0,
            retorno_para_conta: totalRecebido || 0,
            lucro_liquido: lucro || 0,
            lucroLiquido: lucro || 0,
            juros_pagos: jurosMensalidade || 0,
            jurosPagos: jurosMensalidade || 0,
            juros_mensalidade: jurosMensalidade || 0,
            multas_pagas: jurosAtrasoGerado || 0,
            multasPagas: jurosAtrasoGerado || 0,
            multas_atraso: jurosAtrasoGerado || 0
        });
    } catch (e) { 
        res.json({ totalEmprestado: 0, totalRecebido: 0, totalDespesas: 0, lucro: 0, entradas: 0, saidas: 0, saldo: 0, movimentacoes: [] }); 
    }
});

cron.schedule('0 * * * *', async () => {
    try {
        const tempoEspera = Math.floor(Math.random() * 5000); 
        await sleep(tempoEspera);
        
        const dataApoio = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        const dataMatematicaHoje = new Date(dataApoio.getTime()); 
        dataMatematicaHoje.setHours(0, 0, 0, 0);

        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
        const dataHojeSimples = formatter.format(dataApoio);
        const lockHour = `${dataHojeSimples}_${dataApoio.getHours()}`;
        
        const { data: lockCron } = await supabase.from('config').select('valor').eq('chave', 'cron_diario_lock').maybeSingle();
        if (lockCron && lockCron.valor === lockHour) return;
        
        await supabase.from('config').upsert({ chave: 'cron_diario_lock', valor: lockHour });

        const objAmanha = new Date(dataApoio); 
        objAmanha.setDate(objAmanha.getDate() + 1);
        const dataAmanhaSimples = formatter.format(objAmanha);
        
        let ponteiroLembrete = 0; 
        let buscarLembretes = true;
        
        while (buscarLembretes) {
            const { data: lembretes } = await supabase.from('devedores').select('*')
                .eq('pago', false)
                .in('status', ['ABERTO', 'ATRASADO'])
                .in('data_vencimento', [dataHojeSimples, dataAmanhaSimples])
                .range(ponteiroLembrete, ponteiroLembrete + 999);
                
            if (!lembretes || lembretes.length === 0) break;
            
            for (const dev of lembretes) {
                try {
                    let linkPortal = '';
                    if (!dev.cobrar_so_em_dinheiro) {
                        linkPortal = `${APP_URL}/pagar.html?id=${dev.uuid}`;
                    }
                    await enviarLembreteVencimento(dev.telefone, dev.nome, parseFloat(dev.valor_total || 0), dev.data_vencimento, linkPortal);
                    await sleep(2500); 
                } catch (e) { }
            }
            if (lembretes.length < 1000) buscarLembretes = false;
            ponteiroLembrete += 1000;
        }

        const { data: confMulta } = await supabase.from('config').select('valor').eq('chave', 'multa_diaria').single();
        const taxaMultaDec = (parseFloat(confMulta?.valor) || 3) / 100;
        
        let buscarAtrasos = true; 
        const clientesEmQuarentena = new Set(); 
        
        while (buscarAtrasos) {
            let queryAtrasos = supabase.from('devedores').select('*')
                .eq('pago', false)
                .in('status', ['ABERTO', 'ATRASADO'])
                .lt('data_vencimento', dataHojeSimples)
                .or(`ultima_cobranca_atraso.neq.${dataHojeSimples},ultima_cobranca_atraso.is.null`)
                .range(0, 999);
                
            if (clientesEmQuarentena.size > 0) {
                queryAtrasos = queryAtrasos.not('id', 'in', `(${Array.from(clientesEmQuarentena).join(',')})`);
            }

            const { data: devedoresEmAtraso } = await queryAtrasos;
            if (!devedoresEmAtraso || devedoresEmAtraso.length === 0) break;

            for (const dev of devedoresEmAtraso) {
                try {
                    const dataBaseCalculo = dev.ultima_cobranca_atraso ? new Date(dev.ultima_cobranca_atraso + 'T00:00:00-03:00') : new Date(dev.data_vencimento + 'T00:00:00-03:00');
                    const diasParaCobrar = Math.round((dataMatematicaHoje - dataBaseCalculo) / (1000 * 60 * 60 * 24));
                    
                    if (diasParaCobrar > 0 && diasParaCobrar <= 365) {
                        let novoValor = parseFloat(dev.valor_total || 0); 
                        let multasAcumuladas = 0;
                        
                        for (let i = 0; i < diasParaCobrar; i++) {
                            let multaDoDia = Math.round((novoValor * taxaMultaDec) * 100) / 100;
                            novoValor = Math.round((novoValor + multaDoDia) * 100) / 100;
                            multasAcumuladas += multaDoDia;
                        }
                        
                        const totalDiasAtraso = Math.round((dataMatematicaHoje - new Date(dev.data_vencimento + 'T00:00:00-03:00')) / (1000 * 60 * 60 * 24));

                        await supabase.from('devedores').update({ 
                            valor_total: novoValor, 
                            ultima_cobranca_atraso: dataHojeSimples, 
                            status: 'ATRASADO' 
                        }).eq('id', dev.id);
                        
                        await supabase.from('logs').insert([{ 
                            evento: `Juros de Atraso (${(taxaMultaDec*100).toFixed(1)}%/dia)`, 
                            detalhes: `Cobrança de ${diasParaCobrar} dia(s). Multa aplicada: R$ ${multasAcumuladas.toFixed(2)}. Saldo: R$ ${novoValor.toFixed(2)}`, 
                            devedor_id: dev.id 
                        }]);

                        let linkPortal = '';
                        if (!dev.cobrar_so_em_dinheiro) {
                            linkPortal = `${APP_URL}/pagar.html?id=${dev.uuid}`;
                        }
                        
                        await enviarAvisoAtraso(dev.telefone, dev.nome, novoValor, totalDiasAtraso, linkPortal);
                        await sleep(2500); 
                        
                    } else if (diasParaCobrar > 365 || isNaN(diasParaCobrar)) {
                        clientesEmQuarentena.add(dev.id);
                    }
                } catch (e) { 
                    clientesEmQuarentena.add(dev.id); 
                }
            }
            if (devedoresEmAtraso.length < 1000) buscarAtrasos = false;
        }
    } catch(e) { }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Servidor Alta Performance a rodar na porta ${PORT}`));