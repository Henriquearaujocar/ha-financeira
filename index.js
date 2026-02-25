require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

// Conexão do Banco via Supabase
const { supabase } = require('./database');

// Importação dos Módulos de Serviços
const { 
    enviarZap, 
    formatarNumero, 
    verificarStatusZapi, 
    enviarLembreteVencimento, 
    enviarAvisoAtraso 
} = require('./services/zapService');

const { recalcularDivida } = require('./services/financeService');
const { fazerUploadNoSupabase } = require('./services/uploadService');
const { gerarLinkCobranca } = require('./services/infinity');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

// ==========================================
// 0. SISTEMA DE AUTENTICAÇÃO E SEGURANÇA (SUPABASE)
// ==========================================

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) return res.status(401).json({ erro: 'E-mail ou senha incorretos (Supabase)' });
        res.json({ token: data.session.access_token, email: data.user?.email });
    } catch (err) {
        res.status(500).json({ erro: 'Erro interno de autenticação.' });
    }
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

    if (rotasPublicas.includes(req.path) || req.path.startsWith('/webhook-infinitepay')) return next();

    const tokenHeader = req.headers['authorization'];
    if (!tokenHeader || !tokenHeader.startsWith('Bearer ')) {
        return res.status(401).json({ erro: 'Acesso Restrito. Faça o Login no Painel.' });
    }

    const token = tokenHeader.split(' ')[1];
    
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) throw new Error("Sessão Inválida");
        req.user = user;
        return next();
    } catch(err) {
        return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
    }
};
app.use(authMiddleware);

app.get('/api/verify-session', (req, res) => {
    res.json({ autenticado: true, email: req.user?.email });
});

// ==========================================
// 1. ROTAS PÚBLICAS E EXTERNAS
// ==========================================

app.get('/status-zapi', async (req, res) => { 
    try { const status = await verificarStatusZapi(); res.json(status); } 
    catch(e) { res.json({ connected: false }); } 
});

app.get('/api/config-publica', async (req, res) => {
    try {
        const { data } = await supabase.from('config').select('*').in('chave', ['valor_minimo', 'juros_unico', 'juros_parcelado']);
        res.json(data || []);
    } catch(e) { res.json([]); }
});

app.post('/upload-foto', async (req, res) => { 
    try { const url = await fazerUploadNoSupabase(req.body.imagem, req.body.nomeArquivo); res.json({ url }); } 
    catch(e) { res.status(500).json({ erro: e.message }); } 
});

app.post('/api/enviar-solicitacao', async (req, res) => {
    try {
        const d = req.body;
        
        const { data: bl } = await supabase.from('lista_negra').select('cpf').eq('cpf', d.cpf).single();
        if(bl) return res.status(403).json({ erro: "CPF bloqueado por restrições internas." });

        const ts = Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        
        const uSelfie = d.url_selfie ? await fazerUploadNoSupabase(d.url_selfie, `${d.cpf}_selfie_${ts}.jpg`) : null;
        const uFrente = d.url_frente ? await fazerUploadNoSupabase(d.url_frente, `${d.cpf}_frente_${ts}.jpg`) : null;
        const uVerso = d.url_verso ? await fazerUploadNoSupabase(d.url_verso, `${d.cpf}_verso_${ts}.jpg`) : null;
        const uResidencia = d.url_residencia ? await fazerUploadNoSupabase(d.url_residencia, `${d.cpf}_res_${ts}.jpg`) : null;
        const uCasa = d.url_casa ? await fazerUploadNoSupabase(d.url_casa, `${d.cpf}_casa_${ts}.jpg`) : null;

        const { error } = await supabase.from('solicitacoes').insert([{
            nome: d.nome, cpf: d.cpf, whatsapp: d.whatsapp, valor: d.valor,
            tipo_plano: d.tipo_plano || '30DIAS', frequencia: d.frequencia || 'MENSAL',
            qtd_parcelas: d.qtd_parcelas || 1, indicado_por: d.indicado_por || 'DIRETO',
            url_selfie: uSelfie, url_frente: uFrente, url_verso: uVerso,
            url_residencia: uResidencia, url_casa: uCasa,
            referencia1_nome: d.referencia1_nome, referencia1_tel: d.referencia1_tel,
            referencia2_nome: d.referencia2_nome || 'N/A', referencia2_tel: d.referencia2_tel || 'N/A',
            latitude: d.latitude, longitude: d.longitude, status: 'PENDENTE'
        }]);

        if (error) throw error;
        enviarZap(process.env.ADMIN_WHATSAPP, `🚀 Nova Solicitação na CMS Ventures: ${d.nome} - R$ ${d.valor}`);
        res.status(200).json({ mensagem: "Solicitação recebida com sucesso!" });
    } catch (err) { res.status(500).json({ erro: "Erro interno no servidor.", details: err.message }); }
});

