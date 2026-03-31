const axios = require('axios');

/**
 * Limpa o número e garante o formato internacional brasileiro
 */
const formatarNumero = (num) => {
    if (!num) return "";
    let limpo = num.replace(/\D/g, ''); 
    if (limpo.startsWith('0')) limpo = limpo.substring(1); // Remove o zero extra do DDD
    if (limpo.length === 10 || limpo.length === 11) limpo = `55${limpo}`;
    return limpo;
};

/**
 * Formata moeda para o padrão brasileiro no WhatsApp
 */
const formatarMoedaZap = (valor) => {
    return Number(valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/**
 * Função Core: Dispara a mensagem na API da Z-API
 */
const enviarZap = async (numeroRecebido, mensagem) => {
    const numeroFormatado = formatarNumero(numeroRecebido);
    if (!numeroFormatado) {
        console.error("Número inválido para envio:", numeroRecebido);
        return false;
    }

    try {
        const url = `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}/send-text`;
        
        await axios.post(url, {
            phone: numeroFormatado,
            message: mensagem
        }, {
            headers: { 'client-token': process.env.ZAPI_CLIENT_TOKEN }
        });
        
        console.log(`✅ CMS Ventures Zap p/ ${numeroFormatado}`);
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
        msg = `Olá, ${nome}! 🤝\n\nA sua análise na *CMS Ventures* foi concluída. Não conseguimos liberar as condições originais, mas temos uma *CONTRAPROPOSTA* aprovada para você:\n\n`;
    } else {
        msg = `🎉 *Boas notícias, ${nome}!*\n\nA sua análise na *CMS Ventures* foi concluída e temos uma proposta aprovada para você:\n\n`;
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
const enviarLembreteVencimento = async (numero, nome, valor, dataVenc, pixDados, saudacaoExtra = null) => {
    const dataFormatada = new Date(dataVenc + 'T12:00:00Z').toLocaleDateString('pt-BR');
    const valorTexto = Number(valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Se não for enviada uma saudação específica, usa a padrão
    let introducao = saudacaoExtra || `Lembramos que sua fatura de *R$ ${valorTexto}* vence em *${dataFormatada}*.`;

    let msg = `⏰ *CMS VENTURES - LEMBRETE*\n\nOlá ${nome}, tudo bem?\n\n${introducao}\n\n`;

    if (pixDados && pixDados.chave) {
        msg += `🏦 *DADOS PARA PAGAMENTO (PIX)*\n`;
        msg += `Favorecido: *${pixDados.nome}*\n`;
        msg += `Instituição: *${pixDados.banco}*\n\n`;
        msg += `Chave PIX:\n*${pixDados.chave}*\n\n`;
        msg += `⚠️ _Após o pagamento, envie o comprovante aqui para darmos baixa._\n\n`;
    }

    msg += `🤖 _Mensagem automática. Se precisar de ajuda, responda aqui._`;

    return await enviarZap(numero, msg);
};

/**
 * RÉGUA DE COBRANÇA ESCALONADA
 *
 * @param numero          — telefone do devedor
 * @param nome            — nome completo
 * @param valorAtualizado — saldo atual já com multas pendentes projetadas
 * @param capitalOriginal — valor_emprestado (capital puro, sem juros mensais)
 * @param diasAtraso      — dias corridos desde o vencimento
 * @param pixDados        — objeto PIX ou null
 * @param referencia1Nome — nome da referência para aviso dia 25+
 * @param multaAcumulada  — valor em R$ só das multas de atraso (separado dos juros mensais)
 *
 * Faixas:
 *   Dia  1–4  → Lembrete gentil com saldo atualizado + PIX
 *   Dia  5–14 → Tom mais firme, destaca crescimento diário
 *   Dia 15–24 → Sério, exibe multas acumuladas separadas
 *   Dia 25+   → Aviso de acionamento de referências + risco de calote
 */
const enviarReguaCobranca = async (numero, nome, valorAtualizado, capitalOriginal, diasAtraso, pixDados, referencia1Nome = null, multaAcumulada = null) => {
    const valorFmt    = formatarMoedaZap(valorAtualizado);
    const capitalFmt  = formatarMoedaZap(capitalOriginal);
    // Usa multaAcumulada se fornecida (só multa de atraso).
    // Fallback: diferença entre saldo e capital (mantém compatibilidade com chamadas antigas).
    const multaReal   = multaAcumulada !== null ? multaAcumulada : Math.max(0, valorAtualizado - capitalOriginal);
    const multaFmt    = formatarMoedaZap(multaReal);

    // Bloco PIX reutilizável
    const blocoPix = pixDados?.chave
        ? `🏦 *PAGUE AGORA VIA PIX:*\nFavorecido: *${pixDados.nome}*\nInstituição: *${pixDados.banco}*\n\nChave PIX:\n*${pixDados.chave}*\n\n`
        : `Para regularizar, entre em contato imediatamente.\n\n`;

    let msg = '';

    // ── DIA 1 a 4: gentil ──────────────────────────────────────────────
    if (diasAtraso <= 4) {
        msg  = `⏰ *CMS VENTURES — FATURA EM ABERTO*\n\n`;
        msg += `Olá ${nome}, tudo bem?\n\n`;
        msg += `Identificamos que sua fatura está em atraso há *${diasAtraso} dia${diasAtraso > 1 ? 's' : ''}*.\n\n`;
        msg += `📌 *Saldo atualizado (com multa):* R$ *${valorFmt}*\n\n`;
        msg += blocoPix;
        msg += `_Qualquer dúvida, é só responder aqui. Estamos à disposição!_ 😊`;

    // ── DIA 5 a 14: mais firme ─────────────────────────────────────────
    } else if (diasAtraso <= 14) {
        msg  = `⚠️ *CMS VENTURES — ATRASO: ${diasAtraso} DIAS*\n\n`;
        msg += `${nome}, sua fatura segue em aberto e *a dívida cresce a cada dia*.\n\n`;
        msg += `📌 Saldo atual (com multas): R$ *${valorFmt}*\n`;
        msg += `📌 Capital emprestado: R$ ${capitalFmt}\n`;
        msg += `📌 Multas acumuladas: R$ *${multaFmt}*\n\n`;
        msg += `Regularize o quanto antes para evitar que o valor continue aumentando.\n\n`;
        msg += blocoPix;
        msg += `_Mensagem automática. Dúvidas? Responda aqui._`;

    // ── DIA 15 a 24: sério ─────────────────────────────────────────────
    } else if (diasAtraso <= 24) {
        msg  = `🚨 *CMS VENTURES — COBRANÇA URGENTE (${diasAtraso} DIAS)*\n\n`;
        msg += `${nome}, sua situação está se agravando.\n\n`;
        msg += `Você está *${diasAtraso} dias* em atraso e até o momento não houve nenhum contato ou pagamento.\n\n`;
        msg += `💰 *Valor total devido (com multas):* R$ *${valorFmt}*\n`;
        msg += `📈 Multas acumuladas: R$ *${multaFmt}* — e continuam crescendo diariamente.\n\n`;
        msg += `Precisamos que você entre em contato *hoje* para regularizar ou negociar.\n\n`;
        msg += blocoPix;
        msg += `_Mensagem automática. Responda aqui ou ligue imediatamente._`;

    // ── DIA 25+: acionamento de referências ───────────────────────────
    } else {
        msg  = `🔴 *CMS VENTURES — NOTIFICAÇÃO FINAL (${diasAtraso} DIAS)*\n\n`;
        msg += `${nome}, esta é uma notificação formal.\n\n`;
        msg += `Sua dívida de R$ *${valorFmt}* está há *${diasAtraso} dias* em aberto sem qualquer retorno.\n\n`;
        msg += `⚠️ *Caso não haja pagamento ou acordo até hoje:*\n`;
        if (referencia1Nome) {
            msg += `• Entraremos em contato com *${referencia1Nome}*, referência cadastrada no seu processo.\n`;
        }
        msg += `• O contrato será classificado como *CALOTE* em nosso sistema.\n`;
        msg += `• Seu CPF será incluído na *lista de restrição* da CMS Ventures.\n\n`;
        msg += blocoPix;
        msg += `_Evite consequências maiores. Responda agora._`;
    }

    return await enviarZap(numero, msg);
};

/**
 * Confirmação de pagamento recebido — disparada após cada baixa manual
 */
const enviarConfirmacaoBaixa = async (numero, nome, valorPago, novoSaldo, proximoVencimento, formaPagamento = 'PIX') => {
    const tagPgto    = formaPagamento === 'DINHEIRO' ? 'dinheiro em espécie' : 'PIX/transferência';
    const valorFmt   = formatarMoedaZap(valorPago);
    const saldoFmt   = formatarMoedaZap(novoSaldo);
    const dataHoje   = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    let msg  = `✅ *CMS VENTURES — PAGAMENTO CONFIRMADO*\n\n`;
    msg += `Olá ${nome}! Recebemos seu pagamento.\n\n`;
    msg += `📋 *Recibo:*\n`;
    msg += `• Valor recebido: R$ *${valorFmt}* (${tagPgto})\n`;
    msg += `• Data: ${dataHoje}\n`;

    if (novoSaldo <= 0.05) {
        msg += `\n🎉 *Parabéns! Seu contrato está totalmente quitado.*\n`;
        msg += `Agradecemos a confiança na CMS Ventures! Até a próxima. 🤝`;
    } else {
        msg += `• Saldo devedor atualizado: R$ *${saldoFmt}*\n`;
        if (proximoVencimento) {
            const dtVenc = new Date(proximoVencimento + 'T12:00:00Z').toLocaleDateString('pt-BR');
            msg += `• Próximo vencimento: *${dtVenc}*\n`;
        }
        msg += `\n_Qualquer dúvida, é só responder aqui. Obrigado!_ 🙏`;
    }

    return await enviarZap(numero, msg);
};

/**
 * Resumo diário enviado ao admin às 07h00
 */
const enviarResumoDiarioAdmin = async (numeroAdmin, dados) => {
    const { vencenteHoje, vencenteAmanha, atrasados, valorAtrasado,
            solicitacoesPendentes, recebidoOntem, caixaDisponivel } = dados;

    const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    let msg  = `☀️ *BOM DIA — CMS VENTURES*\n`;
    msg += `📅 Resumo de ${hoje}\n`;
    msg += `─────────────────────\n\n`;

    msg += `📆 *Vencem HOJE:* ${vencenteHoje} cliente${vencenteHoje !== 1 ? 's' : ''}\n`;
    msg += `📆 *Vencem AMANHÃ:* ${vencenteAmanha} cliente${vencenteAmanha !== 1 ? 's' : ''}\n\n`;

    msg += `⚠️ *Em atraso:* ${atrasados} contratos\n`;
    msg += `💸 *Valor em risco:* R$ ${formatarMoedaZap(valorAtrasado)}\n\n`;

    if (solicitacoesPendentes > 0) {
        msg += `🆕 *Solicitações pendentes:* ${solicitacoesPendentes} aguardando análise\n\n`;
    }

    msg += `💰 *Recebido ontem:* R$ ${formatarMoedaZap(recebidoOntem)}\n`;
    msg += `🏦 *Caixa disponível:* R$ ${formatarMoedaZap(caixaDisponivel)}\n\n`;
    msg += `_Tenha um ótimo dia! 🚀_`;

    return await enviarZap(numeroAdmin, msg);
};

/**
 * Confirmação de agendamento da segunda parte de um pagamento parcial.
 * Disparada quando o admin registra um pagamento parcial com data agendada
 * para o restante — informa o cliente do que foi recebido e o que está pendente.
 */
const enviarAgendamentoParcial = async (numero, nome, valorPago, valorRestante, dataAgendada, formaPagamento = 'PIX') => {
    const tagPgto     = formaPagamento === 'DINHEIRO' ? 'dinheiro em espécie' : 'PIX/transferência';
    const valorPagoFmt = formatarMoedaZap(valorPago);
    const restanteFmt  = formatarMoedaZap(valorRestante);
    const dataHoje     = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const dataAgFmt    = new Date(dataAgendada + 'T12:00:00Z').toLocaleDateString('pt-BR');

    let msg  = `✅ *CMS VENTURES — PAGAMENTO PARCIAL CONFIRMADO*\n\n`;
    msg += `Olá ${nome}! Recebemos parte do seu pagamento.\n\n`;
    msg += `📋 *Recibo parcial:*\n`;
    msg += `• Valor recebido hoje: R$ *${valorPagoFmt}* (${tagPgto})\n`;
    msg += `• Data: ${dataHoje}\n`;
    msg += `• Saldo restante: R$ *${restanteFmt}*\n\n`;
    msg += `📅 *Segunda parte agendada para: ${dataAgFmt}*\n\n`;
    msg += `_Lembramos que na data agendada enviaremos um lembrete. Qualquer dúvida, é só responder aqui!_ 🙏`;

    return await enviarZap(numero, msg);
};


const enviarAvisoAtraso = async (numero, nome, valorAtualizado, diasAtraso, pixDados) => {
    return await enviarReguaCobranca(numero, nome, valorAtualizado, valorAtualizado, diasAtraso, pixDados, null);
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
    formatarMoedaZap,
    verificarStatusZapi,
    enviarLembreteVencimento,
    enviarAvisoAtraso,           // legado
    enviarReguaCobranca,         // régua escalonada por dias de atraso
    enviarConfirmacaoBaixa,      // confirmação de pagamento integral/quitação
    enviarAgendamentoParcial,    // confirmação de pagamento parcial + data agendada
    enviarResumoDiarioAdmin,
    enviarAprovacaoComTermos
};