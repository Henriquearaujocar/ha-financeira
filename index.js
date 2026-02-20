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

// Rota de Login Admin (Supabase Auth)
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    try {
        // Tenta fazer o login seguro direto no banco do Supabase
        const { data, error } = await supabase.auth.signInWithPassword({
            email: email,
            password: password,
        });
        
        if (error) {
            return res.status(401).json({ erro: 'E-mail ou senha incorretos (Supabase)' });
        }
        
        // Se deu certo, devolve o Token Oficial JWT do Supabase
        res.json({ token: data.session.access_token });
    } catch (err) {
        res.status(500).json({ erro: 'Erro interno de autenticação.' });
    }
});

// Cão de Guarda (Middleware) - Valida o Token direto no Supabase
const authMiddleware = async (req, res, next) => {
    // Rotas que o cliente precisa acessar (Ficam destrancadas)
    const rotasPublicas = [
        '/api/login',
        '/upload-foto', 
        '/enviar-solicitacao', 
        '/validar-extrato', 
        '/cliente-aceitou', 
        '/cliente-gerar-pagamento', 
        '/webhook-infinitepay'
    ];

    // Se for rota pública, passa direto
    if (rotasPublicas.includes(req.path)) {
        return next();
    }

    // Se for rota do Painel Admin, exige o token JWT
    const tokenHeader = req.headers['authorization'];
    
    if (!tokenHeader || !tokenHeader.startsWith('Bearer ')) {
        return res.status(401).json({ erro: 'Acesso Restrito. Faça o Login no Painel.' });
    }

    const token = tokenHeader.split(' ')[1];

    // Vai no Supabase e checa se o Token é real, ativo e não expirou
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
        return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
    }

    return next(); // Autenticado, pode passar!
};

// Aplica o Cadeado no Servidor
app.use(authMiddleware);

// ==========================================
// 1. DASHBOARD & CONFIGURAÇÕES GLOBAIS
// ==========================================

app.get('/status-zapi', async (req, res) => { 
    try { 
        const status = await verificarStatusZapi();
        res.json(status); 
    } catch(e) { 
        res.json({ connected: false }); 
    } 
});

