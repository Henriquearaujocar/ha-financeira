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
 * APROVAÇÃO E CONTRAPROPOSTA TRANSPARENTE
 */
const enviarAprovacaoComTermos = async (numero, nome, valor, parcelas, frequencia, valorParcela, linkAssinatura, isContraProposta = false) => {
    let msg = '';
    
    if (isContraProposta) {
        msg = `Olá, ${nome.split(' ')[0]}! 🤝\n\nA sua análise de crédito foi concluída. Não conseguimos liberar as condições originais, mas temos uma *CONTRAPROPOSTA* aprovada para você:\n\n`;
    } else {
        msg = `🎉 *Boas notícias, ${nome.split(' ')[0]}!*\n\nA sua análise de crédito foi concluída e temos uma proposta aprovada para você:\n\n`;
    }

    msg += `💰 *Valor Liberado:* R$ ${Number(valor).toFixed(2)}\n`;
    
    if (parcelas > 1) {
        msg += `📅 *Plano:* ${parcelas}x de R$ ${Number(valorParcela).toFixed(2)} (${frequencia})\n\n`;
    } else {
        msg += `📅 *Plano:* Parcela Única em 30 Dias\n\n`;
    }

    msg += `Para ler os termos completos, assinar digitalmente e receber o seu PIX, acesse o portal abaixo:\n🔗 ${linkAssinatura}`;
    
    return await enviarZap(numero, msg);
};

/**
 * Lembrete de Cobrança com PIX direto na mensagem
 */
const enviarLembreteVencimento = async (numero, nome, valor, dataVenc, pixDados) => {
    const dataFormatada = new Date(dataVenc + 'T12:00:00Z').toLocaleDateString('pt-BR');
    
    let msg = `⏰ *LEMBRETE DE VENCIMENTO*\n\nOlá ${nome.split(' ')[0]}, a sua fatura de *R$ ${Number(valor).toFixed(2)}* tem vencimento em *${dataFormatada}*.\n\n`;
    
    if (pixDados && pixDados.chave) {
        msg += `🏦 *DADOS PARA PAGAMENTO (PIX)*\n`;
        msg += `Para sua comodidade, realize a transferência para a conta oficial:\n\n`;
        msg += `Favorecido: *${pixDados.nome}*\n`;
        msg += `Instituição: *${pixDados.banco}*\n\n`;
        msg += `Copie a chave PIX abaixo:\n`;
        msg += `${pixDados.chave}\n\n`;
        msg += `⚠️ _Assim que realizar o pagamento, por favor, envie o comprovante de pagamento aqui nesta conversa para darmos baixa no sistema._\n\n`;
    }

    return await enviarZap(numero, msg);
};

/**
 * Aviso de Atraso Diário com PIX direto na mensagem
 */
const enviarAvisoAtraso = async (numero, nome, valorAtualizado, diasAtraso, pixDados) => {
    let msg = `⚠️ *AVISO DE ATRASO - ${diasAtraso} DIAS* ⚠️\n\nOlá ${nome.split(' ')[0]},\n\nIdentificamos que a sua fatura encontra-se em atraso.\n\nO valor atualizado (com as multas diárias aplicadas) é de *R$ ${Number(valorAtualizado).toFixed(2)}*.\n\n`;
    
    if (pixDados && pixDados.chave) {
        msg += `🏦 *REGULARIZE AGORA VIA PIX:*\n`;
        msg += `Favorecido: *${pixDados.nome}*\n`;
        msg += `Instituição: *${pixDados.banco}*\n\n`;
        msg += `Copie a chave PIX abaixo:\n`;
        msg += `${pixDados.chave}\n\n`;
        msg += `⚠️ _Evite que o seu saldo continue a crescer. Assim que pagar, envie-nos o comprovante de pagamento por aqui!_\n\n`;
    }
    
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
    enviarAprovacaoComTermos
};