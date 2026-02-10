require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { Devedor, Parente } = require('./database');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// FUNÇÃO PARA GARANTIR O 55 NO WHATSAPP
const formatarNumero = (num) => {
    if (!num) return "";
    let limpo = num.replace(/\D/g, '');
    return limpo.startsWith('55') ? limpo : `55${limpo}`;
};

// ROTA: ENVIAR SOLICITAÇÃO (CLIENTE)
app.post('/enviar-solicitacao', async (req, res) => {
    try {
        const { error } = await supabase.from('solicitacoes').insert([req.body]);
        if (error) throw error;
        res.json({ status: "Sucesso" });
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ROTA: LISTAR SOLICITAÇÕES DO SUPABASE (PENDENTE / APROVADO)
app.get('/listar-solicitacoes/:status', async (req, res) => {
    try {
        const { status } = req.params;
        const { data, error } = await supabase
            .from('solicitacoes')
            .select('*')
            .eq('status', status.toUpperCase());
        if (error) throw error;
        res.json(data || []);
    } catch (err) { res.status(500).json([]); }
});

// ROTA: APROVAR + Z-API (COM CORREÇÃO DO 55 E ERRO 500)
app.post('/aprovar-solicitacao', async (req, res) => {
    try {
        const { id, nome, cpf, whatsapp, valor, juros, vencimento, nome_referencia, tel_referencia, ref2_nome, ref2_tel } = req.body;
        
        const vEmprestado = Number(valor) || 0;
        const pJuros = Number(juros) || 20;
        const vTotal = vEmprestado + (vEmprestado * (pJuros / 100));
        const numeroZap = formatarNumero(whatsapp);

        // 1. Salva no SQLite
        const novoDevedor = await Devedor.create({
            nome, cpf, telefone: numeroZap,
            valor_emprestado: vEmprestado,
            juros_mensal: pJuros,
            valor_total: vTotal,
            data_vencimento: vencimento,
            pago: false
        });

        // 2. Salva Parentes se existirem
        const parentes = [];
        if (nome_referencia) parentes.push({ nome: nome_referencia, telefone: tel_referencia, DevedorId: novoDevedor.id });
        if (ref2_nome) parentes.push({ nome: ref2_nome, telefone: ref2_tel, DevedorId: novoDevedor.id });
        if (parentes.length > 0) await Parente.bulkCreate(parentes);

        // 3. Atualiza Supabase
        await supabase.from('solicitacoes').update({ status: 'APROVADO' }).eq('id', id);

        // 4. Envia Z-API
        const msg = `✅ *HA FINANCEIRA*\nOlá *${nome.split(' ')[0]}*, seu PIX de R$ ${vEmprestado.toFixed(2)} foi liberado! Vencimento: ${vencimento.split('-').reverse().join('/')}.`;
        await axios.post(`https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}/send-text`, 
            { phone: numeroZap, text: msg },
            { headers: { 'client-token': process.env.ZAPI_CLIENT_TOKEN } }
        ).catch(e => console.log("Z-API falhou, mas dados salvos."));

        res.json({ status: "Sucesso" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: err.message });
    }
});

// ROTA: LISTAR FINANCEIRO DO SQLITE (DÍVIDAS ABERTAS OU PAGAS)
app.get('/listar-financeiro/:pago', async (req, res) => {
    try {
        const statusPago = req.params.pago === 'true';
        const lista = await Devedor.findAll({ where: { pago: statusPago }, order: [['updatedAt', 'DESC']] });
        res.json(lista || []);
    } catch (err) { res.status(500).json([]); }
});

// ROTA: PAGAMENTO PARCIAL (ABATIMENTO)
app.post('/pagamento-parcial', async (req, res) => {
    try {
        const { id, valorPago } = req.body;
        const dev = await Devedor.findByPk(id);
        const novoTotal = dev.valor_total - Number(valorPago);
        await dev.update({ valor_total: novoTotal, pago: novoTotal <= 0 });
        res.json({ status: "Sucesso" });
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ROTA: DAR BAIXA TOTAL
app.post('/dar-baixa-total', async (req, res) => {
    try {
        await Devedor.update({ pago: true, valor_total: 0 }, { where: { id: req.body.id } });
        res.json({ status: "Sucesso" });
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ROTA: DASHBOARD (LUCRO REAL)
app.get('/dashboard', async (req, res) => {
    try {
        const devedores = await Devedor.findAll();
        let naRua = 0; let recebido = 0;
        devedores.forEach(d => {
            let esperado = (d.valor_emprestado || 0) + ((d.valor_emprestado || 0) * ((d.juros_mensal || 0) / 100));
            if (!d.pago) {
                naRua += (d.valor_total || 0);
                recebido += (esperado - (d.valor_total || 0));
            } else { recebido += esperado; }
        });
        res.json({ naRua, recebido });
    } catch (err) { res.json({ naRua: 0, recebido: 0 }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 HA Financeira rodando na porta ${PORT}`));