app.post('/validar-extrato', async (req, res) => { 
    try { 
        let query = supabase.from('devedores').select('*').eq('uuid', req.body.id);
        if (req.body.cpf) { query = query.eq('cpf', req.body.cpf.replace(/\D/g, '')); }
        const { data: dev, error } = await query.single();
        if(error || !dev) return res.status(404).json({ erro: "Extrato não encontrado." }); 
        res.json(dev); 
    } catch(e) { res.status(500).json({ erro: e.message }); } 
});

app.post('/cliente-aceitou', async (req, res) => { 
    try { 
        const { data: dev } = await supabase.from('devedores').select('*').eq('uuid', req.body.id).single();
        if (!dev) throw new Error("Não encontrado");
        await supabase.from('devedores').update({ status: 'ABERTO' }).eq('id', dev.id);
        
        await supabase.from('solicitacoes').update({ status: 'ASSINADO' }).eq('cpf', dev.cpf).eq('status', 'APROVADO_CP');

        await supabase.from('logs').insert([{ evento: "Assinatura Digital", detalhes: "Termos e Contra-Proposta aceitos pelo cliente. Contrato Ativado.", devedor_id: dev.id }]); 
        res.json({ status: 'Assinado' }); 
    } catch(e) { res.status(500).json({ erro: e.message }); } 
});

app.post('/cliente-gerar-pagamento', async (req, res) => { 
    try { 
        let { data: dev } = await supabase.from('devedores').select('*').eq('id', req.body.id).single();
        if(!dev) {
            const { data } = await supabase.from('devedores').select('*').eq('uuid', req.body.id).single();
            dev = data;
        }
        const link = await gerarLinkCobranca(dev, parseFloat(req.body.valorParaPagar)); 
        res.json({ checkout_url: link }); 
    } catch(e) { res.status(500).json({ erro: e.message }); } 
});

app.post('/webhook-infinitepay/:token', async (req, res) => {
    try {
        const tokenSecreto = process.env.WEBHOOK_SECRET || "cms_seguro_2024";
        if (req.params.token !== tokenSecreto) return res.status(403).send('Acesso Negado');

        const payload = req.body;
        res.status(200).send('OK'); 
        
        const devUuid = payload.order_nsu; 
        const valorReais = (payload.paid_amount || payload.amount) / 100;

        if (devUuid && valorReais > 0) {
            const { data: dev } = await supabase.from('devedores').select('*').eq('uuid', devUuid).single();
            if (dev) {
                const resultadoRecalculo = await recalcularDivida(dev.id, valorReais);
                await supabase.from('logs').insert([{ 
                    evento: "Notificação InfinitePay", 
                    detalhes: `Sistema validou pagamento seguro de R$ ${valorReais.toFixed(2)}. Status: ${resultadoRecalculo.status} (Automático)`, 
                    devedor_id: dev.id 
                }]);
            }
        }
    } catch(e) { console.error("❌ Erro no Webhook IP:", e); }
});

// ==========================================
// 2. DASHBOARD E CAIXA
// ==========================================

