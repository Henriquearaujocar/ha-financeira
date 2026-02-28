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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

const processandoWebhooks = new Set();
const travasAtivasPainel = new Set();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const limparMoeda = (valor) => {
    if (valor === null || valor === undefined || valor === '') return 0;
    if (typeof valor === 'number') return valor;
    let str = String(valor).trim();
    if (str.includes(',')) {
        str = str.replace(/\./g, '').replace(',', '.');
    }
    const num = parseFloat(str);
    return isNaN(num) ? 0 : num;
};

const isDataValida = (dataStr) => {
    if (!dataStr) return false;
    const d = new Date(dataStr);
    return !isNaN(d.getTime());
};

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) return res.status(401).json({ erro: 'E-mail ou palavra-passe incorretos.' });
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
    if (!tokenHeader || !tokenHeader.startsWith('Bearer ')) return res.status(401).json({ erro: 'Acesso Restrito. Inicie sessão no Painel.' });
    
    const token = tokenHeader.split(' ')[1];
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) throw new Error("Sessão Inválida");
        req.user = user;
        return next();
    } catch(err) {
        return res.status(401).json({ erro: 'Sessão expirada. Inicie sessão novamente.' });
    }
};
app.use(authMiddleware);

app.get('/api/verify-session', (req, res) => {
    res.json({ autenticado: true, email: req.user?.email });
});

app.get('/status-zapi', async (req, res) => { 
    try { const status = await verificarStatusZapi(); res.json(status); } catch(e) { res.json({ connected: false }); } 
});

app.get('/api/config-publica', async (req, res) => {
    try {
        const { data } = await supabase.from('config').select('*').in('chave', ['valor_minimo', 'juros_unico', 'juros_parcelado']);
        res.json(data || []);
    } catch(e) { res.json([]); }
});

