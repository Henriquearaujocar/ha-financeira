const { supabase } = require('../database');

/**
 * Recalcula a dívida após um pagamento utilizando Transação ACID (RPC).
 */
const recalcularDivida = async (devedorId, valorPago) => {
    const { data: dev, error } = await supabase
        .from('devedores')
        .select('*')
        .eq('id', devedorId)
        .single();

    if (error || !dev) return { erro: "Devedor não encontrado no Supabase" };

    if (dev.status === 'QUITADO' || dev.pago === true) {
        return { erro: "Operação bloqueada: Este contrato já se encontra totalmente quitado." };
    }

    const pago = Math.round(parseFloat(valorPago) * 100) / 100;
    if (isNaN(pago) || pago <= 0) return { erro: "O valor pago é inválido ou menor que zero." };

    const totalAnterior = Math.round(parseFloat(dev.valor_total) * 100) / 100;
    const capitalAtual = Math.round(parseFloat(dev.valor_emprestado) * 100) / 100;
    
    let novoTotal = Math.round((totalAnterior - pago) * 100) / 100;
    if (novoTotal < 0) novoTotal = 0;

    let strVencimento = dev.data_vencimento;
    const momentoBRT = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
    const strHojeBRT = `${momentoBRT.getFullYear()}-${String(momentoBRT.getMonth() + 1).padStart(2, '0')}-${String(momentoBRT.getDate()).padStart(2, '0')}`;
    const hojeObjBRT = new Date(strHojeBRT + 'T12:00:00Z');

    if (!strVencimento || isNaN(new Date(strVencimento).getTime())) {
        strVencimento = strHojeBRT;
    }

    // Variáveis que serão enviadas para o RPC do Supabase
    let rpcPayload = {
        p_devedor_id: dev.id,
        p_pago: pago,
        p_novo_total: novoTotal,
        p_capital: capitalAtual,
        p_status: 'ABERTO',
        p_novo_vencimento: strVencimento,
        p_novas_parcelas: dev.qtd_parcelas,
        p_limpar_atraso: false,
        p_evento: '',
        p_detalhes: ''
    };

    // ==========================================
    // CENÁRIO A: QUITAÇÃO TOTAL DA DÍVIDA
    // ==========================================
    if (novoTotal <= 0.05) {
        rpcPayload.p_novo_total = 0;
        rpcPayload.p_capital = 0;
        rpcPayload.p_status = 'QUITADO';
        rpcPayload.p_limpar_atraso = true;
        rpcPayload.p_evento = "Quitação Total";
        rpcPayload.p_detalhes = `Pagamento de R$ ${pago.toFixed(2)} liquidou o contrato.`;

        const { error: rpcErr } = await supabase.rpc('processar_transacao_financeira', rpcPayload);
        if (rpcErr) throw new Error(rpcErr.message);
        return { sucesso: true, status: 'quitado' };
    }

    // ==========================================
    // CENÁRIO B: CRÉDITO PARCELADO (Fixo)
    // ==========================================
    if (dev.qtd_parcelas > 1) {
        let qtdSegura = Math.max(1, parseInt(dev.qtd_parcelas) || 1);
        const parcelaEstimada = totalAnterior / qtdSegura;
        rpcPayload.p_detalhes = `Pagou R$ ${pago.toFixed(2)} de um plano parcelado. Saldo restante: R$ ${novoTotal.toFixed(2)}.`;
        rpcPayload.p_evento = "Pagamento de Parcela";

        let parcelasPagasInt = Math.floor(pago / parcelaEstimada);
        let restoDoPagamento = pago % parcelaEstimada;
        
        if (restoDoPagamento >= (parcelaEstimada * 0.85)) {
            parcelasPagasInt += 1;
        }

        if (parcelasPagasInt > 0) {
            const diasAdicionais = dev.frequencia === 'SEMANAL' ? (7 * parcelasPagasInt) : (30 * parcelasPagasInt);
            let dataBaseObj = new Date(strVencimento + 'T12:00:00Z');
            dataBaseObj.setDate(dataBaseObj.getDate() + diasAdicionais);
            
            rpcPayload.p_novo_vencimento = dataBaseObj.toISOString().split('T')[0];
            rpcPayload.p_novas_parcelas = Math.max(1, qtdSegura - parcelasPagasInt);
            rpcPayload.p_limpar_atraso = true; 
            rpcPayload.p_detalhes += ` Abateu ${parcelasPagasInt} parcela(s). Vencimento empurrado para ${rpcPayload.p_novo_vencimento}. Restam ${rpcPayload.p_novas_parcelas} parcelas.`;
        } else {
            rpcPayload.p_detalhes += ` Pagamento parcial (não cobriu uma parcela inteira). Vencimento mantido em atraso/aberto.`;
        }

        const proporcaoCapital = totalAnterior > 0 ? (capitalAtual / totalAnterior) : 1;
        const abateCapital = pago * proporcaoCapital;
        rpcPayload.p_capital = Math.max(0, Math.round((capitalAtual - abateCapital) * 100) / 100);

        const { error: rpcErr } = await supabase.rpc('processar_transacao_financeira', rpcPayload);
        if (rpcErr) throw new Error(rpcErr.message);

        return { sucesso: true, status: 'parcela_abatida', novoVencimento: rpcPayload.p_novo_vencimento };
    }

    // ==========================================
    // CENÁRIO C: CRÉDITO ROTATIVO (Única / Rolagem)
    // ==========================================
    const valorJurosAtual = Math.round((totalAnterior - capitalAtual) * 100) / 100;

    if (pago >= (valorJurosAtual * 0.95) && valorJurosAtual > 0) {
        
        // 🚨 CORREÇÃO: Utiliza a taxa gravada no perfil do cliente! Não a global. 
        // Se for um contrato muito antigo sem taxa gravada, aí sim usa a global.
        let taxaJuros = parseFloat(dev.taxa_juros);
        if (isNaN(taxaJuros)) {
            const { data: conf } = await supabase.from('config').select('valor').eq('chave', 'juros_unico').single();
            taxaJuros = conf && conf.valor ? parseFloat(conf.valor) : 30;
        }

        const multiplicadorJuros = 1 + (taxaJuros / 100);
        
        let saldoDevedorDosJuros = valorJurosAtual - pago;
        if (saldoDevedorDosJuros < 0) saldoDevedorDosJuros = 0; 

        const abateCapital = pago > valorJurosAtual ? Math.round((pago - valorJurosAtual) * 100) / 100 : 0;
        
        rpcPayload.p_capital = Math.max(0, Math.round((capitalAtual - abateCapital + saldoDevedorDosJuros) * 100) / 100);
        rpcPayload.p_novo_total = Math.round((rpcPayload.p_capital * multiplicadorJuros) * 100) / 100; 
        
        const diasAdicionais = dev.frequencia === 'SEMANAL' ? 7 : 30;
        
        let dataReferencia = new Date(strVencimento + 'T12:00:00Z');
        if (dataReferencia < hojeObjBRT) dataReferencia = new Date(hojeObjBRT.getTime()); 

        dataReferencia.setDate(dataReferencia.getDate() + diasAdicionais);
        rpcPayload.p_novo_vencimento = dataReferencia.toISOString().split('T')[0];
        
        rpcPayload.p_limpar_atraso = true;
        rpcPayload.p_evento = "Rolagem de Contrato";
        rpcPayload.p_detalhes = `Pagou R$ ${pago.toFixed(2)} (Cobriu juros). Capital reajustado para: R$ ${rpcPayload.p_capital.toFixed(2)}. Novo Total (+${taxaJuros}%): R$ ${rpcPayload.p_novo_total.toFixed(2)}. Vencimento para ${rpcPayload.p_novo_vencimento}.`;

        const { error: rpcErr } = await supabase.rpc('processar_transacao_financeira', rpcPayload);
        if (rpcErr) throw new Error(rpcErr.message);

        return { sucesso: true, status: 'rolado', novoVencimento: rpcPayload.p_novo_vencimento };
        
    } else {
        // PAGAMENTO MÍNIMO / PARCIAL 
        const proporcaoCapitalMin = totalAnterior > 0 ? (capitalAtual / totalAnterior) : 1;
        const abateCapitalMin = pago * proporcaoCapitalMin;
        rpcPayload.p_capital = Math.max(0, Math.round((capitalAtual - abateCapitalMin) * 100) / 100);
        
        rpcPayload.p_evento = "Pagamento Parcial (Incompleto)";
        rpcPayload.p_detalhes = `Pagou apenas R$ ${pago.toFixed(2)} e não cobriu os juros mensais. Saldo abatido para: R$ ${novoTotal.toFixed(2)}.`;

        const { error: rpcErr } = await supabase.rpc('processar_transacao_financeira', rpcPayload);
        if (rpcErr) throw new Error(rpcErr.message);

        return { sucesso: true, status: 'parcial_abatido' };
    }
};

module.exports = { recalcularDivida };