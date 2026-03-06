const { supabase } = require('../database');

/**
 * Recalcula a dívida após um pagamento utilizando Transação ACID e Amortização Real.
 */
const recalcularDivida = async (devedorId, valorPago, transactionId = null, dataRecebimento = null, formaPagamento = 'CONTA', tratamento = 'AMORTIZAR') => {
    
    // 1. Busca Segura e Validação de Status
    const { data: dev, error } = await supabase.from('devedores').select('*').eq('id', devedorId).single();
    
    if (error || !dev) {
        return { erro: "Devedor não encontrado na base de dados." };
    }
    
    if (dev.status === 'QUITADO' || dev.pago === true) {
        return { erro: "Operação Bloqueada: Contrato já se encontra quitado." };
    }

    // 2. Sanitização e Separação de Juros Extra
    const pago = Math.round(parseFloat(valorPago) * 100) / 100;
    if (isNaN(pago) || pago <= 0) {
        return { erro: "O valor pago é inválido ou nulo." };
    }

    const totalAnterior = Math.round(parseFloat(dev.valor_total) * 100) / 100;
    const capitalAtual = Math.round(parseFloat(dev.valor_emprestado) * 100) / 100;
    
    let valorParaAbaterDoSaldo = pago;
    let excedenteRetidoComoJuros = 0;

    // 🚨 MOTOR DE RETENÇÃO DE LUCRO (Não amortece o excedente)
    if (tratamento === 'JUROS_EXTRA') {
        if (dev.qtd_parcelas > 1) {
            const parcelaEstimada = totalAnterior / Math.max(1, parseInt(dev.qtd_parcelas) || 1);
            if (pago > parcelaEstimada && pago < totalAnterior) {
                let numParcPagas = Math.floor(pago / parcelaEstimada);
                if (numParcPagas > 0) {
                    valorParaAbaterDoSaldo = numParcPagas * parcelaEstimada;
                    excedenteRetidoComoJuros = pago - valorParaAbaterDoSaldo;
                }
            }
        } else {
            const valorJurosAtual = Math.round((totalAnterior - capitalAtual) * 100) / 100;
            if (pago > valorJurosAtual && pago < totalAnterior) {
                valorParaAbaterDoSaldo = valorJurosAtual;
                excedenteRetidoComoJuros = pago - valorJurosAtual;
            }
        }
    }

    // Se o cliente pagar um valor que quita o total, forçamos a Quitação Padrão
    if (pago >= totalAnterior) {
        valorParaAbaterDoSaldo = pago;
        excedenteRetidoComoJuros = 0;
    }

    let novoTotal = Math.round((totalAnterior - valorParaAbaterDoSaldo) * 100) / 100; 
    if (novoTotal < 0) novoTotal = 0;

    // 3. Fuso Horário e Bloqueio de Derrapagem de Datas
    let strVencimento = dev.data_vencimento;
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
    const strDataOperacao = dataRecebimento ? dataRecebimento : formatter.format(new Date()); 
    const dataObjOperacao = new Date(strDataOperacao + 'T12:00:00Z');

    if (!strVencimento || isNaN(new Date(strVencimento).getTime())) {
        strVencimento = strDataOperacao;
    }

    const vencObjOrig = new Date(strVencimento + 'T12:00:00Z');
    const statusDefault = vencObjOrig < dataObjOperacao ? 'ATRASADO' : 'ABERTO';
    const tagPgto = formaPagamento === 'DINHEIRO' ? '[DINHEIRO]' : '[CONTA/PIX]';

    // 4. Estrutura Padrão de Atualização
    let rpcPayload = {
        p_devedor_id: dev.id, 
        p_pago: pago, // O valor PAGO (total) vai pro Banco para fins de relatórios e extratos
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
    // CENÁRIO A: QUITAÇÃO TOTAL (Liqüidação)
    // ==========================================
    if (novoTotal <= 0.05) {
        rpcPayload.p_novo_total = 0;
        rpcPayload.p_capital = capitalAtual;
        rpcPayload.p_status = 'QUITADO';
        rpcPayload.p_limpar_atraso = true;
        rpcPayload.p_evento = "Quitação Total";
        rpcPayload.p_detalhes = `${tagPgto} Pagamento de R$ ${pago.toFixed(2)} liquidou o contrato em definitivo.`;

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
        
        let parcelasPagasInt = Math.floor(valorParaAbaterDoSaldo / parcelaEstimada);
        let restoDoPagamento = valorParaAbaterDoSaldo - (parcelasPagasInt * parcelaEstimada);
        
        if (restoDoPagamento >= (parcelaEstimada * 0.90)) {
            parcelasPagasInt += 1;
        }

        const proporcaoCapital = totalAnterior > 0 ? (capitalAtual / totalAnterior) : 1;
        const abateCapital = valorParaAbaterDoSaldo * proporcaoCapital;
        rpcPayload.p_capital = Math.max(0, Math.round((capitalAtual - abateCapital) * 100) / 100);
        rpcPayload.p_capital = Math.min(rpcPayload.p_capital, rpcPayload.p_novo_total);

        rpcPayload.p_evento = excedenteRetidoComoJuros > 0 ? "Pagamento + Juros Retidos" : "Pagamento de Parcela";
        rpcPayload.p_detalhes = `${tagPgto} Pagou R$ ${pago.toFixed(2)}`;
        
        if (excedenteRetidoComoJuros > 0) {
            rpcPayload.p_detalhes += ` (Sendo R$ ${excedenteRetidoComoJuros.toFixed(2)} convertidos em lucro extra).`;
        }
        
        rpcPayload.p_detalhes += ` Saldo restante base: R$ ${novoTotal.toFixed(2)}.`;

        if (parcelasPagasInt > 0) {
            let dataBaseObj = new Date(strVencimento + 'T12:00:00Z');
            
            if (dev.frequencia === 'MENSAL') {
                const diaOriginal = dataBaseObj.getDate();
                dataBaseObj.setMonth(dataBaseObj.getMonth() + parcelasPagasInt);
                
                if (dataBaseObj.getDate() < diaOriginal && diaOriginal >= 28) {
                    dataBaseObj.setDate(0); 
                }
            } else {
                dataBaseObj.setDate(dataBaseObj.getDate() + (7 * parcelasPagasInt));
            }
            
            rpcPayload.p_novo_vencimento = dataBaseObj.toISOString().split('T')[0];
            rpcPayload.p_novas_parcelas = Math.max(1, qtdSegura - parcelasPagasInt);
            
            if (dataBaseObj <= dataObjOperacao) {
                rpcPayload.p_limpar_atraso = false; 
                rpcPayload.p_status = 'ATRASADO'; 
                rpcPayload.p_detalhes += ` Abateu ${parcelasPagasInt} parc. AINDA EM ATRASO. Venc: ${rpcPayload.p_novo_vencimento}. Restam ${rpcPayload.p_novas_parcelas} parc.`;
            } else {
                rpcPayload.p_limpar_atraso = true; 
                rpcPayload.p_status = 'ABERTO';
                rpcPayload.p_detalhes += ` Abateu ${parcelasPagasInt} parc. e ficou em dia. Venc: ${rpcPayload.p_novo_vencimento}. Restam ${rpcPayload.p_novas_parcelas} parc.`;
            }
        } else {
            rpcPayload.p_detalhes += ` Abatimento parcial no saldo. (Vencimento mantido).`;
        }

        const { error: rpcErr } = await supabase.rpc('processar_transacao_financeira', rpcPayload);
        if (rpcErr) throw new Error(rpcErr.message);

        return { sucesso: true, status: 'parcela_abatida', novoVencimento: rpcPayload.p_novo_vencimento };
    }

    // ==========================================
    // CENÁRIO C: ROLAGEM ÚNICA (30 Dias)
    // ==========================================
    const valorJurosAtual = Math.round((totalAnterior - capitalAtual) * 100) / 100;

    if (valorParaAbaterDoSaldo >= (valorJurosAtual * 0.95)) {
        let taxaJuros = parseFloat(dev.taxa_juros) || 30;
        const multiplicadorJuros = 1 + (taxaJuros / 100);
        let saldoDevedorDosJuros = Math.max(0, valorJurosAtual - valorParaAbaterDoSaldo);
        const abateCapital = valorParaAbaterDoSaldo > valorJurosAtual ? Math.round((valorParaAbaterDoSaldo - valorJurosAtual) * 100) / 100 : 0;
        
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
        
        rpcPayload.p_evento = excedenteRetidoComoJuros > 0 ? "Rolagem + Juros Extra" : "Rolagem de Contrato";
        rpcPayload.p_detalhes = `${tagPgto} Pagou R$ ${pago.toFixed(2)}`;
        if (excedenteRetidoComoJuros > 0) {
            rpcPayload.p_detalhes += ` (Excedente de R$ ${excedenteRetidoComoJuros.toFixed(2)} retido como taxa extra).`;
        }
        rpcPayload.p_detalhes += ` Cap Reajustado: R$ ${rpcPayload.p_capital.toFixed(2)}. Novo Total (+${taxaJuros}%): R$ ${rpcPayload.p_novo_total.toFixed(2)}. Venc: ${rpcPayload.p_novo_vencimento}.`;

        const { error: rpcErr } = await supabase.rpc('processar_transacao_financeira', rpcPayload);
        if (rpcErr) throw new Error(rpcErr.message);

        return { sucesso: true, status: 'rolado', novoVencimento: rpcPayload.p_novo_vencimento };
        
    } else {
        // PAGAMENTO INCOMPLETO
        const proporcaoCapitalMin = totalAnterior > 0 ? (capitalAtual / totalAnterior) : 1;
        const abateCapitalMin = valorParaAbaterDoSaldo * proporcaoCapitalMin;
        
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