app.get('/dashboard', async (req, res) => {
    try {
        const { data: devedores } = await supabase.from('devedores').select('valor_total').eq('pago', false);
        const naRua = devedores ? devedores.reduce((acc, curr) => acc + Number(curr.valor_total), 0) : 0;

        const { data: logs } = await supabase.from('logs').select('valor_fluxo').in('evento', ['Recebimento', 'Liquidação Total', 'Quitação Total', 'Rolagem de Contrato', 'Pagamento Automático via Link', 'Pagamento Parcial (Incompleto)']);
        const recebido = logs ? logs.reduce((acc, curr) => acc + Number(curr.valor_fluxo), 0) : 0;
        
        res.json({ naRua, recebido });
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.get('/obter-configuracoes', async (req, res) => {
    try {
        const { data: configRows } = await supabase.from('config').select('*');
        let conf = {};
        (configRows || []).forEach(r => conf[r.chave] = Number(r.valor));

        const { data: devedores } = await supabase.from('devedores').select('valor_emprestado').eq('pago', false);
        const naRua = devedores ? devedores.reduce((acc, curr) => acc + Number(curr.valor_emprestado), 0) : 0;
        
        res.json({ 
            caixa_total: conf.caixa_total || 0,
            taxa_30: conf.taxa_30 || 30,
            taxa_parc: conf.taxa_parc || 25,
            disponivel: (conf.caixa_total || 0) - naRua 
        });
    } catch(e) { 
        res.json({ caixa_total: 0, taxa_30: 30, taxa_parc: 25, disponivel: 0 }); 
    }
});

app.post('/salvar-configuracoes', async (req, res) => { 
    try { 
        const { caixa_total, taxa_30, taxa_parc } = req.body;
        await supabase.from('config').upsert([
            { chave: 'caixa_total', valor: caixa_total },
            { chave: 'taxa_30', valor: taxa_30 },
            { chave: 'taxa_parc', valor: taxa_parc }
        ]);
        res.json({ status: 'Sucesso' }); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    } 
});

// ==========================================
// 2. SOLICITAÇÕES E ANÁLISES
// ==========================================

app.post('/upload-foto', async (req, res) => { 
    try { 
        const url = await fazerUploadNoSupabase(req.body.imagem, req.body.nomeArquivo); 
        res.json({ url }); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    } 
});

app.post('/enviar-solicitacao', async (req, res) => {
    try {
        const cpfLimpo = String(req.body.cpf || '').replace(/\D/g, '');
        
        // --- BLINDAGEM ANTI-INVERSÃO DE DADOS ---
        if (cpfLimpo.length !== 11) {
            return res.status(400).json({ erro: "CPF inválido. Certifique-se de digitar 11 números corretos." });
        }
        
        // Se o nome enviado contiver APENAS números (Ex: cliente inverteu CPF e Nome)
        if (!req.body.nome || /^\d+$/.test(req.body.nome.replace(/[\s\.\-]/g, ''))) {
            return res.status(400).json({ erro: "O campo Nome não pode conter apenas números. Verifique se você não inverteu o Nome com o CPF." });
        }
        // ----------------------------------------

        const { data: clienteBloqueado } = await supabase.from('lista_negra').select('*').eq('cpf', cpfLimpo).single();
        
        if (clienteBloqueado) {
            return res.status(403).json({ erro: "Cadastro negado. Restrição interna.", details: clienteBloqueado.motivo });
        }

        const payload = { ...req.body, cpf: cpfLimpo };
        const { error } = await supabase.from('solicitacoes').insert([payload]);
        if (error) throw error;
        
        res.json({ status: 'Recebido' });
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.get('/listar-solicitacoes/:status', async (req, res) => { 
    try { 
        const { data, error } = await supabase.from('solicitacoes')
            .select('*')
            .eq('status', req.params.status)
            .order('created_at', { ascending: false }); 
        
        if (error) throw error;
        res.json(data); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    } 
});

app.post('/aprovar-solicitacao', async (req, res) => {
    try {
        const dados = req.body;
        const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');

        const dataVenc = new Date();
        dataVenc.setUTCHours(dataVenc.getUTCHours() - 3); 
        dataVenc.setDate(dataVenc.getDate() + 30); 
        const vencimentoString = dataVenc.toISOString().split('T')[0];

        const { data: devedor, error: devError } = await supabase.from('devedores').insert([{
            nome: dados.nome, 
            cpf: cpfLimpo, 
            telefone: dados.whatsapp || dados.telefone,
            valor_emprestado: parseFloat(dados.valor), 
            valor_total: parseFloat(dados.valor_negociado),
            frequencia: dados.frequencia, 
            qtd_parcelas: dados.qtd_parcelas, 
            data_vencimento: vencimentoString,
            url_selfie: dados.url_selfie, 
            url_documento: dados.url_documento, 
            url_residencia: dados.url_residencia, 
            url_casa: dados.url_casa,
            referencia1_nome: dados.referencia1_nome, 
            referencia1_tel: dados.referencia1_tel, 
            referencia2_nome: dados.referencia2_nome, 
            referencia2_tel: dados.referencia2_tel,
            latitude: dados.latitude, 
            longitude: dados.longitude, 
            status: 'APROVADO_AGUARDANDO_ACEITE',
            indicado_por: dados.indicado_por || 'DIRETO',
            pago: false
        }]).select().single();

        if (devError) throw devError;

        await supabase.from('solicitacoes').update({ status: 'APROVADO' }).eq('id', dados.id);
        
        await supabase.from('logs').insert([{ 
            evento: "Empréstimo Aprovado", 
            detalhes: `Valor Total: R$ ${dados.valor_negociado} | Vencimento projetado: ${vencimentoString}`, 
            devedor_id: devedor.id 
        }]);

        if (dados.enviar_zap !== false) {
            const linkAceite = `${APP_URL}/aceitar.html?id=${devedor.uuid}`;
            const msg = `Olá ${dados.nome.split(' ')[0]}!\n\nSua solicitação foi aprovada! 🎉\nValor Liberado: *R$ ${parseFloat(dados.valor).toFixed(2)}*\n\nAcesse para aceitar os termos e receber o PIX:\n🔗 ${linkAceite}`;
            await enviarZap(dados.whatsapp || dados.telefone, msg);
        }
        
        res.json({ status: 'Aprovado', devedor });
    } catch(e) { 
        console.error("❌ Erro em /aprovar-solicitacao:", e);
        res.status(500).json({ erro: e.message || e.details || "Erro interno do servidor" }); 
    }
});

app.post('/enviar-contra-proposta', async (req, res) => { 
    try { 
        const dados = req.body;
        const cpfLimpo = String(dados.cpf || '').replace(/\D/g, '');

        const dataVenc = new Date();
        dataVenc.setUTCHours(dataVenc.getUTCHours() - 3); 
        dataVenc.setDate(dataVenc.getDate() + 30); 
        const vencimentoString = dataVenc.toISOString().split('T')[0];

        const { data: devedor, error: devError } = await supabase.from('devedores').insert([{
            nome: dados.nome, 
            cpf: cpfLimpo, 
            telefone: dados.whatsapp || dados.telefone,
            valor_emprestado: parseFloat(dados.valor), 
            valor_total: parseFloat(dados.valor_negociado),
            frequencia: dados.frequencia, 
            qtd_parcelas: dados.qtd_parcelas, 
            data_vencimento: vencimentoString,
            url_selfie: dados.url_selfie, 
            url_documento: dados.url_documento, 
            url_residencia: dados.url_residencia, 
            url_casa: dados.url_casa,
            referencia1_nome: dados.referencia1_nome, 
            referencia1_tel: dados.referencia1_tel, 
            referencia2_nome: dados.referencia2_nome, 
            referencia2_tel: dados.referencia2_tel,
            latitude: dados.latitude, 
            longitude: dados.longitude, 
            status: 'APROVADO_AGUARDANDO_ACEITE',
            indicado_por: dados.indicado_por || 'DIRETO',
            pago: false
        }]).select().single();

        if (devError) throw devError;

        await supabase.from('solicitacoes').update({ status: 'APROVADO_CP' }).eq('id', dados.id);
        
        await supabase.from('logs').insert([{ 
            evento: "Contra-Proposta Gerada", 
            detalhes: `Proposto R$ ${parseFloat(dados.valor).toFixed(2)}. Aguardando aceite do cliente.`, 
            devedor_id: devedor.id 
        }]);

        const linkAceite = `${APP_URL}/aceitar.html?id=${devedor.uuid}`;
        const msg = `Olá ${dados.nome.split(' ')[0]},\n\nAnalisamos a sua ficha.\nO valor inicial solicitado não foi aprovado, mas temos uma *Contra-Proposta* para você!\n\nPodemos liberar *R$ ${parseFloat(dados.valor).toFixed(2)}* imediatamente.\n\nPara visualizar as parcelas, aceitar esta nova condição e receber seu PIX, acesse:\n🔗 ${linkAceite}`; 
        
        await enviarZap(dados.whatsapp || dados.telefone, msg); 
        
        res.json({ status: 'Enviado' }); 
    } catch(e) { 
        console.error("❌ Erro em /enviar-contra-proposta:", e);
        res.status(500).json({ erro: e.message || e.details || "Erro de integridade no banco de dados." }); 
    } 
});

app.post('/rejeitar-solicitacao', async (req, res) => { 
    try { 
        await supabase.from('solicitacoes').update({ status: 'REJEITADO' }).eq('id', req.body.id); 
        res.json({ status: 'Rejeitado' }); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    } 
});

// ==========================================
// 3. AÇÕES TÁTICAS E GESTÃO DE CONTRATOS
// ==========================================

app.get('/listar-financeiro/:pago', async (req, res) => { 
    try { 
        const pagoBool = req.params.pago === 'true';
        const { data } = await supabase.from('devedores')
            .select('*')
            .eq('pago', pagoBool)
            .order('data_vencimento', { ascending: true });
        res.json(data || []); 
    } catch(e) { 
        res.json([]); 
    } 
});

app.post('/editar-indicador', async (req, res) => {
    try {
        await supabase.from('devedores').update({ indicado_por: req.body.novoIndicador }).eq('id', req.body.id);
        res.json({ status: 'Atualizado' });
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.post('/dar-baixa-total', async (req, res) => {
    try {
        const { data: dev } = await supabase.from('devedores').select('*').eq('id', req.body.id).single();
        if(!dev) throw new Error("Não encontrado");

        const lucro = Number(dev.valor_total) - Number(dev.valor_emprestado);
        
        await supabase.from('devedores').update({ 
            pago: true, status: 'QUITADO', score: Number(dev.score) + 100 
        }).eq('id', dev.id);

        await supabase.from('logs').insert([{ 
            evento: "Liquidação Total", 
            detalhes: `Dívida de R$ ${Number(dev.valor_total).toFixed(2)} liquidada manualmente.`, 
            valor_fluxo: lucro > 0 ? lucro : 0, 
            devedor_id: dev.id 
        }]);
        
        res.json({ status: 'Baixado' });
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.post('/pagamento-parcial', async (req, res) => { 
    try { 
        const result = await recalcularDivida(req.body.id, req.body.valorPago); 
        if(result.erro) throw new Error(result.erro); 
        res.json(result); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    } 
});

app.post('/alterar-vencimento', async (req, res) => { 
    try { 
        const { data: dev } = await supabase.from('devedores').select('*').eq('id', req.body.id).single();
        const extra = parseFloat(req.body.taxaAdicional) || 0; 
        const novoTotal = Number(dev.valor_total) + extra;

        await supabase.from('devedores').update({ 
            data_vencimento: req.body.novaData, 
            valor_total: novoTotal 
        }).eq('id', dev.id); 
        
        await supabase.from('logs').insert([{ 
            evento: "Prorrogação de Vencimento", 
            detalhes: `Nova data: ${req.body.novaData} | Acréscimo: R$ ${extra.toFixed(2)}`, 
            devedor_id: dev.id 
        }]); 
        
        res.json({ status: 'Atualizado' }); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    } 
});

app.post('/renegociar-divida', async (req, res) => { 
    try { 
        const { id, novoValor, frequencia, qtd_parcelas } = req.body; 
        const { data: dev } = await supabase.from('devedores').select('*').eq('id', id).single();
        
        await supabase.from('devedores').update({ 
            valor_total: parseFloat(novoValor), 
            frequencia: frequencia || dev.frequencia, 
            qtd_parcelas: qtd_parcelas ? parseInt(qtd_parcelas) : dev.qtd_parcelas 
        }).eq('id', dev.id); 
        
        await supabase.from('logs').insert([{ 
            evento: "Renegociação de Débito", 
            detalhes: `Novo Saldo: R$ ${novoValor} | ${qtd_parcelas}x ${frequencia}`, 
            devedor_id: dev.id 
        }]); 
        
        res.json({ status: "Renegociado" }); 
    } catch (e) { 
        res.status(500).json({ erro: e.message }); 
    } 
});

app.post('/migrar-devedor', async (req, res) => { 
    try { 
        const cpfLimpo = String(req.body.cpf || '').replace(/\D/g, '');

        // --- BLINDAGEM ANTI-INVERSÃO DE DADOS ---
        if (cpfLimpo.length !== 11) {
            return res.status(400).json({ erro: "CPF inválido. Certifique-se de digitar 11 números." });
        }
        if (!req.body.nome || /^\d+$/.test(req.body.nome.replace(/[\s\.\-]/g, ''))) {
            return res.status(400).json({ erro: "O campo Nome não pode conter apenas números. Verifique se não inverteu com o CPF." });
        }
        // ----------------------------------------

        const { data: dev, error } = await supabase.from('devedores').insert([{ 
            nome: req.body.nome, 
            cpf: cpfLimpo, 
            telefone: formatarNumero(req.body.whatsapp), 
            valor_emprestado: parseFloat(req.body.valor_original), 
            valor_total: parseFloat(req.body.saldo_atual), 
            data_vencimento: req.body.vencimento,
            status: 'ABERTO',
            pago: false
        }]).select().single();
        
        if (error) throw error;

        await supabase.from('logs').insert([{ 
            evento: "Migração", 
            detalhes: "Sincronizado via Cockpit.", 
            devedor_id: dev.id 
        }]); 
        
        res.json({ status: "Sucesso" }); 
    } catch (e) { 
        res.status(500).json({ erro: e.message }); 
    } 
});

app.post('/enviar-zap-custom', async (req, res) => { 
    try { 
        await enviarZap(req.body.numero, req.body.mensagem); 
        res.json({ status: 'Enviado' }); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    } 
});

// ==========================================
// 4. RELATÓRIOS E AUDITORIA VITALÍCIA
// ==========================================

app.post('/relatorio-periodo', async (req, res) => {
    try {
        const { dataInicio, dataFim } = req.body;
        const inicio = `${dataInicio}T00:00:00.000Z`;
        const fim = `${dataFim}T23:59:59.999Z`;

        const { data: devedores } = await supabase.from('devedores').select('valor_emprestado')
            .gte('created_at', inicio).lte('created_at', fim);
        const totalEmprestado = devedores ? devedores.reduce((a, b) => a + Number(b.valor_emprestado), 0) : 0;
        
        const { data: logsRecebidos } = await supabase.from('logs').select('valor_fluxo')
            .in('evento', ['Recebimento', 'Liquidação Total', 'Quitação Total', 'Rolagem de Contrato'])
            .gte('created_at', inicio).lte('created_at', fim);
        const totalRecebido = logsRecebidos ? logsRecebidos.reduce((a, b) => a + Number(b.valor_fluxo), 0) : 0;
        
        const { data: logsAtraso } = await supabase.from('logs').select('detalhes')
            .eq('evento', 'Juros de Atraso (3%)')
            .gte('created_at', inicio).lte('created_at', fim);
            
        const jurosAtrasoGerado = logsAtraso ? logsAtraso.reduce((acc, log) => {
            const match = log.detalhes.match(/R\$ ([\d.]+)/);
            return acc + (match ? parseFloat(match[1]) : 0);
        }, 0) : 0;

        const { count: qtdAtrasados } = await supabase.from('devedores').select('*', { count: 'exact', head: true })
            .eq('pago', false)
            .gte('data_vencimento', dataInicio).lte('data_vencimento', dataFim)
            .lt('data_vencimento', new Date().toISOString().split('T')[0]);
        
        const { count: qtdEmprestimos } = await supabase.from('devedores').select('*', { count: 'exact', head: true })
            .gte('created_at', inicio).lte('created_at', fim);

        const { count: qtdBloqueados } = await supabase.from('lista_negra').select('*', { count: 'exact', head: true })
            .gte('created_at', inicio).lte('created_at', fim);

        res.json({ totalEmprestado, totalRecebido, jurosAtrasoGerado, qtdAtrasados, qtdEmprestimos, qtdBloqueados });
    } catch (e) { 
        res.status(500).json({ erro: e.message }); 
    }
});

app.get('/clientes-geral', async (req, res) => { 
    try { 
        const { data } = await supabase.from('devedores').select('*').order('nome', { ascending: true });
        res.json(data || []); 
    } catch(e) { 
        res.json([]); 
    } 
});

app.get('/relatorio-cliente/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return res.status(400).json({ erro: "ID inválido." });
        }

        // CLIENTE
        const { data: cliente, error: errCliente } = await supabase
            .from('devedores')
            .select('*')
            .eq('id', id)
            .single();

        if (errCliente || !cliente) {
            return res.status(404).json({ erro: "Cliente não encontrado." });
        }

        // CONTRATOS DO MESMO CPF
        const { data: contratos } = await supabase
            .from('devedores')
            .select('*')
            .eq('cpf', cliente.cpf);

        const ids = (contratos || []).map(c => c.id);

        // LOGS
        const { data: historico } = await supabase
            .from('logs')
            .select('*')
            .in('devedor_id', ids)
            .order('created_at', { ascending: false });

        // ESTATÍSTICAS
        const estatisticas = {
            totalPegoHistorico: (contratos || []).reduce((a, b) => a + Number(b.valor_emprestado), 0),
            jurosPagos: (historico || [])
                .filter(l => ['Recebimento', 'Liquidação Total', 'Quitação Total', 'Rolagem de Contrato'].includes(l.evento))
                .reduce((a, b) => a + Number(b.valor_fluxo || 0), 0),
            scoreAtual: cliente.score || 0,
            atrasos: !cliente.pago && new Date() > new Date(cliente.data_vencimento)
                ? Math.floor((new Date() - new Date(cliente.data_vencimento)) / 86400000)
                : 0
        };

        res.json({
            cliente,
            estatisticas,
            historico: historico || []
        });

    } catch (e) {
        console.error("❌ Erro no Relatório:", e);
        res.status(500).json({ erro: "Erro interno ao gerar relatório." });
    }
});

// ==========================================
// 5. BLACKLIST E EXTERNOS (PORTAIS)
// ==========================================

app.get('/lista-negra', async (req, res) => { 
    try { 
        const { data } = await supabase.from('lista_negra').select('*');
        res.json(data || []); 
    } catch(e) { 
        res.json([]); 
    } 
});

app.post('/lista-negra', async (req, res) => { 
    try { 
        await supabase.from('lista_negra').insert([{ cpf: req.body.cpf.replace(/\D/g, ''), motivo: req.body.motivo }]);
        res.json({ status: 'Adicionado' }); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    } 
});

app.delete('/lista-negra/:cpf', async (req, res) => { 
    try { 
        await supabase.from('lista_negra').delete().eq('cpf', req.params.cpf.replace(/\D/g, ''));
        res.json({ status: 'Removido' }); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    } 
});

app.post('/cadastrar-promotor', async (req, res) => { 
    try { 
        await supabase.from('promotores').insert([{ cpf: req.body.cpf.replace(/\D/g, ''), nome: req.body.nome }]);
        res.json({ status: 'Sucesso' }); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    } 
});

app.post('/ranking-promotores', async (req, res) => {
    try {
        const { data: sols } = await supabase.from('devedores').select('indicado_por, valor_total').neq('indicado_por', 'DIRETO');
        const rankMap = {};
        
        (sols || []).forEach(s => {
            const prom = s.indicado_por;
            if(!rankMap[prom]) rankMap[prom] = { nome_promotor: prom, quantidade_indicados: 0, total_gerado: 0 };
            rankMap[prom].quantidade_indicados += 1;
            rankMap[prom].total_gerado += Number(s.valor_total);
        });
        
        res.json(Object.values(rankMap).sort((a,b) => b.quantidade_indicados - a.quantidade_indicados).slice(0, 10));
    } catch(e) { 
        res.json([]); 
    }
});

// PORTAIS: Validação cega a formatação (com ou sem pontos)
app.post('/validar-extrato', async (req, res) => { 
    try { 
        const cpfLimpo = req.body.cpf ? req.body.cpf.replace(/\D/g, '') : '';
        const { data: dev } = await supabase.from('devedores')
            .select('*').eq('uuid', req.body.id)
            .eq('cpf', cpfLimpo)
            .single();
        
        if(!dev) return res.status(404).json({ erro: "Extrato não encontrado. Verifique o CPF." }); 
        res.json(dev); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    } 
});

app.post('/cliente-aceitou', async (req, res) => { 
    try { 
        const { data: dev } = await supabase.from('devedores').select('*').eq('uuid', req.body.id).single();
        if (!dev) throw new Error("Não encontrado");

        await supabase.from('devedores').update({ status: 'ABERTO' }).eq('id', dev.id);

        await supabase.from('logs').insert([{ 
            evento: "Assinatura Digital", 
            detalhes: "Termos aceitos. Contrato Ativado.", 
            devedor_id: dev.id 
        }]); 
        res.json({ status: 'Assinado' }); 
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    } 
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
    } catch(e) { 
        res.status(500).json({ erro: e.message }); 
    } 
});

app.post('/webhook-infinitepay', async (req, res) => {
    try {
        const payload = req.body;
        res.status(200).send('OK');

        const devUuid = payload.order_nsu; 
        const valorReais = (payload.paid_amount || payload.amount) / 100;

        if (devUuid && valorReais > 0) {
            const { data: dev } = await supabase.from('devedores').select('*').eq('uuid', devUuid).single();
            if (dev) {
                await recalcularDivida(dev.id, valorReais);
                await supabase.from('logs').insert([{ 
                    evento: "Pagamento Automático via Link", 
                    detalhes: `Recebido R$ ${valorReais.toFixed(2)} via ${payload.capture_method || 'InfinitePay'}. NSU: ${payload.transaction_nsu}`, 
                    devedor_id: dev.id,
                    valor_fluxo: valorReais
                }]);
            }
        }
    } catch(e) {
        console.error("❌ Erro no Webhook IP:", e);
    }
});

// ==========================================
// 6. ROBÔ DE AUTOMAÇÃO (COBRANÇA E MULTAS)
// ==========================================

// CORREÇÃO: Força o servidor a usar o horário do Brasil. Sem isso, na nuvem, ele rodaria 5h da manhã.
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
        
        for (const dev of (devedoresEmAtraso || [])) {
            const venc = new Date(dev.data_vencimento + 'T00:00:00-03:00');
            const diasAtraso = Math.floor((dataApoio - venc) / (1000 * 60 * 60 * 24));
            
            const multaDiaria = Math.round((parseFloat(dev.valor_total) * 0.03) * 100) / 100; 
            const novoValor = Math.round((parseFloat(dev.valor_total) + multaDiaria) * 100) / 100;

            await supabase.from('devedores').update({ 
                valor_total: novoValor, 
                ultima_cobranca_atraso: dataHojeSimples 
            }).eq('id', dev.id);
            
            await supabase.from('logs').insert([{ 
                evento: "Juros de Atraso (3%)", 
                detalhes: `Aplicada multa de R$ ${multaDiaria.toFixed(2)} pelo ${diasAtraso}º dia de atraso. Saldo: R$ ${novoValor.toFixed(2)}`, 
                devedor_id: dev.id 
            }]);

            const linkPortal = `${APP_URL}/pagar.html?id=${dev.uuid}`;
            await enviarAvisoAtraso(dev.telefone, dev.nome, novoValor, diasAtraso, linkPortal);
        }
    } catch(e) { 
        console.error("❌ Erro CRON:", e); 
    }
}, {
    timezone: "America/Sao_Paulo"
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Elite Master Rodando Seguro na porta ${PORT}`));