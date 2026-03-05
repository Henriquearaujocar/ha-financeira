const axios = require('axios');

/**
 * Limpa o número e garante o formato internacional brasileiro
 */
const formatarNumero = (num) => {
    if (!num) return "";
    let limpo = num.replace(/\D/g, ''); 
    if (limpo.length === 10 || limpo.length === 11) limpo = `55${limpo}`;
    return limpo;
};

/**
 * Função Core: Dispara a mensagem na API da Z-API
 */
const enviarZap = async (numeroRecebido, mensagem) => {
    const numeroFormatado = formatarNumero(numeroRecebido);
    if (!numeroFormatado) return console.error("Número inválido para envio:", numeroRecebido);

    try {
        const url = `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}/send-text`;
        
        await axios.post(url, {
            phone: numeroFormatado,
            message: mensagem
        }, {
            headers: { 'client-token': process.env.ZAPI_CLIENT_TOKEN }
        });
        
        console.log(`✅ ZAP Enviado p/ ${numeroFormatado}`);
        return true;
    } catch (error) {
        console.error(`❌ Erro Zap p/ ${numeroFormatado}:`, error.response ? error.response.data : error.message);
        return false;
    }
};

/**
 * [NOVO] APROVAÇÃO E CONTRAPROPOSTA TRANSPARENTE
 * O cliente vê os novos termos antes de clicar no link.
 */
const enviarAprovacaoComTermos = async (numero, nome, valor, parcelas, frequencia, valorParcela, linkAssinatura, isContraProposta = false) => {
    let msg = '';
    
    if (isContraProposta) {
        msg = `Olá, ${nome.split(' ')[0]}! 🤝\n\nA sua análise de crédito foi concluída. Não conseguimos liberar as condições originais, mas temos uma *CONTRAPROPOSTA* aprovada para si:\n\n`;
    } else {
        msg = `🎉 *Boas notícias, ${nome.split(' ')[0]}!*\n\nA sua análise de crédito foi concluída e temos uma proposta aprovada para si:\n\n`;
    }

    msg += `💰 *Valor Liberado:* R$ ${Number(valor).toFixed(2)}\n`;
    
    if (parcelas > 1) {
        msg += `📅 *Plano:* ${parcelas}x de R$ ${Number(valorParcela).toFixed(2)} (${frequencia})\n\n`;
    } else {
        msg += `📅 *Plano:* Parcela Única em 30 Dias\n\n`;
    }

    msg += `Para ler os termos completos, aceitar a proposta e receber o seu PIX, clique no link oficial abaixo:\n🔗 ${linkAssinatura}`;
    
    return await enviarZap(numero, msg);
};

/**
 * Envia lembrete de cobrança (Vencimento Padrão)
 * Focado 100% em enviar o cliente para o Portal de Pagamento.
 */
const enviarLembreteVencimento = async (numero, nome, valor, dataVenc, linkPortal) => {
    const dataFormatada = new Date(dataVenc + 'T12:00:00Z').toLocaleDateString('pt-BR');
    let msg = `⏰ *LEMBRETE DE VENCIMENTO*\n\nOlá ${nome.split(' ')[0]}, a sua parcela de *R$ ${Number(valor).toFixed(2)}* vence a *${dataFormatada}*.\n`;
    
    // Sempre envia o link do portal para geração do IPIX
    msg += `\nPara gerar a sua chave PIX de pagamento, aceda ao seu portal exclusivo:\n🔗 ${linkPortal}`;

    return await enviarZap(numero, msg);
};

/**
 * [NOVO] AVISO DE ATRASO COM MULTA DIÁRIA (3%)
 * Envia sempre o link do Portal para regularização.
 */
const enviarAvisoAtraso = async (numero, nome, valorAtualizado, diasAtraso, linkPortal) => {
    let msg = `⚠️ *AVISO DE ATRASO - ${diasAtraso} DIAS* ⚠️\n\nOlá ${nome.split(' ')[0]},\n\nIdentificámos que o seu contrato está em atraso.\nConforme as regras, foi aplicado o acréscimo de *3% ao dia* sobre o saldo.\n\n*Novo Valor Atualizado:* R$ ${Number(valorAtualizado).toFixed(2)}\n`;
    
    msg += `\nEvite que o seu saldo continue a crescer. Regularize hoje acedendo ao seu portal:\n🔗 ${linkPortal}`;
    
    return await enviarZap(numero, msg);
};

/**
 * Verifica status da Z-API
 */
const verificarStatusZapi = async () => {
    try {
        const url = `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}/status`;
        const res = await axios.get(url, { 
            headers: { 'client-token': process.env.ZAPI_CLIENT_TOKEN },
            timeout: 7000 
        });
        const statusAtual = res.data.status || (res.data.connected ? 'CONNECTED' : 'DISCONNECTED');
        return { connected: statusAtual === 'CONNECTED', details: res.data };
    } catch (error) {
        return { connected: false, error: error.message };
    }
};

module.exports = {
    enviarZap,
    formatarNumero,
    verificarStatusZapi,
    enviarLembreteVencimento,
    enviarAvisoAtraso,
    enviarAprovacaoComTermos // 🚨 AGORA EXPORTADO CORRETAMENTE!
};