app.get('/api/buscar-cliente-publico/:cpf', async (req, res) => {
    try {
        const cpf = req.params.cpf.replace(/\D/g, '');
        const { data, error } = await supabase.from('devedores').select('nome, telefone, url_frente, url_verso, url_casa').eq('cpf', cpf).limit(1);
        if (error || !data || data.length === 0) return res.status(404).json({ erro: "Cliente não encontrado." });
        res.json(data[0]);
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/enviar-solicitacao', async (req, res) => {
    try {
        const d = req.body;
        
        // 🚨 VACINA 1: PRÉ-VALIDAÇÃO (Protege o Storage de Encher com Lixo)
        const { data: bl } = await supabase.from('lista_negra').select('cpf').eq('cpf', d.cpf).single();
        if(bl) return res.status(403).json({ erro: "CPF bloqueado por restrições internas." });

        const { data: solPendente } = await supabase.from('solicitacoes').select('id').eq('cpf', d.cpf).eq('status', 'PENDENTE').maybeSingle();
        if (solPendente) return res.status(429).json({ erro: "Você já possui uma solicitação em análise. Aguarde o nosso contacto." });

        const ts = Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        let oldFrente = null, oldVerso = null, oldCasa = null;

        if (d.is_recorrente) {
            const { data: dev } = await supabase.from('devedores').select('url_frente, url_verso, url_casa').eq('cpf', d.cpf).limit(1);
            if (dev && dev.length > 0) {
                oldFrente = dev[0].url_frente; oldVerso = dev[0].url_verso; oldCasa = dev[0].url_casa;
            }
        }

        // Uploads SÓ ACONTECEM se o cliente não tiver sido bloqueado antes!
        const uSelfie = d.url_selfie ? await fazerUploadNoSupabase(d.url_selfie, `${d.cpf}_selfie_${ts}.jpg`) : null;
        const uResidencia = d.url_residencia ? await fazerUploadNoSupabase(d.url_residencia, `${d.cpf}_res_${ts}.jpg`) : null;
        const uFrente = d.url_frente ? await fazerUploadNoSupabase(d.url_frente, `${d.cpf}_frente_${ts}.jpg`) : oldFrente;
        const uVerso = d.url_verso ? await fazerUploadNoSupabase(d.url_verso, `${d.cpf}_verso_${ts}.jpg`) : oldVerso;
        const uCasa = d.url_casa ? await fazerUploadNoSupabase(d.url_casa, `${d.cpf}_casa_${ts}.jpg`) : oldCasa;

        const parcelasMatematicas = Math.max(1, d.tipo_plano === '30DIAS' ? 1 : parseInt(d.qtd_parcelas));

        const { error } = await supabase.from('solicitacoes').insert([{
            nome: d.nome, cpf: d.cpf, whatsapp: d.whatsapp, valor: d.valor,
            tipo_plano: d.tipo_plano || '30DIAS', frequencia: d.frequencia || 'MENSAL',
            qtd_parcelas: parcelasMatematicas, indicado_por: d.indicado_por || 'DIRETO',
            url_selfie: uSelfie, url_frente: uFrente, url_verso: uVerso, url_residencia: uResidencia, url_casa: uCasa,
            referencia1_nome: d.referencia1_nome, referencia1_tel: d.referencia1_tel,
            referencia2_nome: d.referencia2_nome || 'N/A', referencia2_tel: d.referencia2_tel || 'N/A',
            status: 'PENDENTE'
        }]);

        if (error) throw error;
        
        // Disparo assíncrono mantido. Não impacta o storage se falhar, apenas o alerta do admin.
        enviarZap(process.env.ADMIN_WHATSAPP, `🚀 Nova Solicitação na CMS Ventures:\n👤 ${d.nome}\n💰 R$ ${d.valor}\n🔄 Recorrente: ${d.is_recorrente ? 'SIM' : 'NÃO'}`).catch(e=>console.log(e));
        
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
        
        if (dev.status === 'ABERTO' || dev.status === 'ATRASADO') {
            return res.json({ status: 'Assinado' });
        }
        
        const momentBRT = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        const diasParaSomar = dev.frequencia === 'SEMANAL' ? 7 : 30;
        momentBRT.setDate(momentBRT.getDate() + diasParaSomar);
        const dataVencimentoReal = `${momentBRT.getFullYear()}-${String(momentBRT.getMonth() + 1).padStart(2, '0')}-${String(momentBRT.getDate()).padStart(2, '0')}`;

        await supabase.from('devedores').update({ 
            status: 'ABERTO',
            data_vencimento: dataVencimentoReal
        }).eq('id', dev.id);
        
        await supabase.from('solicitacoes').update({ status: 'ASSINADO' }).eq('cpf', dev.cpf).eq('status', 'APROVADO_CP');
        await supabase.from('logs').insert([{ evento: "Assinatura Digital", detalhes: `Contrato ativado e relógio iniciado. Vencimento ajustado para ${dataVencimentoReal}.`, devedor_id: dev.id }]); 
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
        const statusPgto = (payload.status || payload.state || '').toLowerCase();
        
        if (!statusPgto || !['approved', 'paid', 'settled', 'authorized'].includes(statusPgto)) {
            return res.status(200).send('OK - Status ignorado');
        }

        const devUuid = payload.order_nsu || payload.metadata?.order_nsu || payload.metadata?.custom_id; 
        const valorReais = (payload.paid_amount || payload.amount) / 100;
        const transactionId = payload.id; 

        if (devUuid && valorReais > 0 && transactionId) {
            if (processandoWebhooks.has(transactionId)) {
                return res.status(200).send('OK - Em processamento');
            }
            processandoWebhooks.add(transactionId);

            try {
                const { data: dev } = await supabase.from('devedores').select('*').eq('uuid', devUuid).single();
                
                if (dev) {
                    const resultadoRecalculo = await recalcularDivida(dev.id, valorReais, transactionId);
                    
                    if (resultadoRecalculo.erro) {
                        if (resultadoRecalculo.erro === "Webhook Duplicado - Transação Abortada.") {
                             return res.status(200).send('OK - Já Processado na DB Físicamente');
                        }
                        throw new Error(resultadoRecalculo.erro);
                    }
                }
                res.status(200).send('OK');
            } finally {
                setTimeout(() => processandoWebhooks.delete(transactionId), 5000);
            }
        } else {
            res.status(400).send('Bad Request');
        }
    } catch(e) { 
        console.error("❌ Erro Webhook IP:", e); 
        if (!res.headersSent) res.status(500).send('Falha Interna');
    }
});

app.get('/api/dashboard', async (req, res) => {
    try {
        const momentBRT = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        const y = momentBRT.getFullYear();
        const m = String(momentBRT.getMonth() + 1).padStart(2, '0');
        const d = String(momentBRT.getDate()).padStart(2, '0');
        const inicioDiaBRTUTC = new Date(`${y}-${m}-${d}T00:00:00-03:00`).toISOString();
        const dataHojeSimples = `${y}-${m}-${d}`;

        const { data: configs } = await supabase.from('config').select('*');
        let caixaGeral = 50000; 
        configs?.forEach(c => { if (c.chave === 'conf_caixa_total' || c.chave === 'caixa_total') caixaGeral = parseFloat(c.valor) || 0; });

        let totalAReceber = 0; let capitalNaRua = 0; let atrasos = 0;
        let buscarDevedores = true;
        let pDev = 0;
        
        while (buscarDevedores) {
            const { data: devPage, error } = await supabase.from('devedores')
                .select('valor_total, valor_emprestado, data_vencimento')
                .in('status', ['ABERTO', 'ATRASADO'])
                .order('id', { ascending: true })
                .range(pDev, pDev + 999);
                
            if (error || !devPage || devPage.length === 0) { buscarDevedores = false; break; }
            
            devPage.forEach(dev => {
                totalAReceber += parseFloat(dev.valor_total) || 0; 
                capitalNaRua += parseFloat(dev.valor_emprestado) || 0; 
                if (dev.data_vencimento < dataHojeSimples) atrasos++;
            });
            
            if (devPage.length < 1000) buscarDevedores = false;
            pDev += 1000;
        }

        let fluxoLiquidoTotal = 0;
        let recebidoHoje = 0;
        let buscarMais = true;
        let ponteiro = 0;

        while (buscarMais) {
            const { data: logsPage, error } = await supabase.from('logs')
                .select('valor_fluxo, evento, created_at')
                .not('valor_fluxo', 'is', null)
                .not('evento', 'ilike', '%Histórico Antigo%')
                .order('created_at', { ascending: true })
                .order('id', { ascending: true })
                .range(ponteiro, ponteiro + 999);
            
            if (error || !logsPage || logsPage.length === 0) {
                buscarMais = false;
                break;
            }

            logsPage.forEach(l => {
                const v = parseFloat(l.valor_fluxo) || 0;
                fluxoLiquidoTotal += v;
                
                if (v > 0 && l.created_at >= inicioDiaBRTUTC && ['Quitação Total', 'Pagamento de Parcela', 'Rolagem de Contrato', 'Pagamento Parcial (Incompleto)', 'Recebimento', 'Liquidação Total'].includes(l.evento)) {
                    recebidoHoje += v;
                }
            });

            if (logsPage.length < 1000) buscarMais = false;
            ponteiro += 1000;
        }
        
        const caixaDisponivel = caixaGeral + fluxoLiquidoTotal;
        const lucroEstimado = totalAReceber - capitalNaRua;

        res.json({ totalAReceber, recebidoHoje, pendencias: atrasos, lucroEstimado, capitalNaRua, caixaDisponivel });
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/solicitacoes-pendentes', async (req, res) => {
    try {
        const { data } = await supabase.from('solicitacoes').select('*').eq('status', 'PENDENTE').order('created_at', { ascending: false });
        res.json(data || []);
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/aprovar-solicitacao', async (req, res) => {
    const { id, juros, observacao, novoValor, novaFreq, novasParcelas } = req.body;
    
    const lockKey = `aprovar_${id}`;
    if (travasAtivasPainel.has(lockKey)) return res.status(429).json({ erro: "Operação em andamento." });
    travasAtivasPainel.add(lockKey);

    try {
        const { data: sol, error: errSol } = await supabase.from('solicitacoes').select('*').eq('id', id).single();
        if (errSol || !sol) throw new Error("Solicitação não encontrada.");
        if (sol.status !== 'PENDENTE') return res.status(400).json({ erro: "Esta solicitação já foi tratada." });

        const jurosDecimal = (limparMoeda(juros) || 30) / 100;
        const valorFinal = novoValor ? limparMoeda(novoValor) : limparMoeda(sol.valor);
        const freqFinal = novaFreq || sol.frequencia || 'MENSAL';
        
        let parcelasFinais = novasParcelas ? parseInt(novasParcelas) : (parseInt(sol.qtd_parcelas) || 1);
        parcelasFinais = Math.max(1, parcelasFinais);

        const jurosAplicado = parcelasFinais > 1 ? (jurosDecimal * parcelasFinais) : jurosDecimal;
        const valorTotal = valorFinal * (1 + jurosAplicado);
        
        const momentBRT = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        momentBRT.setDate(momentBRT.getDate() + (freqFinal === 'SEMANAL' ? 7 : 30));
        const dtVencimentoProjetado = `${momentBRT.getFullYear()}-${String(momentBRT.getMonth() + 1).padStart(2, '0')}-${String(momentBRT.getDate()).padStart(2, '0')}`;
        
        const cpfLimpo = String(sol.cpf || '').replace(/\D/g, '');

        // 🚨 VACINA 4: Cobertura total de estado de dívidas ativas para barrar duplicidade cega.
        const { data: anyActiveDebt } = await supabase.from('devedores').select('id').eq('cpf', cpfLimpo).in('status', ['ABERTO', 'ATRASADO', 'APROVADO_AGUARDANDO_ACEITE']).limit(1);
        if (anyActiveDebt && anyActiveDebt.length > 0) {
            return res.status(400).json({ erro: "Este cliente já possui um contrato ativo ou aguardando assinatura na base." });
        }

        const { data: existingDevs } = await supabase.from('devedores').select('id, uuid, status').eq('cpf', cpfLimpo).order('created_at', { ascending: false }).limit(1);
        const existingDev = existingDevs && existingDevs.length > 0 ? existingDevs[0] : null;

        let devId;
        let devUuid;
        const telefoneValido = sol.whatsapp || sol.telefone || 'N/A';
        const taxaBaseGuardada = jurosDecimal * 100;

        let payloadDevedor = {
            nome: sol.nome, telefone: telefoneValido, 
            valor_emprestado: valorFinal, valor_total: valorTotal,
            frequencia: freqFinal, qtd_parcelas: parcelasFinais, status: 'APROVADO_AGUARDANDO_ACEITE',
            data_vencimento: dtVencimentoProjetado,
            taxa_juros: taxaBaseGuardada,
            observacoes: observacao || '',
            url_selfie: sol.url_selfie, url_frente: sol.url_frente, url_verso: sol.url_verso, url_residencia: sol.url_residencia, url_casa: sol.url_casa,
            referencia1_nome: sol.referencia1_nome, referencia1_tel: sol.referencia1_tel, indicado_por: sol.indicado_por, pago: false
        };

        if (existingDev) {
            payloadDevedor.created_at = new Date().toISOString(); 
            payloadDevedor.ultima_cobranca_atraso = null;
            const { data: updatedDev, error: updErr } = await supabase.from('devedores').update(payloadDevedor).eq('id', existingDev.id).select().single();
            if (updErr) throw new Error(updErr.message);
            devId = updatedDev.id;
            devUuid = updatedDev.uuid;
        } else {
            payloadDevedor.cpf = cpfLimpo;
            const { data: newDev, error: insErr } = await supabase.from('devedores').insert([payloadDevedor]).select().single();
            if (insErr) throw new Error(insErr.message);
            devId = newDev.id;
            devUuid = newDev.uuid;
        }

        await supabase.from('solicitacoes').update({ status: 'APROVADO_CP', observacoes: observacao }).eq('id', id);
        
        const nomeGestorLog = req.user?.email || 'Sistema (Automático)';

        await supabase.from('logs').insert([{ 
            evento: 'Empréstimo Liberado', 
            detalhes: `Aprovado R$ ${valorFinal.toFixed(2)} em ${parcelasFinais}x (${freqFinal}) a ${taxaBaseGuardada}%. Obs: ${observacao || 'Nenhuma'}. (Gestor: ${nomeGestorLog})`, 
            devedor_id: devId,
            valor_fluxo: -Math.abs(valorFinal) 
        }]);

        const linkAceite = `${APP_URL}/aceitar.html?id=${devUuid}`;
        let msgWhatsApp = `🎉 Olá ${sol.nome.split(' ')[0]}!\nSeu crédito foi APROVADO na CMS Ventures!\nPara assinar o contrato digital e receber o PIX, acesse:\n🔗 ${linkAceite}`;
        
        // 🚨 VACINA 3: Escudo Serverless - Usa AWAIT para garantir envio de WhatsApp antes de matar o servidor
        try {
            await enviarZap(telefoneValido, msgWhatsApp);
        } catch(errZap) {
            console.error("Aviso: Falha ao entregar WhatsApp de aprovação:", errZap.message);
        }

        res.json({ sucesso: true });
    } catch (e) { 
        res.status(500).json({ erro: e.message }); 
    } finally {
        setTimeout(() => travasAtivasPainel.delete(lockKey), 3000);
    }
});

app.post('/api/rejeitar-solicitacao', async (req, res) => {
    try {
        const { data: sol } = await supabase.from('solicitacoes').select('status').eq('id', req.body.id).single();
        if (sol && sol.status === 'ASSINADO') {
            return res.status(400).json({ erro: "Bloqueado: O cliente já assinou este contrato."});
        }
        await supabase.from('solicitacoes').update({ status: 'REJEITADO', observacoes: req.body.motivo }).eq('id', req.body.id);
        const gestorStr = req.user?.email || 'Sistema (Automático)';
        await supabase.from('logs').insert([{ evento: "Solicitação Rejeitada", detalhes: `Ficha rejeitada. Motivo: ${req.body.motivo || 'Nenhum'}. (Gestor: ${gestorStr})` }]);
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/devedores-ativos', async (req, res) => {
    try {
        let todosDevedores = [];
        let buscar = true;
        let ponteiro = 0;
        while (buscar) {
            const { data, error } = await supabase.from('devedores').select('*')
                .in('status', ['ABERTO', 'ATRASADO', 'APROVADO_AGUARDANDO_ACEITE'])
                .order('data_vencimento', { ascending: true })
                .range(ponteiro, ponteiro + 999);
            
            if (error || !data || data.length === 0) break;
            todosDevedores = todosDevedores.concat(data);
            if (data.length < 1000) buscar = false;
            ponteiro += 1000;
        }
        res.json(todosDevedores);
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/enviar-cobranca-manual', async (req, res) => {
    try {
        const { id } = req.body;
        const { data: dev } = await supabase.from('devedores').select('*').eq('id', id).single();
        if (!dev) throw new Error("Contrato não encontrado");
        const linkPortal = `${APP_URL}/pagar.html?id=${dev.uuid}`;
        const msg = `Olá ${dev.nome.split(' ')[0]},\n\nAqui está o link do seu portal de pagamento para consultar sua fatura e gerar o PIX de forma segura:\n🔗 ${linkPortal}`;
        await enviarZap(dev.telefone, msg);
        const gestorStr = req.user?.email || 'Sistema (Automático)';
        await supabase.from('logs').insert([{ evento: "Envio Manual de Cobrança", detalhes: `Link de pagamento enviado via WhatsApp. (Gestor: ${gestorStr})`, devedor_id: dev.id }]);
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
        
        if (!isDataValida(novoVencimento)) return res.status(400).json({ erro: "Data de vencimento inválida." });

        const numNovoCapital = limparMoeda(novoCapital);
        const numNovoTotal = limparMoeda(novoTotal);
        
        const { data: devAntigo, error: errAntigo } = await supabase.from('devedores').select('valor_emprestado').eq('id', id).maybeSingle();
        if (!devAntigo) return res.status(404).json({ erro: "Contrato não encontrado." });

        const deltaCapital = numNovoCapital - parseFloat(devAntigo.valor_emprestado || 0);

        await supabase.from('devedores').update({ 
            data_vencimento: novoVencimento, 
            valor_emprestado: numNovoCapital, 
            valor_total: numNovoTotal, 
            frequencia: novaFrequencia,
            status: 'ABERTO', 
            ultima_cobranca_atraso: null 
        }).eq('id', id);
        
        const gestorStr = req.user?.email || 'Sistema (Automático)';

        await supabase.from('logs').insert([{ 
            evento: "Edição Manual de Contrato", 
            detalhes: `Vencimento atualizado para ${novoVencimento}. Saldo Total: R$ ${numNovoTotal.toFixed(2)} (Gestor: ${gestorStr})`, 
            devedor_id: id 
        }]);

        if (Math.abs(deltaCapital) > 0.05) {
            await supabase.from('logs').insert([{ 
                evento: "Ajuste de Capital (Edição)", 
                detalhes: `Capital corrigido manualmente no painel.`, 
                valor_fluxo: -deltaCapital, 
                devedor_id: id 
            }]);
        }
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
        res.json({ data_emprestimo: dev.created_at, capital_original: dev.valor_emprestado, saldo_atual: dev.valor_total, dias_atraso: Math.max(0, diasAtraso), total_pago: totalPago });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/baixar-manual', async (req, res) => {
    const { id, valorPago, observacoes, recalculoAjuste, recalculoTaxa, recalculoParcelas } = req.body;
    
    const lockKey = `baixa_${id}`;
    if (travasAtivasPainel.has(lockKey)) return res.status(429).json({ erro: "Aguarde..." });
    travasAtivasPainel.add(lockKey);

    try { 
        let resRecalculo = { sucesso: true, status: 'apenas_ajuste' };
        
        const vPago = limparMoeda(valorPago);
        const calcAjuste = limparMoeda(recalculoAjuste);
        const calcTaxa = limparMoeda(recalculoTaxa);

        if (vPago > 0) {
            resRecalculo = await recalcularDivida(id, vPago); 
            if (resRecalculo.erro) throw new Error(resRecalculo.erro);
        }
        
        let atualizacoes = {}; let notas = [];
        const { data: devAtualizado } = await supabase.from('devedores').select('*').eq('id', id).single();
        
        if (devAtualizado && ['ABERTO', 'ATRASADO', 'QUITADO'].includes(devAtualizado.status)) {
            let novoTotal = parseFloat(devAtualizado.valor_total);
            let parcelasAtuais = devAtualizado.qtd_parcelas || 1;
            
            if (recalculoParcelas && parseInt(recalculoParcelas) > 0) {
                parcelasAtuais = parseInt(recalculoParcelas);
                atualizacoes.qtd_parcelas = parcelasAtuais; notas.push(`Convertido para ${parcelasAtuais} parcelas`);
            }
            if (calcTaxa > 0) {
                const capital = parseFloat(devAtualizado.valor_emprestado); const taxaDec = calcTaxa / 100;
                const taxaAplicada = parcelasAtuais > 1 ? (taxaDec * parcelasAtuais) : taxaDec;
                novoTotal = capital * (1 + taxaAplicada); 
                atualizacoes.taxa_juros = calcTaxa; 
                notas.push(`Taxa alterada para ${calcTaxa}%`);
            }
            if (calcAjuste !== 0) {
                novoTotal += calcAjuste; notas.push(`Ajuste no saldo: R$ ${calcAjuste.toFixed(2)}`);
            }
            
            const gestorStr = req.user?.email || 'Sistema (Automático)';
            if (observacoes) {
                notas.push(`Obs: ${observacoes}`);
                atualizacoes.observacoes = (devAtualizado.observacoes ? devAtualizado.observacoes + " | " : "") + `[${new Date().toLocaleDateString()}] ${observacoes}`;
            }

            if (novoTotal <= 0.05) {
                atualizacoes.valor_total = 0;
                atualizacoes.valor_emprestado = 0; 
                atualizacoes.status = 'QUITADO';
                atualizacoes.pago = true;
                if (devAtualizado.status !== 'QUITADO') {
                    notas.push(`Dívida liquidada completamente após descontos e ajustes.`);
                }
            } else {
                atualizacoes.valor_total = Math.max(0, Math.round(novoTotal * 100) / 100);
                if (devAtualizado.status === 'QUITADO' && atualizacoes.valor_total > 0) {
                    atualizacoes.status = 'ABERTO';
                    atualizacoes.pago = false;
                    notas.push(`Contrato reativado para ABERTO devido a ajuste manual pós-quitação.`);
                }
            }

            if (Object.keys(atualizacoes).length > 0) await supabase.from('devedores').update(atualizacoes).eq('id', id);
            
            if (notas.length > 0) await supabase.from('logs').insert([{ evento: "Recálculo / Ajuste Manual", detalhes: notas.join(' | ') + `. (Gestor: ${gestorStr})`, devedor_id: id }]);
        }
        res.json(resRecalculo);
    } catch (e) { 
        res.status(500).json({ erro: e.message }); 
    } finally {
        setTimeout(() => travasAtivasPainel.delete(lockKey), 3000);
    }
});

app.post('/api/cadastrar-cliente-manual', async (req, res) => {
    const d = req.body;
    try {
        if (!d.is_precadastro && !isDataValida(d.data_vencimento)) {
            return res.status(400).json({ erro: "Data de vencimento inválida. Preencha corretamente o calendário." });
        }

        const { data: activeDebts } = await supabase.from('devedores').select('id').eq('cpf', d.cpf).in('status', ['ABERTO', 'ATRASADO']).limit(1);
        if (activeDebts && activeDebts.length > 0) {
            if (d.is_precadastro) {
                return res.status(400).json({ erro: "Proteção: Cliente possui dívida ativa. Não pode rebaixar a Pré-Cadastro." });
            } else {
                return res.status(400).json({ erro: "Proteção: Cliente possui dívida ativa. Quite a antiga antes de lançar nova." });
            }
        }

        const uS = d.img_selfie ? await fazerUploadNoSupabase(d.img_selfie, `${d.cpf}_selfie_mig.jpg`) : null;
        const uF = d.img_frente ? await fazerUploadNoSupabase(d.img_frente, `${d.cpf}_frente_mig.jpg`) : null;
        const uV = d.img_verso ? await fazerUploadNoSupabase(d.img_verso, `${d.cpf}_verso_mig.jpg`) : null;
        const uR = d.img_residencia ? await fazerUploadNoSupabase(d.img_residencia, `${d.cpf}_res_mig.jpg`) : null;
        const uC = d.img_casa ? await fazerUploadNoSupabase(d.img_casa, `${d.cpf}_casa_mig.jpg`) : null;

        let dadosBanco = { nome: d.nome, cpf: d.cpf, telefone: d.whatsapp, observacoes: "[Cadastro Manual]" };
        if(uS) dadosBanco.url_selfie = uS; if(uF) dadosBanco.url_frente = uF; if(uV) dadosBanco.url_verso = uV; if(uR) dadosBanco.url_residencia = uR; if(uC) dadosBanco.url_casa = uC;

        if (!d.is_precadastro) {
            dadosBanco.valor_emprestado = limparMoeda(d.valor_emprestado); 
            dadosBanco.valor_total = limparMoeda(d.valor_total);
            
            const momentBRT = new Date(new Date(d.data_vencimento + 'T12:00:00Z').toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
            dadosBanco.data_vencimento = `${momentBRT.getFullYear()}-${String(momentBRT.getMonth() + 1).padStart(2, '0')}-${String(momentBRT.getDate()).padStart(2, '0')}`;
            
            dadosBanco.frequencia = d.frequencia;
            dadosBanco.qtd_parcelas = Math.max(1, parseInt(d.qtd_parcelas) || 1);
            
            const taxaAdvinha = dadosBanco.valor_emprestado > 0 ? (((dadosBanco.valor_total / dadosBanco.valor_emprestado) - 1) / dadosBanco.qtd_parcelas) * 100 : 30;
            dadosBanco.taxa_juros = Math.round(taxaAdvinha * 100) / 100;
            dadosBanco.total_ja_pego = limparMoeda(d.capital_pago) + limparMoeda(d.juros_pagos);
            
            dadosBanco.status = 'ABERTO'; dadosBanco.pago = false;
        } else {
            dadosBanco.status = 'PRE_CADASTRO'; dadosBanco.pago = true; dadosBanco.valor_emprestado = 0; dadosBanco.valor_total = 0;
        }

        let devId;
        if (d.id_existente) {
            if (!d.is_precadastro) {
                dadosBanco.created_at = new Date().toISOString();
                dadosBanco.ultima_cobranca_atraso = null;
            }
            const { data: updated, error } = await supabase.from('devedores').update(dadosBanco).eq('id', d.id_existente).select().single();
            if(error) throw error;
            devId = updated.id;
        } else {
            const { data: inserted, error } = await supabase.from('devedores').insert([dadosBanco]).select().single();
            if (error) { if (error.code === '23505') throw new Error("CPF já existe na base."); throw error; }
            devId = inserted.id;
        }

        const gestorStr = req.user?.email || 'Sistema (Automático)';

        if (!d.is_precadastro) {
            const numJurosPago = limparMoeda(d.juros_pagos);
            const numCapPago = limparMoeda(d.capital_pago);

            await supabase.from('logs').insert([{ 
                evento: 'Empréstimo Liberado', 
                detalhes: (d.id_existente ? `Dívida lançada no perfil.` : `Cliente novo lançado no sistema.`) + ` (Gestor: ${gestorStr})`, 
                devedor_id: devId,
                valor_fluxo: -Math.abs(dadosBanco.valor_emprestado)
            }]);

            if (numJurosPago > 0) await supabase.from('logs').insert([{ evento: 'Histórico Antigo (Juros)', detalhes: `Juros pagos em sistema anterior. (Sem impacto)`, valor_fluxo: 0, devedor_id: devId }]);
            if (numCapPago > 0) await supabase.from('logs').insert([{ evento: 'Histórico Antigo (Capital)', detalhes: `Dívida abatida em sistema anterior. (Sem impacto)`, valor_fluxo: 0, devedor_id: devId }]);
        } else {
            await supabase.from('logs').insert([{ evento: d.id_existente ? 'Atualização Cadastral' : 'Pré-Cadastro', detalhes: `Ficha salva sem movimento. (Gestor: ${gestorStr})`, devedor_id: devId }]);
        }
        res.json({ sucesso: true });
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/saida-caixa', async (req, res) => {
    try { 
        const valorSaida = limparMoeda(req.body.valor);
        const gestorStr = req.user?.email || 'Sistema (Automático)';
        await supabase.from('logs').insert([{ evento: "SAÍDA DE CAIXA", detalhes: `${req.body.motivo} (Gestor: ${gestorStr})`, valor_fluxo: -Math.abs(valorSaida) }]); 
        res.json({ sucesso: true }); 
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/extrato-caixa', async (req, res) => { const { data } = await supabase.from('logs').select('*').eq('evento', 'SAÍDA DE CAIXA').order('created_at', { ascending: false }).limit(50); res.json(data || []); });
app.get('/api/logs-auditoria', async (req, res) => { const { data } = await supabase.from('logs').select('*').order('created_at', { ascending: false }).limit(300); res.json(data || []); });
app.get('/api/lista-negra', async (req, res) => { const { data } = await supabase.from('lista_negra').select('*').order('created_at', { ascending: false }); res.json(data || []); });

app.post('/api/lista-negra', async (req, res) => {
    try { 
        await supabase.from('lista_negra').insert([{ cpf: req.body.cpf, motivo: req.body.motivo }]); 
        const gestorStr = req.user?.email || 'Sistema (Automático)';
        await supabase.from('logs').insert([{ evento: "Bloqueio na Lista Negra", detalhes: `CPF ${req.body.cpf} bloqueado. (Gestor: ${gestorStr})` }]); 
        res.json({ sucesso: true }); 
    } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.delete('/api/lista-negra/:cpf', async (req, res) => { await supabase.from('lista_negra').delete().eq('cpf', req.params.cpf); res.json({ sucesso: true }); });
app.get('/api/promotores', async (req, res) => { const { data } = await supabase.from('promotores').select('*').order('created_at', { ascending: false }); res.json(data || []); });

app.post('/api/adicionar-promotor', async (req, res) => {
    try { 
        await supabase.from('promotores').insert([{ nome: req.body.nome, cpf: req.body.cpf }]); 
        const gestorStr = req.user?.email || 'Sistema (Automático)';
        await supabase.from('logs').insert([{ evento: "Novo Promotor", detalhes: `Promotor ${req.body.nome} adicionado. (Gestor: ${gestorStr})` }]); 
        res.json({ sucesso: true }); 
    } catch (e) { res.status(500).json({ erro: e.message }); }
});
app.get('/api/config', async (req, res) => { const { data } = await supabase.from('config').select('*'); res.json(data || []); });

app.post('/api/config', async (req, res) => {
    try { 
        for (const c of req.body.configs) { await supabase.from('config').upsert({ chave: c.chave, valor: c.valor }); } 
        const gestorStr = req.user?.email || 'Sistema (Automático)';
        await supabase.from('logs').insert([{ evento: "Alteração de Configurações", detalhes: `Os parâmetros financeiros foram modificados. (Gestor: ${gestorStr})` }]); 
        res.json({ sucesso: true }); 
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/relatorio-periodo', async (req, res) => {
    try {
        const { dataInicio, dataFim } = req.body;
        
        if (!isDataValida(dataInicio) || !isDataValida(dataFim)) {
            return res.status(400).json({ erro: "Datas inválidas fornecidas para o cálculo do relatório." });
        }
        
        const inicio = new Date(`${dataInicio}T00:00:00-03:00`).toISOString(); 
        const fim = new Date(`${dataFim}T23:59:59-03:00`).toISOString();

        let todosLogs = [];
        let buscar = true;
        let ptr = 0;
        
        while (buscar) {
            const { data, error } = await supabase.from('logs')
                .select('valor_fluxo, evento, detalhes, created_at')
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
        let jurosAtrasoGerado = 0;
        let movimentacoes = []; // 🚨 AUDITORIA GRANULAR: Array de Registos

        todosLogs.forEach(log => {
            const v = Number(log.valor_fluxo) || 0;
            const ev = log.evento || "";
            
            if (ev === 'Empréstimo Liberado' || ev === 'Ajuste de Capital (Edição)') {
                totalEmprestado += Math.abs(v);
            }
            else if (['Recebimento', 'Liquidação Total', 'Quitação Total', 'Rolagem de Contrato', 'Pagamento de Parcela', 'Pagamento Parcial (Incompleto)'].includes(ev)) {
                totalRecebido += v;
            }
            else if (ev.includes('Juros de Atraso')) {
                const match = (log.detalhes || "").match(/R\$ ([\d.,]+)/);
                if (match) {
                    const parsedMulta = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
                    if (!isNaN(parsedMulta)) jurosAtrasoGerado += parsedMulta;
                }
            }

            // 🚨 Popula o array detalhado apenas se houver fluxo de caixa real
            if (v !== 0 && !ev.includes('Histórico Antigo')) {
                movimentacoes.push({
                    created_at: log.created_at,
                    evento: ev,
                    detalhes: log.detalhes,
                    valor_fluxo: v,
                    tipo: v > 0 ? 'ENTRADA' : 'SAÍDA'
                });
            }
        });

        // Ordena do mais recente para o mais antigo para visualização na tabela do painel
        movimentacoes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        const { count: qtdAtrasados } = await supabase.from('devedores').select('*', { count: 'exact', head: true }).eq('pago', false).gte('data_vencimento', dataInicio).lte('data_vencimento', dataFim).lt('data_vencimento', new Date().toISOString().split('T')[0]);
        const { count: qtdEmprestimos } = await supabase.from('logs').select('*', { count: 'exact', head: true }).in('evento', ['Empréstimo Liberado']).gte('created_at', inicio).lte('created_at', fim);
        const { count: qtdBloqueados } = await supabase.from('lista_negra').select('*', { count: 'exact', head: true }).gte('created_at', inicio).lte('created_at', fim);

        // 🚨 Adicionado "movimentacoes" ao payload enviado ao front-end
        res.json({ totalEmprestado, totalRecebido, jurosAtrasoGerado, qtdAtrasados, qtdEmprestimos, qtdBloqueados, movimentacoes });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// 6. ROBÔ DE AUTOMAÇÃO (BLINDADO - HORÁRIO ABSOLUTO)
// ==========================================

cron.schedule('0 * * * *', async () => {
    console.log("⏰ [CRON] Acordando para executar Cobrança Automática / Autocura...");
    try {
        const tempoEspera = Math.floor(Math.random() * 5000);
        await sleep(tempoEspera);

        // O dataApoio base serve para verificar os limites de hora
        const dataApoio = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        
        // 🚨 VACINA 2: Normalização à Meia-noite Absoluta. 
        // Garante que o Math.round nunca salta ou antecipa um dia independentemente da hora que rodar.
        const dataMatematicaHoje = new Date(dataApoio.getTime());
        dataMatematicaHoje.setHours(0, 0, 0, 0);

        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
        const dataHojeSimples = formatter.format(dataApoio);
        
        const lockHour = `${dataHojeSimples}_${dataApoio.getHours()}`;
        const { data: lockCron } = await supabase.from('config').select('valor').eq('chave', 'cron_diario_lock').maybeSingle();
        if (lockCron && lockCron.valor === lockHour) {
            console.log("🛡️ Bloqueio ativado: Robô já patrulhou o sistema nesta hora.");
            return;
        }
        await supabase.from('config').upsert({ chave: 'cron_diario_lock', valor: lockHour });
        
        console.log("✅ Permissão obtida. Iniciando processamento de carteira...");

        const objAmanha = new Date(dataApoio);
        objAmanha.setDate(objAmanha.getDate() + 1);
        const dataAmanhaSimples = formatter.format(objAmanha);
        
        let ponteiroLembrete = 0;
        let buscarLembretes = true;
        while (buscarLembretes) {
            const { data: lembretes } = await supabase.from('devedores').select('*')
                .eq('pago', false).in('status', ['ABERTO', 'ATRASADO']).in('data_vencimento', [dataHojeSimples, dataAmanhaSimples])
                .range(ponteiroLembrete, ponteiroLembrete + 999);
            
            if (!lembretes || lembretes.length === 0) break;
            
            for (const dev of lembretes) {
                try {
                    const linkPortal = `${APP_URL}/pagar.html?id=${dev.uuid}`;
                    await enviarLembreteVencimento(dev.telefone, dev.nome, dev.valor_total, dev.data_vencimento, linkPortal);
                    await sleep(2500); 
                } catch (errLembrete) {
                    console.error(`⚠️ Erro ao enviar lembrete para ID ${dev.id}:`, errLembrete.message);
                }
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
                .eq('pago', false).in('status', ['ABERTO', 'ATRASADO']).lt('data_vencimento', dataHojeSimples)
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
                    
                    // 🚨 VACINA 2: Matemática blindada pela Meia-Noite Absoluta
                    const diasParaCobrar = Math.round((dataMatematicaHoje - dataBaseCalculo) / (1000 * 60 * 60 * 24));
                    
                    if (diasParaCobrar > 0 && diasParaCobrar <= 365) {
                        let novoValor = parseFloat(dev.valor_total);
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

                        const linkPortal = `${APP_URL}/pagar.html?id=${dev.uuid}`;
                        await enviarAvisoAtraso(dev.telefone, dev.nome, novoValor, totalDiasAtraso, linkPortal);
                        await sleep(2500); 
                    } else if (diasParaCobrar > 365 || isNaN(diasParaCobrar)) {
                        console.error(`🚨 ALERTA DE INTEGRIDADE: Cliente ID ${dev.id} com ${diasParaCobrar} dias. Corrompido.`);
                        clientesEmQuarentena.add(dev.id);
                    }
                } catch (erroCliente) {
                    console.error(`🚨 ERRO ISOLADO: Falha no cliente ID ${dev.id}. Quarentena. Motivo:`, erroCliente.message);
                    clientesEmQuarentena.add(dev.id); 
                }
            }
            if (devedoresEmAtraso.length < 1000) buscarAtrasos = false;
        }
    } catch(e) { console.error("❌ Erro CRON GLOBAL:", e); }
}); // Note: Fuso horário foi retirado do CRON wrapper e gerido no cálculo para evitar bugs na versão do node-cron

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Elite Master Rodando Seguro na porta ${PORT}`));