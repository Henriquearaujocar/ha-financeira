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
// Limite aumentado para suportar múltiplas fotos em Base64 no Cadastro Manual e Solicitação
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
// FUNÇÃO AUXILIAR: GERADOR DE PARCELAS INDIVIDUAIS
// ==========================================
const gerarArrayDeParcelas = (devedorId, valorTotal, qtdParcelas, frequencia) => {
    const parcelas = [];
    // Garante precisão de centavos na divisão
    const valorParcela = Math.round((valorTotal / qtdParcelas) * 100) / 100;
    
    // Configura a data base para o fuso horário correto
    let dataBase = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
    dataBase.setHours(12, 0, 0, 0);

    for (let i = 1; i <= qtdParcelas; i++) {
        if (frequencia === 'SEMANAL') {
            dataBase.setDate(dataBase.getDate() + 7);
        } else {
            dataBase.setMonth(dataBase.getMonth() + 1);
        }
        
        parcelas.push({
            devedor_id: devedorId,
            numero_parcela: i,
            valor_original: valorParcela,
            valor_atual: valorParcela,
            valor_pago: 0,
            data_vencimento: dataBase.toISOString().split('T')[0],
            status: 'PENDENTE'
        });
    }
    
    // Corrige possível dízima na última parcela (ex: 100 / 3 = 33.33 -> sobram 0.01)
    const somaParcelas = parcelas.reduce((acc, p) => acc + p.valor_original, 0);
    if (somaParcelas !== valorTotal) {
        const diferenca = Math.round((valorTotal - somaParcelas) * 100) / 100;
        parcelas[parcelas.length - 1].valor_original += diferenca;
        parcelas[parcelas.length - 1].valor_atual += diferenca;
    }

    return parcelas;
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
    const rotasPublicas = [
        '/api/login', 
        '/upload-foto', 
        '/enviar-solicitacao', 
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
        for (let img of imagensParaVerificar) { if (img && img.length > 15 * 1024 * 1024) return res.status(413).json({ erro: "Imagem excede o limite de tamanho." }); }

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
        let query = supabase.from('devedores').select('*, parcelas(*)').eq('uuid', req.body.id);
        if (req.body.cpf) query = query.eq('cpf', req.body.cpf.replace(/\D/g, '')); 
        
        const { data: dev, error } = await query.single();
        if (error || !dev) return res.status(404).json({ erro: "Extrato não encontrado." }); 
        
        res.json(dev); 
    } catch(e) { res.status(500).json({ erro: e.message }); } 
});

