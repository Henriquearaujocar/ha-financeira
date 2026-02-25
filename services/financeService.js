const { supabase } = require('../database');

/**
 * Recalcula a dívida após um pagamento.
 * Lógica dividida entre Plano Parcelado Fixo vs Rotativo (Rolagem).
 */
const recalcularDivida = async (devedorId, valorPago) => {
    // 1. Busca o Devedor no Supabase
    const { data: dev, error } = await supabase
        .from('devedores')
        .select('*')
        .eq('id', devedorId)
        .single();

    if (error || !dev) return { erro: "Devedor não encontrado no Supabase" };

    // 2. Matemática Blindada (Evita bugs de dízima em floats)
    const pago = Math.round(parseFloat(valorPago) * 100) / 100;

    // Bloqueia pagamentos negativos, zerados ou falhas de webhook
    if (pago <= 0) return { erro: "O valor pago deve ser maior que zero." };

    const totalAnterior = Math.round(parseFloat(dev.valor_total) * 100) / 100;
    const capitalAtual = Math.round(parseFloat(dev.valor_emprestado) * 100) / 100;
    
    // Novo saldo devedor presumido
    let novoTotal = Math.round((totalAnterior - pago) * 100) / 100;

    // ==========================================
    // CENÁRIO A: QUITAÇÃO TOTAL DA DÍVIDA
    // ==========================================
    // Tolerância de 5 centavos para não prender o cliente por falha de dízima/arredondamento
    if (novoTotal <= 0.05) {
        await supabase.from('devedores').update({
            valor_emprestado: 0,
            valor_total: 0,
            pago: true,
            status: 'QUITADO'
        }).eq('id', dev.id);
        
        await supabase.from('logs').insert([{ 
            evento: "Quitação Total", 
            detalhes: `Pagamento de R$ ${pago.toFixed(2)} liquidou o contrato.`, 
            devedor_id: dev.id,
            valor_fluxo: pago 
        }]);
        
        return { sucesso: true, status: 'quitado' };
    }

    // ==========================================
    // CENÁRIO B: CRÉDITO PARCELADO (Fixo)
    // ==========================================
    if (dev.qtd_parcelas > 1) {
        // Num crédito parcelado, nós não rolamos juros sobre o saldo restante mensalmente!
        // Apenas abatemos o valor e avançamos a data de vencimento se ele pagou a parcela.
        
        const valorAproxParcela = Math.round((totalAnterior / dev.qtd_parcelas) * 100) / 100;
        let novoVencimento = dev.data_vencimento;
        let detalheLog = `Pagou R$ ${pago.toFixed(2)} de um plano parcelado. Saldo restante: R$ ${novoTotal.toFixed(2)}.`;

        // Tolerância (85%): Se o cliente teve uma multa pequena e pagou apenas o valor original da parcela,
        // o sistema aceita e avança a data, deixando o pequeno saldo devedor pro final.
        if (pago >= (valorAproxParcela * 0.85)) {
            const diasAdicionais = dev.frequencia === 'SEMANAL' ? 7 : 30;
            const dataObj = new Date(dev.data_vencimento + 'T12:00:00Z');
            dataObj.setDate(dataObj.getDate() + diasAdicionais);
            novoVencimento = dataObj.toISOString().split('T')[0];
            
            detalheLog += ` Vencimento avançado para ${novoVencimento}.`;
        } else {
            detalheLog += ` Valor muito baixo. Vencimento não foi alterado (Pgto Parcial).`;
        }

        await supabase.from('devedores').update({
            valor_total: novoTotal,
            data_vencimento: novoVencimento,
            pago: false,
            status: 'ABERTO'
        }).eq('id', dev.id);

        await supabase.from('logs').insert([{ 
            evento: "Pagamento de Parcela", 
            detalhes: detalheLog, 
            devedor_id: dev.id,
            valor_fluxo: pago
        }]);

        return { sucesso: true, status: 'parcela_abatida', novoVencimento };
    }

    // ==========================================
    // CENÁRIO C: CRÉDITO ROTATIVO (Única / Rolagem)
    // ==========================================
    const valorJurosAtual = Math.round((totalAnterior - capitalAtual) * 100) / 100;

    // Tolerância (95% dos Juros): Se ele pagou quase todo o juro do mês, o sistema faz a rolagem.
    if (pago >= (valorJurosAtual * 0.95) && valorJurosAtual > 0) {
        
        let taxaJuros = 30; // Fallback
        const { data: conf } = await supabase.from('config').select('valor').eq('chave', 'juros_unico').single();
        if (conf && conf.valor) taxaJuros = parseFloat(conf.valor);

        const multiplicadorJuros = 1 + (taxaJuros / 100);
        
        // O que sobrou APÓS pagar os juros, abate no Capital Original
        const abateCapital = pago > valorJurosAtual ? Math.round((pago - valorJurosAtual) * 100) / 100 : 0;
        const novoCapital = Math.round((capitalAtual - abateCapital) * 100) / 100;
        
        // Recalcula o total com juros para o próximo mês em cima do novo capital reduzido
        const proximoTotal = Math.round((novoCapital * multiplicadorJuros) * 100) / 100; 
        
        const diasAdicionais = dev.frequencia === 'SEMANAL' ? 7 : 30;
        const novaDataVencimento = new Date(dev.data_vencimento + 'T12:00:00Z'); 
        novaDataVencimento.setDate(novaDataVencimento.getDate() + diasAdicionais);
        const dataFormatada = novaDataVencimento.toISOString().split('T')[0];

        await supabase.from('devedores').update({
            valor_emprestado: novoCapital,
            valor_total: proximoTotal,
            data_vencimento: dataFormatada,
            pago: false,
            status: 'ABERTO'
        }).eq('id', dev.id);

        await supabase.from('logs').insert([{ 
            evento: "Rolagem de Contrato", 
            detalhes: `Pagou R$ ${pago.toFixed(2)} (Cobriu juros). Capital reduzido para: R$ ${novoCapital.toFixed(2)}. Novo Total (+${taxaJuros}%): R$ ${proximoTotal.toFixed(2)}. Vencimento para ${dataFormatada}.`, 
            devedor_id: dev.id,
            valor_fluxo: pago
        }]);

        return { sucesso: true, status: 'rolado', novoVencimento: dataFormatada };
        
    } else {
        // PAGAMENTO MÍNIMO / PARCIAL (Não chegou a cobrir os juros mínimos)
        await supabase.from('devedores').update({ 
            valor_total: novoTotal 
        }).eq('id', dev.id);

        await supabase.from('logs').insert([{ 
            evento: "Pagamento Parcial (Incompleto)", 
            detalhes: `Pagou apenas R$ ${pago.toFixed(2)} e não cobriu os juros mensais. Saldo abatido para: R$ ${novoTotal.toFixed(2)}. Vencimento mantido em atraso.`, 
            devedor_id: dev.id,
            valor_fluxo: pago
        }]);

        return { sucesso: true, status: 'parcial_abatido' };
    }
};

module.exports = { recalcularDivida };