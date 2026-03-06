const { supabase } = require('../database');

/**
 * Recalcula a dívida após um pagamento utilizando Transação ACID (RPC).
 */
const recalcularDivida = async (devedorId, valorPago, transactionId = null, dataRecebimento = null, formaPagamento = 'CONTA') => {
    
    // 🚨 Extrai dados
    const { data: dev, error } = await supabase.from('devedores').select('*').eq('id', devedorId).single();
    
    if (error || !dev) {
        return { erro: "Devedor não encontrado na base de dados." };
    }
    
    if (dev.status === 'QUITADO' || dev.pago === true) {
        return { erro: "Operação bloqueada: Este contrato já se encontra totalmente quitado." };
    }

    // 🚨 Sanitização base
    const pago = Math.round(parseFloat(valorPago) * 100) / 100;
    if (isNaN(pago) || pago <= 0) {
        return { erro: "O valor pago é inválido ou menor que zero." };
    }

    const totalAnterior = Math.round(parseFloat(dev.valor_total) * 100) / 100;
    const capitalAtual = Math.round(parseFloat(dev.valor_emprestado) * 100) / 100;
    
    let novoTotal = Math.round((totalAnterior - pago) * 100) / 100; 
    if (novoTotal < 0) {
        novoTotal = 0;
    }

    let strVencimento = dev.data_vencimento;
    
    // 🚨 Fuso Horário Rigoroso Anti-Node.js Drift
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
    const strDataOperacao = dataRecebimento ? dataRecebimento : formatter.format(new Date()); 
    const dataObjOperacao = new Date(strDataOperacao + 'T12:00:00Z');

    if (!strVencimento || isNaN(new Date(strVencimento).getTime())) {
        strVencimento = strDataOperacao;
    }

    const vencObjOrig = new Date(strVencimento + 'T12:00:00Z');
    
    // Consciência Temporal: O pagamento parcial não limpa atrasos existentes
    const statusDefault = vencObjOrig < dataObjOperacao ? 'ATRASADO' : 'ABERTO';

    // 🚨 Tag para o Extrato Analítico
    const tagPgto = formaPagamento === 'DINHEIRO' ? '[DINHEIRO]' : '[CONTA/PIX]';

    // Payload Rigoroso de 12 Elementos
    let rpcPayload = {
        p_devedor_id: dev.id,
        p_pago: pago,
        p_novo_total: novoTotal,
        p_capital: capitalAtual,
        p_status: statusDefault, 
        p_novo_vencimento: strVencimento,
        p_novas_parcelas: dev.qtd_parcelas,
        p_limpar_atraso: false,
        p_evento: '',
        p_detalhes: '',
        p_transaction_id: transactionId,
        p_data_pagamento: dataRecebimento ? (dataRecebimento + 'T12:00:00Z') : null 
    };

    // ==========================================
    // CENÁRIO A: QUITAÇÃO TOTAL
    // ==========================================
    if (novoTotal <= 0.05) {
        rpcPayload.p_novo_total = 0;
        // 🚨 MANTIDO INTACTO: Preserva o histórico do que foi emprestado!
        rpcPayload.p_capital = capitalAtual; 
        rpcPayload.p_status = 'QUITADO';
        rpcPayload.p_limpar_atraso = true;
        rpcPayload.p_evento = "Quitação Total";
        rpcPayload.p_detalhes = `${tagPgto} Pagamento de R$ ${pago.toFixed(2)} liquidou o contrato.`;

        const { error: rpcErr } = await supabase.rpc('processar_transacao_financeira', rpcPayload);
        if (rpcErr) throw new Error(rpcErr.message);
        
        return { sucesso: true, status: 'quitado' };
    }

    // ==========================================
    // CENÁRIO B: CRÉDITO PARCELADO
    // ==========================================
    if (dev.qtd_parcelas > 1) {
        let qtdSegura = Math.max(1, parseInt(dev.qtd_parcelas) || 1);
        const parcelaEstimada = totalAnterior / qtdSegura;
        
        rpcPayload.p_detalhes = `${tagPgto} Pagou R$ ${pago.toFixed(2)} de um plano parcelado. Saldo restante: R$ ${novoTotal.toFixed(2)}.`;
        rpcPayload.p_evento = "Pagamento de Parcela";

        // 🚨 O Épsilon resolve o Float Bug de divisões como 0.9999999
        let parcelasPagasInt = Math.floor(pago / parcelaEstimada);
        let restoDoPagamento = pago - (parcelasPagasInt * parcelaEstimada);
        
        if (restoDoPagamento >= (parcelaEstimada * 0.85)) {
            parcelasPagasInt += 1;
        }

        if (parcelasPagasInt > 0) {
            let dataBaseObj = new Date(strVencimento + 'T12:00:00Z');

            // 🚨 Date Drift Fix: Usa setMonth para manter o dia do mês fixo em parcelados mensais
            if (dev.frequencia === 'MENSAL') {
                dataBaseObj.setMonth(dataBaseObj.getMonth() + parcelasPagasInt);
            } else {
                dataBaseObj.setDate(dataBaseObj.getDate() + (7 * parcelasPagasInt));
            }
            
            rpcPayload.p_novo_vencimento = dataBaseObj.toISOString().split('T')[0];
            rpcPayload.p_novas_parcelas = Math.max(1, qtdSegura - parcelasPagasInt);
            
            if (dataBaseObj <= dataObjOperacao) {
                rpcPayload.p_limpar_atraso = false; 
                rpcPayload.p_status = 'ATRASADO'; 
                rpcPayload.p_detalhes += ` Abateu ${parcelasPagasInt} parcela(s), mas continua em atraso. Novo vencimento: ${rpcPayload.p_novo_vencimento}. Restam ${rpcPayload.p_novas_parcelas} parcelas.`;
            } else {
                rpcPayload.p_limpar_atraso = true; 
                rpcPayload.p_status = 'ABERTO';
                rpcPayload.p_detalhes += ` Abateu ${parcelasPagasInt} parcela(s) e ficou em dia. Vencimento para ${rpcPayload.p_novo_vencimento}. Restam ${rpcPayload.p_novas_parcelas} parcelas.`;
            }
        } else {
            rpcPayload.p_detalhes += ` Pagamento parcial (não cobriu uma parcela inteira). Vencimento mantido.`;
        }

        // 🚨 MANTIDO INTACTO: Não destrói o histórico original
        rpcPayload.p_capital = capitalAtual;

        const { error: rpcErr } = await supabase.rpc('processar_transacao_financeira', rpcPayload);
        if (rpcErr) throw new Error(rpcErr.message);

        return { sucesso: true, status: 'parcela_abatida', novoVencimento: rpcPayload.p_novo_vencimento };
    }

    // ==========================================
    // CENÁRIO C: ROLAGEM / ROTATIVO ÚNICO
    // ==========================================
    const valorJurosAtual = Math.round((totalAnterior - capitalAtual) * 100) / 100;

    if (pago >= (valorJurosAtual * 0.95)) {
        
        let taxaJuros = parseFloat(dev.taxa_juros);
        if (isNaN(taxaJuros)) {
            const { data: conf } = await supabase.from('config').select('valor').eq('chave', 'juros_unico').maybeSingle();
            taxaJuros = conf && conf.valor ? parseFloat(conf.valor) : 30;
        }

        const multiplicadorJuros = 1 + (taxaJuros / 100);
        let saldoDevedorDosJuros = Math.max(0, valorJurosAtual - pago);
        const abateCapital = pago > valorJurosAtual ? Math.round((pago - valorJurosAtual) * 100) / 100 : 0;
        
        // Num rotativo, o capital real restante muda se ele pagar a mais.
        rpcPayload.p_capital = Math.max(0, Math.round((capitalAtual - abateCapital + saldoDevedorDosJuros) * 100) / 100);
        rpcPayload.p_novo_total = Math.round((rpcPayload.p_capital * multiplicadorJuros) * 100) / 100; 
        rpcPayload.p_capital = Math.min(rpcPayload.p_capital, rpcPayload.p_novo_total);
        
        let dataReferencia = new Date(strVencimento + 'T12:00:00Z');
        if (dataReferencia < dataObjOperacao) {
            dataReferencia = new Date(dataObjOperacao.getTime()); 
        }

        const diasAdicionais = dev.frequencia === 'SEMANAL' ? 7 : 30;
        dataReferencia.setDate(dataReferencia.getDate() + diasAdicionais);
        
        rpcPayload.p_novo_vencimento = dataReferencia.toISOString().split('T')[0];
        rpcPayload.p_status = 'ABERTO';
        rpcPayload.p_limpar_atraso = true;
        rpcPayload.p_evento = "Rolagem de Contrato";
        rpcPayload.p_detalhes = `${tagPgto} Pagou R$ ${pago.toFixed(2)} (Cobriu juros). Capital reajustado: R$ ${rpcPayload.p_capital.toFixed(2)}. Novo Total (+${taxaJuros}%): R$ ${rpcPayload.p_novo_total.toFixed(2)}. Vencimento para ${rpcPayload.p_novo_vencimento}.`;

        const { error: rpcErr } = await supabase.rpc('processar_transacao_financeira', rpcPayload);
        if (rpcErr) throw new Error(rpcErr.message);

        return { sucesso: true, status: 'rolado', novoVencimento: rpcPayload.p_novo_vencimento };
        
    } else {
        // PAGAMENTO PARCIAL (INCOMPLETO)
        const proporcaoCapitalMin = totalAnterior > 0 ? (capitalAtual / totalAnterior) : 1;
        const abateCapitalMin = pago * proporcaoCapitalMin;
        
        rpcPayload.p_capital = Math.max(0, Math.round((capitalAtual - abateCapitalMin) * 100) / 100);
        rpcPayload.p_capital = Math.min(rpcPayload.p_capital, rpcPayload.p_novo_total);
        
        rpcPayload.p_evento = "Pagamento Parcial (Incompleto)";
        rpcPayload.p_detalhes = `${tagPgto} Pagou apenas R$ ${pago.toFixed(2)} e não cobriu os juros mínimos. Saldo abatido para: R$ ${novoTotal.toFixed(2)}. (Vencimento mantido)`;

        const { error: rpcErr } = await supabase.rpc('processar_transacao_financeira', rpcPayload);
        if (rpcErr) throw new Error(rpcErr.message);

        return { sucesso: true, status: 'parcial_abatido' };
    }
};

module.exports = { recalcularDivida };