app.post('/cliente-aceitou', async (req, res) => { 
    try { 
        const { data: dev } = await supabase.from('devedores').select('*').eq('uuid', req.body.id).single();
        if (!dev) throw new Error("Extrato não encontrado");
        
        if (dev.status === 'ABERTO' || dev.status === 'ATRASADO') return res.json({ status: 'Assinado' });

        await supabase.from('devedores').update({ status: 'ABERTO' }).eq('id', dev.id);
        await supabase.from('solicitacoes').update({ status: 'ASSINADO' }).eq('cpf', dev.cpf).eq('status', 'APROVADO_CP');
        await supabase.from('logs').insert([{ evento: "Assinatura Digital", detalhes: `Contrato ativado e parcelas geradas com sucesso.`, devedor_id: dev.id }]); 
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
        
        // Puxa as PARCELAS individuais para a previsão de caixa
        const { data: parcelas } = await supabase.from('parcelas')
            .select('data_vencimento, valor_atual, valor_pago, devedores(nome)')
            .in('status', ['PENDENTE', 'PARCIAL'])
            .gte('data_vencimento', dataApoio.toISOString().split('T')[0]);

        const previsao = {};
        
        (parcelas || []).forEach(p => {
            const dataVenc = p.data_vencimento;
            const valorRestante = parseFloat(p.valor_atual) - parseFloat(p.valor_pago || 0);
            
            if (valorRestante > 0) {
                if (!previsao[dataVenc]) previsao[dataVenc] = { total: 0, clientes: [] };
                previsao[dataVenc].total += valorRestante;
                previsao[dataVenc].clientes.push({ nome: p.devedores.nome.split(' ')[0], valor: valorRestante });
            }
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
// 5. ROTAS DE GESTÃO E APROVAÇÕES (COM GERAÇÃO DE PARCELAS)
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
        
        const cpfLimpo = String(sol.cpf || '').replace(/\D/g, '');
        const { data: exDevs } = await supabase.from('devedores').select('id, uuid, status').eq('cpf', cpfLimpo).order('created_at', { ascending: false }).limit(1);
        const exDev = exDevs && exDevs.length > 0 ? exDevs[0] : null;

        let devId, devUuid;
        let payload = {
            nome: sol.nome, telefone: sol.whatsapp || sol.telefone || 'N/A', valor_emprestado: valorFinal, valor_total: valorTotal,
            frequencia: freqFinal, qtd_parcelas: parcelasFinais, status: 'APROVADO_AGUARDANDO_ACEITE', 
            taxa_juros: jurosDecimal * 100, observacoes: observacao || '', url_selfie: sol.url_selfie, url_frente: sol.url_frente, 
            url_verso: sol.url_verso, url_residencia: sol.url_residencia, url_casa: sol.url_casa, referencia1_nome: sol.referencia1_nome, 
            referencia1_tel: sol.referencia1_tel, indicado_por: sol.indicado_por, pago: false, 
            cobrar_so_em_dinheiro: cobrarSoEmDinheiro || false, isento_multa: isentoMulta || false
        };

        // 1. INSERE O CONTRATO PAI
        if (exDev && exDev.status === 'PRE_CADASTRO') {
            payload.created_at = new Date().toISOString(); payload.ultima_cobranca_atraso = null;
            const { data: u, error: uE } = await supabase.from('devedores').update(payload).eq('id', exDev.id).select().single();
            if (uE) throw uE; devId = u.id; devUuid = u.uuid;
        } else {
            payload.cpf = cpfLimpo;
            const { data: i, error: iE } = await supabase.from('devedores').insert([payload]).select().single();
            if (iE) throw iE; devId = i.id; devUuid = i.uuid;
        }

        // 2. GERA E INSERE AS PARCELAS INDIVIDUAIS
        const arrayParcelas = gerarArrayDeParcelas(devId, valorTotal, parcelasFinais, freqFinal);
        await supabase.from('parcelas').insert(arrayParcelas);

        // Atualiza a solicitação e log
        await supabase.from('solicitacoes').update({ status: 'APROVADO_CP', observacoes: observacao }).eq('id', id);
        await supabase.from('logs').insert([{ evento: 'Empréstimo Liberado', detalhes: `Aprovado R$ ${valorFinal.toFixed(2)} em ${parcelasFinais}x.`, devedor_id: devId, valor_fluxo: -Math.abs(valorFinal) }]);

        const linkAceite = `${APP_URL}/aceitar.html?id=${devUuid}`;
        try { 
            const valorDaParcela = arrayParcelas[0].valor_original;
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
// 6. BUSCA DE CLIENTES E NOVA ROTA DE COBRANÇA (PARCELAS INDIVIDUAIS)
// ==========================================

// NOVA ROTA: Retorna as Parcelas Individuais (Para a Aba Cobrança Ativa)
app.get('/api/cobrancas-ativas', async (req, res) => {
    try {
        // Busca as parcelas que precisam de atenção e junta com os dados do cliente (devedores)
        const { data, error } = await supabase
            .from('parcelas')
            .select('*, devedores(nome, cpf, telefone, cobrar_so_em_dinheiro, indicado_por, status)')
            .in('status', ['PENDENTE', 'ATRASADO', 'PARCIAL'])
            .order('data_vencimento', { ascending: true })
            .limit(1000); // Limite de segurança

        if (error) throw error;
        res.json(data || []);
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/clientes-lista', async (req, res) => {
    try {
        let todos = [];
        let buscar = true;
        let ptr = 0;
        
        while (buscar) {
            const { data, error } = await supabase
                .from('devedores')
                .select('cpf, nome, telefone, status')
                .order('nome', { ascending: true })
                .range(ptr, ptr + 999);
            
            if (error || !data || data.length === 0) break;
            todos = todos.concat(data);
            if (data.length < 1000) buscar = false;
            ptr += 1000;
        }

        const unicos = [];
        const cpfs = new Set();
        const cpfsDevendo = new Set();
        const cpfsAtrasados = new Set();
        const cpfsCadastrados = new Set();

        todos.forEach(c => {
            if (c.status !== 'PRE_CADASTRO') cpfsCadastrados.add(c.cpf);
            if (['ABERTO', 'ATRASADO'].includes(c.status)) cpfsDevendo.add(c.cpf);
            if (c.status === 'ATRASADO') cpfsAtrasados.add(c.cpf);
            
            if (!cpfs.has(c.cpf)) {
                cpfs.add(c.cpf);
                unicos.push(c);
            }
        });

        unicos.sort((a, b) => a.nome.localeCompare(b.nome));

        res.json({
            clientes: unicos,
            totalDevendo: cpfsDevendo.size,
            totalAtrasados: cpfsAtrasados.size,
            totalCadastrados: cpfsCadastrados.size
        });
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.get('/api/calotes', async (req, res) => {
    try {
        const { data } = await supabase.from('devedores').select('*').eq('status', 'CALOTE').order('created_at', { ascending: true });
        res.json(data || []);
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.post('/api/marcar-calote', async (req, res) => {
    try {
        const { id, reverter } = req.body;
        const novoStatus = reverter ? 'ATRASADO' : 'CALOTE';
        const evento = reverter ? 'Recuperação de Calote' : 'Baixa por Calote / Perda';
        const detalhes = reverter ? 'Cliente voltou para a esteira de cobrança.' : 'Contrato congelado e removido das projeções de lucro.';
        
        await supabase.from('devedores').update({ status: novoStatus }).eq('id', id);
        
        // Se virou calote, cancela/congela as parcelas abertas
        if (!reverter) {
            await supabase.from('parcelas').update({ status: 'CANCELADA', observacoes: 'Contrato marcado como CALOTE.' }).eq('devedor_id', id).in('status', ['PENDENTE', 'PARCIAL', 'ATRASADO']);
        } else {
            // Se reverter, volta elas para ATRASADO
            await supabase.from('parcelas').update({ status: 'ATRASADO', observacoes: 'Recuperado do CALOTE.' }).eq('devedor_id', id).eq('status', 'CANCELADA');
        }

        await supabase.from('logs').insert([{ evento, detalhes, devedor_id: id }]);
        
        res.json({ sucesso: true });
    } catch(e) {
        res.status(500).json({ erro: e.message });
    }
});

app.post('/api/enviar-cobranca-manual', async (req, res) => {
    try {
        // Agora recebe o ID da parcela (ou do devedor se for acionado de outro lugar)
        const { parcelaId, devedorId } = req.body;
        
        let parcela, dev;

        if (parcelaId) {
            const { data: p } = await supabase.from('parcelas').select('*, devedores(*)').eq('id', parcelaId).single();
            parcela = p;
            dev = p.devedores;
        } else if (devedorId) {
            const { data: d } = await supabase.from('devedores').select('*').eq('id', devedorId).single();
            dev = d;
            // Pega a próxima parcela dele
            const { data: p } = await supabase.from('parcelas').select('*').eq('devedor_id', devedorId).in('status', ['PENDENTE', 'ATRASADO', 'PARCIAL']).order('data_vencimento', { ascending: true }).limit(1).single();
            parcela = p;
        }

        if (!dev || !parcela) throw new Error("Fatura não encontrada");
        
        const valorParcela = parseFloat(parcela.valor_atual) - parseFloat(parcela.valor_pago || 0);

        const { data: confPix } = await supabase.from('config').select('valor').eq('chave', 'pix_avancado').maybeSingle();
        const pixDados = escolherPixInteligente(confPix?.valor, valorParcela);

        const nomeCurto = dev.nome.split(' ')[0];
        const valorFormatado = Number(valorParcela).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        
        const dataVenc = new Date(parcela.data_vencimento + 'T12:00:00Z');
        const hoje = new Date(); 
        hoje.setHours(0,0,0,0);
        let dtFormatada = dataVenc.toLocaleDateString('pt-BR');
        
        let textoAtraso = "";
        if (dataVenc < hoje) {
             const diasAtraso = Math.floor((hoje - dataVenc) / (1000 * 60 * 60 * 24));
             textoAtraso = `\n⚠️ *Atenção:* Identificámos que esta parcela (Nº ${parcela.numero_parcela}) está com ${diasAtraso} dias de atraso.`;
        }

        let msg = '';
        if (dev.cobrar_so_em_dinheiro) {
            msg = `Olá ${nomeCurto},\n\nEste é um aviso da *CMS Ventures* sobre a sua fatura no valor de *${valorFormatado}* (Vencimento: ${dtFormatada}).${textoAtraso}\n\nConforme acordado, este contrato deve ser regularizado em *dinheiro físico*. Por favor, prepare o valor para o nosso cobrador ou entre em contato.\n\n`;
        } else {
            msg = `Olá ${nomeCurto},\n\nEste é um aviso da *CMS Ventures* sobre a sua fatura no valor de *${valorFormatado}* (Vencimento: ${dtFormatada}).${textoAtraso}\n\n`;

            if (pixDados && pixDados.chave) {
                msg += `🏦 *DADOS PARA PAGAMENTO (PIX)*\nFavorecido: ${pixDados.nome}\nInstituição: ${pixDados.banco}\n\nCopie a chave abaixo:\n${pixDados.chave}\n\n⚠️ _Após o pagamento, envie o comprovante por aqui._\n\n`;
            } else {
                msg += `Para realizar o acerto, por favor, entre em contato com o nosso setor de cobrança.\n\n`;
            }
        }

        msg += `🤖 _Esta é uma mensagem automática. Qualquer dúvida ou se precisar de ajuda, basta responder aqui mesmo!_`;
        
        await enviarZap(dev.telefone, msg);
        await supabase.from('logs').insert([{ evento: "Envio Manual de Cobrança", detalhes: `Cobrança enviada via WhatsApp (Parcela ${parcela.numero_parcela}).`, devedor_id: dev.id }]);
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// 8. CRM KANBAN
// ==========================================
app.get('/api/crm', async (req, res) => {
    try {
        const { data, error } = await supabase.from('devedores')
            .select('id, uuid, nome, telefone, valor_total, qtd_parcelas, total_ja_pego, data_vencimento, crm_status, cpf, data_promessa')
            .eq('status', 'ATRASADO')
            .order('data_vencimento', { ascending: true });
        if (error) throw error;
        res.json(data || []);
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/crm/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, data_promessa } = req.body;
        
        let payload = { crm_status: status };
        if (data_promessa) payload.data_promessa = data_promessa;
        
        await supabase.from('devedores').update(payload).eq('id', id);
        
        let detalhesLog = `Etapa da Gestão movida para: ${status}`;
        if (data_promessa) detalhesLog += ` | Prometeu pagar em: ${data_promessa}`;

        await supabase.from('logs').insert([{ evento: "CRM Workflow Atualizado", detalhes: detalhesLog, devedor_id: id }]);
        res.json({ sucesso: true });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// 9. BAIXAS MANUAIS (PREPARADO PARA PARCELAS INDIVIDUAIS)
// ==========================================

// Rota atualizada para receber a Ação da Parcela (tratamentoRestante)
app.post('/api/baixar-parcela', async (req, res) => {
    try {
        const { parcelaId, devedorId, valorPago, dataRecebimento, formaPagamento, tratamentoRestante, observacoes, descontoAplicado } = req.body;
        
        // Aqui chamaremos a nova versão do financeService (que criaremos a seguir).
        // Passamos os dados da parcela diretamente para o motor financeiro resolver a matemática fatiada.
        const resultado = await recalcularDivida({
            parcelaId,
            devedorId,
            valorPago: parseFloat(valorPago) || 0,
            dataRecebimento,
            formaPagamento,
            tratamentoRestante, // 'MANTER_PARCIAL', 'JOGAR_PROXIMA', 'PERDOAR_RESTANTE'
            observacoes,
            descontoAplicado: parseFloat(descontoAplicado) || 0
        });
        
        if (resultado && resultado.erro) {
            return res.status(400).json(resultado);
        }
        
        res.json({ sucesso: true, detalhes: resultado });
    } catch (e) {
        console.error("Erro CRÍTICO na rota baixar-parcela:", e);
        res.status(500).json({ erro: "Erro interno no servidor ao processar a baixa financeira da parcela." });
    }
});


// ==========================================
// 10. CADASTRO MANUAL (Ficha Branca) - GERA PARCELAS
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
                url_casa: uC,
                indicado_por: d.indicado_por || 'DIRETO'
            };

        if (!d.is_precadastro) {
            db.valor_emprestado = limparMoeda(d.valor_emprestado); 
            db.valor_total = limparMoeda(d.valor_total);
            // Salva apenas como histórico na tabela pai
            db.data_vencimento = new Date(d.data_vencimento + 'T12:00:00Z').toISOString().split('T')[0];
            db.frequencia = d.frequencia; 
            db.qtd_parcelas = Math.max(1, parseInt(d.qtd_parcelas) || 1);
            
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
            
            // --- GERA AS PARCELAS ---
            const arrayParcelas = gerarArrayDeParcelas(dId, db.valor_total, db.qtd_parcelas, db.frequencia);
            // Ajusta a data da primeira parcela para a data que o operador escolheu manualmente
            const msDif = new Date(db.data_vencimento + 'T12:00:00Z') - new Date(arrayParcelas[0].data_vencimento + 'T12:00:00Z');
            arrayParcelas.forEach(p => {
                let novaData = new Date(p.data_vencimento + 'T12:00:00Z');
                novaData.setTime(novaData.getTime() + msDif);
                p.data_vencimento = novaData.toISOString().split('T')[0];
            });
            await supabase.from('parcelas').insert(arrayParcelas);
            // ------------------------

            await supabase.from('logs').insert([{ evento: 'Empréstimo Liberado', detalhes: `Lançado Manualmente pela Administração.`, devedor_id: dId, valor_fluxo: -Math.abs(db.valor_emprestado) }]);
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

// ==========================================
// 11. LISTA NEGRA E CONFIGURAÇÕES
// ==========================================
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
    try { await supabase.from('lista_negra').insert([{ cpf: req.body.cpf, motivo: req.body.motivo }]); await supabase.from('logs').insert([{ evento: "Bloqueio na Lista Negra", detalhes: `CPF ${req.body.cpf} embargado por segurança.` }]); res.json({ sucesso: true }); } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/lista-negra/:cpf', async (req, res) => {
    try { await supabase.from('lista_negra').delete().eq('cpf', req.params.cpf); res.json({ sucesso: true }); } catch(e) { res.status(500).json({ erro: e.message }); }
});


app.post('/api/config', async (req, res) => {
    try { for (const c of req.body.configs) { await supabase.from('config').upsert({ chave: c.chave, valor: c.valor }); } res.json({ sucesso: true }); } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/logs-auditoria', async (req, res) => { 
    try { const { data } = await supabase.from('logs').select('*, devedores(nome)').order('created_at', { ascending: false }).limit(300); res.json(data || []); } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// 12. MATEMÁTICA DE LUCRO (DRE)
// ==========================================
app.post('/api/relatorio-periodo', async (req, res) => {
    try {
        const dtInicio = req.body.dataInicio || req.body.inicio || new Date().toISOString().split('T')[0];
        const dtFim = req.body.dataFim || req.body.fim || new Date().toISOString().split('T')[0];

        const inicio = dtInicio.includes('T') ? new Date(dtInicio).toISOString() : new Date(`${dtInicio}T00:00:00-03:00`).toISOString(); 
        const fim = dtFim.includes('T') ? new Date(dtFim).toISOString() : new Date(`${dtFim}T23:59:59-03:00`).toISOString();

        const { data: logs, error } = await supabase.from('logs')
            .select('valor_fluxo, valor_capital, valor_juros, evento, detalhes, created_at, devedor_id, devedores(nome)')
            .gte('created_at', inicio)
            .lte('created_at', fim)
            .order('created_at', { ascending: false });
            
        if (error) throw error;

        let totalEmprestado = 0; 
        let totalRecebido = 0; 
        let totalDespesas = 0; 
        let jurosAtrasoGerado = 0; 
        let jurosMensalidadeFix = 0; 
        let qtdCadastros = 0; 
        let qtdQuitados = 0;

        (logs || []).forEach(log => {
            const v = Number(log.valor_fluxo) || 0; 
            const ev = log.evento || "";
            
            if (ev === 'Empréstimo Liberado' || (ev.includes('Ajuste') && v < 0)) {
                totalEmprestado += Math.abs(v);
                if (ev === 'Empréstimo Liberado') qtdCadastros++;
            }
            else if (ev === 'SAÍDA DE CAIXA') totalDespesas += Math.abs(v);
            else if (v > 0) {
                totalRecebido += v;
                jurosMensalidadeFix += Number(log.valor_juros) || 0;
                if (ev === 'Quitação Total') qtdQuitados++;
            }
            
            if (ev.includes('Juros de Atraso')) {
                const match = (log.detalhes || "").match(/R\$ ([\d.,]+)/);
                if (match) jurosAtrasoGerado += limparMoeda(match[1]);
            }
        });

        const { data: parcelasAtrasadas } = await supabase.from('parcelas').select('data_vencimento').eq('status', 'ATRASADO');
        let diasAtrasados = 0; 
        const hojeObj = new Date(); hojeObj.setHours(0,0,0,0);
        
        (parcelasAtrasadas || []).forEach(d => {
            const dt = new Date(d.data_vencimento + 'T12:00:00Z');
            if (dt < hojeObj) diasAtrasados += Math.floor((hojeObj - dt) / (1000 * 60 * 60 * 24));
        });

        const lucroLiquidoReal = jurosMensalidadeFix + jurosAtrasoGerado - totalDespesas;
        const { data: garantiasAtivas } = await supabase.from('garantias').select('valor_estimado').eq('status', 'ATIVO');
        const totalGarantias = (garantiasAtivas || []).reduce((acc, g) => acc + (parseFloat(g.valor_estimado) || 0), 0);

        res.json({ 
            totalEmprestado, totalRecebido, totalDespesas,
            lucro: lucroLiquidoReal, jurosAtrasoGerado, jurosMensalidade: jurosMensalidadeFix,
            qtdCadastros, qtdQuitados, diasAtrasados, totalGarantias,
            movimentacoes: (logs || []).slice(0, 1500)
        });
    } catch (e) { 
        res.json({ totalEmprestado: 0, totalRecebido: 0, totalDespesas: 0, lucro: 0, totalGarantias: 0, movimentacoes: [] }); 
    }
});

// ==========================================
// 🚨 CRON JOB DE AUTOMAÇÃO (ATUALIZADO PARA PARCELAS)
// ==========================================
let cronAtrasosRodando = false; 

cron.schedule('0 * * * *', async () => {
    if (cronAtrasosRodando) return;
    cronAtrasosRodando = true;
    try {
        const { data: configMulta } = await supabase.from('config').select('valor').eq('chave', 'multa_diaria').maybeSingle();
        const taxaDiariaPercentual = configMulta?.valor ? parseFloat(configMulta.valor) : 2.0;
        const taxaMultaDec = taxaDiariaPercentual / 100;

        const momentoBRT = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        momentoBRT.setHours(0,0,0,0);
        const dataHojeStr = momentoBRT.toISOString().split('T')[0];

        const { data: configPixData } = await supabase.from('config').select('valor').eq('chave', 'pix_avancado').maybeSingle();
        const configPixString = configPixData ? configPixData.valor : null;

        let runAtraso = true;
        let lastId = 0; 

        while (runAtraso) {
            // Busca PARCELAS (não o devedor inteiro)
            const { data: emAtraso, error } = await supabase
                .from('parcelas')
                .select('*, devedores(nome, telefone, isento_multa, status)')
                .in('status', ['PENDENTE', 'PARCIAL', 'ATRASADO'])
                .lt('data_vencimento', dataHojeStr)
                .gt('id', lastId)
                .order('id', { ascending: true })
                .limit(500);

            if (error || !emAtraso || emAtraso.length === 0) break;
            lastId = emAtraso[emAtraso.length - 1].id;

            for (const parc of emAtraso) {
                try {
                    const dev = parc.devedores;
                    // Ignora parcelas de contratos que já sofreram calote ou foram cancelados
                    if (['CALOTE', 'CANCELADO', 'QUITADO'].includes(dev.status)) continue;

                    const dtVenc = new Date(parc.data_vencimento + 'T12:00:00Z');
                    dtVenc.setHours(0,0,0,0);
                    const totalDiasAtraso = Math.floor((momentoBRT - dtVenc) / (1000 * 60 * 60 * 24));
                    if (totalDiasAtraso > 365) continue; 

                    let valorRestanteParcela = parseFloat(parc.valor_atual) - parseFloat(parc.valor_pago || 0);
                    let cobrouJurosAgora = false;
                    let novoValorAtualParcela = parseFloat(parc.valor_atual) || 0;
                    let valorMultaDeHoje = 0;

                    // Verifica uma data fictícia de 'ultima_cobranca' que guardaremos em observacoes para não criar nova coluna agora, ou usamos a lógica de apenas aplicar se for um novo dia.
                    // Para simplificar, faremos o controle pelo log de hoje (O RPC já protege contra duplicidade de LOG no mesmo dia).
                    
                    if (!dev.isento_multa && totalDiasAtraso > 0 && valorRestanteParcela > 0) {
                        // Calcula multa em cima do valor original fatiado da parcela
                        const baseCalculo = parseFloat(parc.valor_original) || valorRestanteParcela;
                        valorMultaDeHoje = baseCalculo * taxaMultaDec;
                        novoValorAtualParcela += valorMultaDeHoje;
                        cobrouJurosAgora = true;
                    }

                    if (cobrouJurosAgora) {
                        // Atualiza a parcela
                        await supabase.from('parcelas').update({ 
                            valor_atual: novoValorAtualParcela, 
                            status: 'ATRASADO'
                        }).eq('id', parc.id);

                        // Registra o log no Devedor
                        await supabase.from('logs').insert([{ 
                            evento: `Juros de Atraso (${taxaDiariaPercentual.toFixed(1)}%/dia)`, 
                            detalhes: `Parcela ${parc.numero_parcela} atrasada. Multa: R$ ${valorMultaDeHoje.toFixed(2)}.`, 
                            devedor_id: parc.devedor_id 
                        }]);

                        const pixDaVezAtraso = escolherPixInteligente(configPixString, novoValorAtualParcela - (parc.valor_pago||0));
                        
                        try { await enviarAvisoAtraso(dev.telefone, dev.nome, (novoValorAtualParcela - parc.valor_pago), totalDiasAtraso, pixDaVezAtraso); } catch (zapErr) {}
                        await sleep(3000); 
                    } else if (parc.status !== 'ATRASADO' && valorRestanteParcela > 0) {
                        await supabase.from('parcelas').update({ status: 'ATRASADO' }).eq('id', parc.id);
                    }
                } catch (errLoop) { }
            }
            if (emAtraso.length < 500) runAtraso = false;
        }
    } catch (errGeral) {
    } finally {
        cronAtrasosRodando = false; 
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Plataforma CMS Ventures operando na porta ${PORT}`));