app.get('/api/dashboard', async (req, res) => {
    try {
        const dataHojeStr = new Date(new Date().setHours(0,0,0,0)).toISOString();

        const { data: configs } = await supabase.from('config').select('*');
        let caixaGeral = 50000; 
        configs?.forEach(c => { if (c.chave === 'conf_caixa_total' || c.chave === 'caixa_total') caixaGeral = parseFloat(c.valor) || 0; });

        const { data: devedores } = await supabase.from('devedores').select('*').in('status', ['ABERTO', 'ATRASADO']);
        const { data: recebimentos } = await supabase.from('logs').select('valor_fluxo').gt('valor_fluxo', 0).gte('created_at', dataHojeStr);
        const { data: saidasCaixa } = await supabase.from('logs').select('valor_fluxo').eq('evento', 'SAÍDA DE CAIXA');
        const { data: aportes } = await supabase.from('logs').select('valor_fluxo').eq('evento', 'APORTE DE CAPITAL');

        const totalSaidasCaixa = saidasCaixa?.reduce((acc, l) => acc + Math.abs(parseFloat(l.valor_fluxo) || 0), 0) || 0;
        const totalAportes = aportes?.reduce((acc, l) => acc + (parseFloat(l.valor_fluxo) || 0), 0) || 0;

        let totalAReceber = 0, capitalNaRua = 0, atrasos = 0;
        devedores?.forEach(d => { 
            totalAReceber += parseFloat(d.valor_total) || 0; 
            capitalNaRua += parseFloat(d.valor_emprestado) || 0; 
            if (new Date(d.data_vencimento) < new Date()) atrasos++; 
        });
        
        let recebidoHoje = recebimentos?.reduce((acc, l) => acc + (parseFloat(l.valor_fluxo) || 0), 0) || 0;
        const lucroEstimado = totalAReceber - capitalNaRua;
        const caixaDisponivel = (caixaGeral + totalAportes) - capitalNaRua - totalSaidasCaixa;

        res.json({ totalAReceber, recebidoHoje, pendencias: atrasos, lucroEstimado, capitalNaRua, caixaDisponivel });
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==========================================
// 3. FLUXO DE APROVAÇÃO (CORRIGIDO E BLINDADO)
// ==========================================

app.get('/api/solicitacoes-pendentes', async (req, res) => {
    try {
        const { data } = await supabase.from('solicitacoes').select('*').eq('status', 'PENDENTE').order('created_at', { ascending: false });
        res.json(data || []);
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/aprovar-solicitacao', async (req, res) => {
    const { id, juros, observacao, novoValor, novaFreq, novasParcelas } = req.body;
    
    try {
        const { data: sol, error: errSol } = await supabase.from('solicitacoes').select('*').eq('id', id).single();
        if (errSol || !sol) throw new Error("Solicitação não encontrada no banco de dados.");

        if (sol.status !== 'PENDENTE') {
            return res.status(400).json({ erro: "Esta solicitação já foi aprovada ou rejeitada." });
        }

        const jurosDecimal = (parseFloat(juros) || 30) / 100;
        const valorFinal = novoValor ? parseFloat(novoValor) : (parseFloat(sol.valor) || 0);
        const freqFinal = novaFreq || sol.frequencia || 'MENSAL';
        const parcelasFinais = novasParcelas ? parseInt(novasParcelas) : (parseInt(sol.qtd_parcelas) || 1);
        const valorTotal = valorFinal * (1 + jurosDecimal);
        
        let dtVencimento = new Date(); 
        dtVencimento.setDate(dtVencimento.getDate() + (freqFinal === 'SEMANAL' ? 7 : 30));

        const cpfLimpo = String(sol.cpf || '').replace(/\D/g, '');

        // 1. Insere o Devedor
        const { data: dev, error: devErr } = await supabase.from('devedores').insert([{
            nome: sol.nome, cpf: cpfLimpo, telefone: sol.whatsapp || sol.telefone || 'N/A', 
            valor_emprestado: valorFinal, valor_total: valorTotal,
            frequencia: freqFinal, qtd_parcelas: parcelasFinais,
            status: 'APROVADO_AGUARDANDO_ACEITE',
            data_vencimento: dtVencimento.toISOString().split('T')[0],
            url_selfie: sol.url_selfie, url_frente: sol.url_frente, url_verso: sol.url_verso, 
            url_residencia: sol.url_residencia, url_casa: sol.url_casa,
            referencia1_nome: sol.referencia1_nome, referencia1_tel: sol.referencia1_tel, 
            indicado_por: sol.indicado_por, pago: false
        }]).select().single();
        
        if (devErr) throw new Error(`Falha no banco ao gerar contrato: ${devErr.message}`);

        // 2. 🚨 CORREÇÃO VITAL: Atualiza a Solicitação APENAS com campos que existem no SQL!
        // Removido "observacoes", pois a sua tabela "solicitacoes" não possui essa coluna
        const { error: updErr } = await supabase.from('solicitacoes').update({ status: 'APROVADO_CP' }).eq('id', id);
        if (updErr) throw new Error(`Erro ao dar baixa na ficha: ${updErr.message}`);
        
        // 3. Grava a Observação diretamente nos LOGS para nunca se perder
        await supabase.from('logs').insert([{ 
            evento: 'Aprovação / Contra-Proposta', 
            detalhes: `Aprovado R$ ${valorFinal.toFixed(2)} em ${parcelasFinais}x (${freqFinal}). Obs: ${observacao || 'Nenhuma'}. (Gestor: ${req.user?.email || 'Desconhecido'})`, 
            devedor_id: dev.id 
        }]);

        const linkAceite = `${APP_URL}/aceitar.html?id=${dev.uuid}`;
        let msgWhatsApp = `🎉 Olá ${dev.nome.split(' ')[0]}!\nSeu crédito foi APROVADO na CMS Ventures!\nPara assinar o contrato digital e receber o PIX, acesse:\n🔗 ${linkAceite}`;
        if (dev.telefone && dev.telefone !== 'N/A') enviarZap(dev.telefone, msgWhatsApp).catch(e => console.error(e));

        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/rejeitar-solicitacao', async (req, res) => {
    try {
        // 🚨 CORREÇÃO: Não tenta atualizar a coluna inexistente "observacoes" na tabela
        const { error: rejErr } = await supabase.from('solicitacoes').update({ status: 'REJEITADO' }).eq('id', req.body.id);
        if (rejErr) throw new Error(`Falha ao rejeitar no banco: ${rejErr.message}`);
        
        // Regista o motivo da rejeição no Log Administrativo
        await supabase.from('logs').insert([{ 
            evento: "Solicitação Rejeitada", 
            detalhes: `Ficha rejeitada. Motivo: ${req.body.motivo || 'Nenhum motivo informado'}. (Gestor: ${req.user?.email || 'Desconhecido'})` 
        }]);
        
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// 4. RESTANTES ROTAS ADMINISTRATIVAS
// ==========================================

app.get('/api/devedores-ativos', async (req, res) => {
    const { data } = await supabase.from('devedores').select('*').in('status', ['ABERTO', 'ATRASADO', 'APROVADO_AGUARDANDO_ACEITE']).order('data_vencimento', { ascending: true }).limit(500);
    res.json(data || []);
});

app.post('/api/enviar-cobranca-manual', async (req, res) => {
    try {
        const { id } = req.body;
        const { data: dev } = await supabase.from('devedores').select('*').eq('id', id).single();
        if (!dev) throw new Error("Contrato não encontrado");

        const linkPortal = `${APP_URL}/pagar.html?id=${dev.uuid}`;
        const msg = `Olá ${dev.nome.split(' ')[0]},\n\nAqui está o link do seu portal de pagamento para consultar sua fatura e gerar o PIX de forma segura:\n🔗 ${linkPortal}`;

        await enviarZap(dev.telefone, msg);
        
        await supabase.from('logs').insert([{ evento: "Envio Manual de Cobrança", detalhes: `Link de pagamento enviado via WhatsApp. (Gestor: ${req.user?.email})`, devedor_id: dev.id }]);
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/cliente-extrato/:busca', async (req, res) => {
    try {
        const busca = decodeURIComponent(req.params.busca);
        const hasNumbers = /\d/.test(busca);
        let query = supabase.from('devedores').select('*');
        if (hasNumbers) {
            const numbersOnly = busca.replace(/\D/g, '');
            query = query.or(`cpf.eq.${numbersOnly},telefone.ilike.%${numbersOnly}%`);
        } else {
            query = query.ilike('nome', `%${busca}%`);
        }
        
        const { data: clientes, error } = await query;
        if (error || !clientes || clientes.length === 0) return res.status(404).json({ erro: "Cliente não encontrado" });
        
        const clientePrincipal = clientes.find(c => c.status === 'ABERTO' || c.status === 'ATRASADO') || clientes[0];
        const { data: todos_contratos } = await supabase.from('devedores').select('*').eq('cpf', clientePrincipal.cpf);
        const ids = (todos_contratos || []).map(c => c.id);
        const { data: logs } = await supabase.from('logs').select('*').in('devedor_id', ids).order('created_at', { ascending: false }).limit(200);
        
        res.json({ cliente: clientePrincipal, todos_contratos: todos_contratos || clientes, logs: logs || [] });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/editar-contrato', async (req, res) => {
    try {
        const { id, novoVencimento, novoCapital, novoTotal, novaFrequencia } = req.body;
        await supabase.from('devedores').update({ data_vencimento: novoVencimento, valor_emprestado: novoCapital, valor_total: novoTotal, frequencia: novaFrequencia }).eq('id', id);
        await supabase.from('logs').insert([{ evento: "Edição Manual de Contrato", detalhes: `Contrato Modificado. Saldo Atual: R$ ${novoTotal} (Gestor: ${req.user?.email})`, devedor_id: id }]);
        res.json({ sucesso: true });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/baixar-manual', async (req, res) => {
    try { const resRecalculo = await recalcularDivida(req.body.id, req.body.valorPago); res.json(resRecalculo); } 
    catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/migrar-cliente', async (req, res) => {
    const d = req.body;
    try {
        const uS = d.img_selfie ? await fazerUploadNoSupabase(d.img_selfie, `${d.cpf}_selfie_mig.jpg`) : null;
        const uF = d.img_frente ? await fazerUploadNoSupabase(d.img_frente, `${d.cpf}_frente_mig.jpg`) : null;
        const uV = d.img_verso ? await fazerUploadNoSupabase(d.img_verso, `${d.cpf}_verso_mig.jpg`) : null;
        const uR = d.img_residencia ? await fazerUploadNoSupabase(d.img_residencia, `${d.cpf}_res_mig.jpg`) : null;
        const uC = d.img_casa ? await fazerUploadNoSupabase(d.img_casa, `${d.cpf}_casa_mig.jpg`) : null;

        const qtdParcelasFinais = d.qtd_parcelas > 0 ? d.qtd_parcelas : 1;

        const { data: dev, error } = await supabase.from('devedores').insert([{
            nome: d.nome, cpf: d.cpf, telefone: d.whatsapp, 
            valor_emprestado: d.valor_emprestado, valor_total: d.valor_total,
            data_vencimento: d.data_vencimento, frequencia: d.frequencia, 
            qtd_parcelas: qtdParcelasFinais, status: 'ABERTO', 
            url_selfie: uS, url_frente: uF, url_verso: uV, url_residencia: uR, url_casa: uC
        }]).select().single();

        if (error) {
            if (error.code === '23505') throw new Error("CPF já cadastrado na base de devedores.");
            throw new Error(`Erro no banco: ${error.message}`);
        }
        
        await supabase.from('logs').insert([{ evento: 'Migração/Cadastro Rápido', detalhes: `Cliente inserido via painel. ${qtdParcelasFinais}x ${d.frequencia}. (Gestor: ${req.user?.email})`, devedor_id: dev.id }]);

        if (d.juros_pagos && d.juros_pagos > 0) {
            await supabase.from('logs').insert([{ evento: 'Recebimento (Migração)', detalhes: `Valor referente a juros/multas já pagos em sistema anterior. (Gestor: ${req.user?.email})`, valor_fluxo: d.juros_pagos, devedor_id: dev.id }]);
        }
        if (d.capital_pago && d.capital_pago > 0) {
            await supabase.from('logs').insert([{ evento: 'Recebimento (Migração)', detalhes: `Valor referente a capital/dívida já abatida em sistema anterior. (Gestor: ${req.user?.email})`, valor_fluxo: d.capital_pago, devedor_id: dev.id }]);
        }

        res.json({ sucesso: true });
    } catch (error) { res.status(500).json({ erro: error.message }); }
});

app.post('/api/saida-caixa', async (req, res) => {
    try {
        await supabase.from('logs').insert([{ evento: "SAÍDA DE CAIXA", detalhes: `${req.body.motivo} (Gestor: ${req.user?.email})`, valor_fluxo: -Math.abs(req.body.valor) }]);
        res.json({ sucesso: true });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/extrato-caixa', async (req, res) => {
    const { data } = await supabase.from('logs').select('*').eq('evento', 'SAÍDA DE CAIXA').order('created_at', { ascending: false }).limit(50);
    res.json(data || []);
});

app.get('/api/logs-auditoria', async (req, res) => {
    const { data } = await supabase.from('logs').select('*').order('created_at', { ascending: false }).limit(300);
    res.json(data || []);
});

app.get('/api/lista-negra', async (req, res) => {
    const { data } = await supabase.from('lista_negra').select('*').order('created_at', { ascending: false });
    res.json(data || []);
});

app.post('/api/lista-negra', async (req, res) => {
    try {
        await supabase.from('lista_negra').insert([{ cpf: req.body.cpf, motivo: req.body.motivo }]);
        await supabase.from('logs').insert([{ evento: "Bloqueio na Lista Negra", detalhes: `CPF ${req.body.cpf} bloqueado. (Gestor: ${req.user?.email})` }]);
        res.json({ sucesso: true });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/lista-negra/:cpf', async (req, res) => {
    await supabase.from('lista_negra').delete().eq('cpf', req.params.cpf);
    res.json({ sucesso: true });
});

app.get('/api/promotores', async (req, res) => {
    const { data } = await supabase.from('promotores').select('*').order('created_at', { ascending: false });
    res.json(data || []);
});

app.post('/api/adicionar-promotor', async (req, res) => {
    try {
        await supabase.from('promotores').insert([{ nome: req.body.nome, cpf: req.body.cpf }]);
        await supabase.from('logs').insert([{ evento: "Novo Promotor", detalhes: `Promotor ${req.body.nome} adicionado. (Gestor: ${req.user?.email})` }]);
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/config', async (req, res) => {
    const { data } = await supabase.from('config').select('*');
    res.json(data || []);
});

app.post('/api/config', async (req, res) => {
    try {
        for (const c of req.body.configs) { await supabase.from('config').upsert({ chave: c.chave, valor: c.valor }); }
        await supabase.from('logs').insert([{ evento: "Alteração de Configurações", detalhes: `Os parâmetros financeiros foram modificados. (Gestor: ${req.user?.email})` }]);
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// 5. RELATÓRIO
// ==========================================

app.post('/relatorio-periodo', async (req, res) => {
    try {
        const { dataInicio, dataFim } = req.body;
        const inicio = `${dataInicio}T00:00:00.000Z`; const fim = `${dataFim}T23:59:59.999Z`;

        const { data: devedores } = await supabase.from('devedores').select('valor_emprestado').gte('created_at', inicio).lte('created_at', fim);
        const totalEmprestado = devedores ? devedores.reduce((a, b) => a + Number(b.valor_emprestado), 0) : 0;
        
        const { data: logsRecebidos } = await supabase.from('logs').select('valor_fluxo').in('evento', ['Recebimento', 'Liquidação Total', 'Quitação Total', 'Rolagem de Contrato', 'Pagamento de Parcela', 'Recebimento (Migração)']).gte('created_at', inicio).lte('created_at', fim);
        const totalRecebido = logsRecebidos ? logsRecebidos.reduce((a, b) => a + Number(b.valor_fluxo), 0) : 0;
        
        const { data: logsAtraso } = await supabase.from('logs').select('detalhes').eq('evento', 'Juros de Atraso (3%)').gte('created_at', inicio).lte('created_at', fim);
        const jurosAtrasoGerado = logsAtraso ? logsAtraso.reduce((acc, log) => { const match = log.detalhes.match(/R\$ ([\d.]+)/); return acc + (match ? parseFloat(match[1]) : 0); }, 0) : 0;

        const { count: qtdAtrasados } = await supabase.from('devedores').select('*', { count: 'exact', head: true }).eq('pago', false).gte('data_vencimento', dataInicio).lte('data_vencimento', dataFim).lt('data_vencimento', new Date().toISOString().split('T')[0]);
        const { count: qtdEmprestimos } = await supabase.from('devedores').select('*', { count: 'exact', head: true }).gte('created_at', inicio).lte('created_at', fim);
        const { count: qtdBloqueados } = await supabase.from('lista_negra').select('*', { count: 'exact', head: true }).gte('created_at', inicio).lte('created_at', fim);

        res.json({ totalEmprestado, totalRecebido, jurosAtrasoGerado, qtdAtrasados, qtdEmprestimos, qtdBloqueados });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// 6. ROBÔ DE AUTOMAÇÃO
// ==========================================

cron.schedule('0 8 * * *', async () => {
    console.log("⏰ [CRON] Executando Cobrança Automática e Multas...");
    try {
        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
        const dataApoio = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        const dataHojeSimples = formatter.format(dataApoio);
        
        const objAmanha = new Date(dataApoio);
        objAmanha.setDate(objAmanha.getDate() + 1);
        const dataAmanhaSimples = formatter.format(objAmanha);
        
        const { data: devedoresParaLembrar } = await supabase.from('devedores').select('*')
            .eq('pago', false).eq('status', 'ABERTO')
            .in('data_vencimento', [dataHojeSimples, dataAmanhaSimples]);
        
        for (const dev of (devedoresParaLembrar || [])) {
            const linkPortal = `${APP_URL}/pagar.html?id=${dev.uuid}`;
            await enviarLembreteVencimento(dev.telefone, dev.nome, dev.valor_total, dev.data_vencimento, linkPortal);
        }

        const { data: devedoresEmAtraso } = await supabase.from('devedores').select('*')
            .eq('pago', false).eq('status', 'ABERTO')
            .lt('data_vencimento', dataHojeSimples)
            .or(`ultima_cobranca_atraso.neq.${dataHojeSimples},ultima_cobranca_atraso.is.null`);
        
        const { data: confMulta } = await supabase.from('config').select('valor').eq('chave', 'multa_diaria').single();
        const taxaMultaDec = (parseFloat(confMulta?.valor) || 3) / 100;
        
        for (const dev of (devedoresEmAtraso || [])) {
            const venc = new Date(dev.data_vencimento + 'T00:00:00-03:00');
            const diasAtraso = Math.floor((dataApoio - venc) / (1000 * 60 * 60 * 24));
            
            const multaDiaria = Math.round((parseFloat(dev.valor_total) * taxaMultaDec) * 100) / 100; 
            const novoValor = Math.round((parseFloat(dev.valor_total) + multaDiaria) * 100) / 100;

            await supabase.from('devedores').update({ 
                valor_total: novoValor, 
                ultima_cobranca_atraso: dataHojeSimples 
            }).eq('id', dev.id);
            
            await supabase.from('logs').insert([{ 
                evento: `Juros de Atraso (${(taxaMultaDec*100).toFixed(1)}%)`, 
                detalhes: `Aplicada multa de R$ ${multaDiaria.toFixed(2)} pelo ${diasAtraso}º dia de atraso. Saldo: R$ ${novoValor.toFixed(2)}`, 
                devedor_id: dev.id 
            }]);

            const linkPortal = `${APP_URL}/pagar.html?id=${dev.uuid}`;
            await enviarAvisoAtraso(dev.telefone, dev.nome, novoValor, diasAtraso, linkPortal);
        }
    } catch(e) { console.error("❌ Erro CRON:", e); }
}, { timezone: "America/Sao_Paulo" });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Elite Master Rodando Seguro na porta ${PORT}`));