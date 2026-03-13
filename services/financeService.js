const { supabase } = require('../database');

/**
 * Recalcula a dívida (Amortização Real) e processa edições manuais garantindo o princípio ACID.
 */
const recalcularDivida = async (devedorId, valorPago, transactionId = null, dataRecebimento = null, formaPagamento = 'CONTA', tratamento = 'AMORTIZAR', edicaoManual = null) => {
    
    const { data: dev, error } = await supabase.from('devedores').select('*').eq('id', devedorId).single();
    
    if (error || !dev) return { erro: "Devedor não encontrado na base de dados." };
    if (dev.status === 'QUITADO' || dev.pago === true) return { erro: "Operação Bloqueada: Contrato já quitado." };

    // BLINDAGEM ANTI-NaN: Força rigorosamente tudo a ser Número
    let totalAnterior = Math.round(parseFloat(dev.valor_total || 0) * 100) / 100;
    let capitalAtual = Math.round(parseFloat(dev.valor_emprestado || 0) * 100) / 100;
    let parcelasAtuais = parseInt(dev.qtd_parcelas) || 1;
    let taxaAtualDec = parseFloat(dev.taxa_juros || 30) / 100;
    
    let pago = Math.round(parseFloat(valorPago || 0) * 100) / 100;
    let notasManuais = [];

    // --- APLICAÇÃO DE EDIÇÃO MANUAL ANTES DO PAGAMENTO ---
    if (edicaoManual) {
        if (edicaoManual.recalculoAjuste !== null && edicaoManual.recalculoAjuste !== undefined) {
            const ajuste = parseFloat(edicaoManual.recalculoAjuste) || 0;
            totalAnterior += ajuste;
            notasManuais.push(`Ajuste de Saldo: ${ajuste > 0 ? '+' : ''}${ajuste.toFixed(2)}`);
        }
        if (edicaoManual.recalculoTaxa !== null && edicaoManual.recalculoTaxa !== undefined) {
            taxaAtualDec = parseFloat(edicaoManual.recalculoTaxa) / 100 || 0;
            notasManuais.push(`Nova Taxa: ${edicaoManual.recalculoTaxa}%`);
        }
        if (edicaoManual.recalculoParcelas !== null && edicaoManual.recalculoParcelas !== undefined) {
            parcelasAtuais = parseInt(edicaoManual.recalculoParcelas) || 1;
            notasManuais.push(`Novo Prazo: ${parcelasAtuais}x`);
        }
        if (edicaoManual.novoVencimento) {
            notasManuais.push(`Prorrogado para: ${new Date(edicaoManual.novoVencimento + 'T12:00:00Z').toLocaleDateString('pt-BR')}`);
        }
    }

    let valorParaAbaterDoSaldo = pago;
    let jurosAbatido = 0;
    let capitalAbatido = 0;
    let excedenteRetidoComoJuros = 0;

    // MOTOR DE RETENÇÃO DE LUCRO
    if (pago > 0 && tratamento === 'JUROS_EXTRA' && pago < totalAnterior) {
        if (parcelasAtuais > 1) {
            const parcelaEstimada = totalAnterior / parcelasAtuais;
            if (parcelaEstimada > 0 && pago > parcelaEstimada) {
                let numParcPagas = Math.floor(pago / parcelaEstimada);
                valorParaAbaterDoSaldo = numParcPagas * parcelaEstimada;
                excedenteRetidoComoJuros = pago - valorParaAbaterDoSaldo;
            }
        } else {
            const valorJurosAtual = totalAnterior - capitalAtual;
            if (pago > valorJurosAtual) {
                valorParaAbaterDoSaldo = valorJurosAtual;
                excedenteRetidoComoJuros = pago - valorJurosAtual;
            }
        }
    }

    if (pago >= totalAnterior) {
        valorParaAbaterDoSaldo = pago;
        excedenteRetidoComoJuros = 0;
    }

    let novoTotal = Math.max(0, Math.round((totalAnterior - valorParaAbaterDoSaldo) * 100) / 100);

    // MATEMÁTICA DO DRE
    if (novoTotal <= 0.05) {
        capitalAbatido = capitalAtual;
        jurosAbatido = pago - capitalAbatido;
    } else if (parcelasAtuais > 1) {
        const proporcaoCapital = totalAnterior > 0 ? (capitalAtual / totalAnterior) : 1;
        capitalAbatido = valorParaAbaterDoSaldo * proporcaoCapital;
        jurosAbatido = pago - capitalAbatido;
    } else { 
        const valorJurosAtual = totalAnterior - capitalAtual;
        if (valorParaAbaterDoSaldo >= (valorJurosAtual * 0.95)) {
            jurosAbatido = valorJurosAtual + excedenteRetidoComoJuros;
            capitalAbatido = Math.max(0, pago - jurosAbatido);
        } else {
            jurosAbatido = pago; 
            capitalAbatido = 0;
        }
    }

    let strVencimento = dev.data_vencimento;
    
    // --- CORREÇÃO DE FUSO HORÁRIO E HORA EXATA ---
    let dataObjOperacao = new Date();
    let dataParaBanco = null;

    if (dataRecebimento) {
        if (dataRecebimento.includes('T')) {
            // Se já vier com a hora exata do frontend, usa ela mesma
            dataObjOperacao = new Date(dataRecebimento);
            dataParaBanco = dataRecebimento;
        } else {
            // Se for apenas o dia (pagamento retroativo), crava meio-dia no fuso do Brasil
            dataObjOperacao = new Date(dataRecebimento + 'T12:00:00-03:00');
            dataParaBanco = dataRecebimento + 'T12:00:00-03:00';
        }
    }
    // ---------------------------------------------

    const vencObjOrig = new Date(strVencimento + 'T12:00:00Z');
    const statusDefault = vencObjOrig < dataObjOperacao ? 'ATRASADO' : 'ABERTO';
    const tagPgto = formaPagamento === 'DINHEIRO' ? '[DINHEIRO]' : '[CONTA/PIX]';

    let rpcPayload = {
        p_devedor_id: dev.id, 
        p_pago: pago, 
        p_novo_total: novoTotal, 
        p_capital: Math.max(0, capitalAtual - capitalAbatido),
        p_status: statusDefault, 
        p_novo_vencimento: strVencimento, 
        p_novas_parcelas: parcelasAtuais,
        p_limpar_atraso: false, 
        p_evento: '', 
        p_detalhes: '', 
        p_transaction_id: transactionId,
        p_data_pagamento: dataParaBanco, 
        p_valor_capital: Math.round(capitalAbatido * 100) / 100,
        p_valor_juros: Math.round(jurosAbatido * 100) / 100
    };

    if (notasManuais.length > 0) {
        rpcPayload.p_detalhes += `(Edições Manuais: ${notasManuais.join(' | ')}) `;
    }

    // CAPTURADOR DE ERRO SQL E OVERRIDE DE VENCIMENTO
    const executarNoBanco = async (payload) => {
        // Se foi enviada uma data de prorrogação no frontend, forçamos ela aqui no final
        if (edicaoManual && edicaoManual.novoVencimento) {
            payload.p_novo_vencimento = edicaoManual.novoVencimento;
            payload.p_limpar_atraso = true; // Zera a trava de multa diária
            
            // Se a nova data de prorrogação for igual ou maior que hoje, tira o status de ATRASADO
            const dataNova = new Date(edicaoManual.novoVencimento + 'T12:00:00Z');
            const dataHojeValida = new Date();
            dataHojeValida.setHours(0,0,0,0);
            
            if (dataNova >= dataHojeValida && payload.p_status !== 'QUITADO') {
                payload.p_status = 'ABERTO';
            }
        }

        const { error: errDB } = await supabase.rpc('processar_transacao_financeira', payload);
        if (errDB) {
            console.error("❌ ERRO SQL processar_transacao_financeira:", errDB);
            return { erro: "Falha de Banco de Dados: " + errDB.message };
        }
        return null;
    };

    // A - QUITAÇÃO TOTAL
    if (novoTotal <= 0.05) {
        rpcPayload.p_novo_total = 0;
        rpcPayload.p_status = 'QUITADO';
        rpcPayload.p_limpar_atraso = true;
        rpcPayload.p_evento = "Quitação Total";
        rpcPayload.p_detalhes += `${tagPgto} Liquidou o contrato. (Cap: R$${rpcPayload.p_valor_capital.toFixed(2)} | Lucro: R$${rpcPayload.p_valor_juros.toFixed(2)})`;
        
        const falha = await executarNoBanco(rpcPayload);
        if (falha) return falha;
        return { sucesso: true, status: 'quitado' };
    }

    if (edicaoManual && edicaoManual.modoBaixa === 'SIMPLES' && novoTotal > 0.05) {
        rpcPayload.p_evento = "Pagamento Parcial (Abatimento Simples)";
        rpcPayload.p_detalhes += `${tagPgto} Abateu R$ ${pago.toFixed(2)} direto do saldo. Resta R$ ${novoTotal.toFixed(2)}.`;

        if (vencObjOrig < dataObjOperacao && !rpcPayload.p_limpar_atraso) {
            rpcPayload.p_status = 'ATRASADO';
        } else {
            rpcPayload.p_status = 'ABERTO';
        }
        const falha = await executarNoBanco(rpcPayload);
        if (falha) return falha;
        return { sucesso: true, status: 'abatimento_simples', novoVencimento: rpcPayload.p_novo_vencimento };
        }

    // B - PARCELADO
    if (parcelasAtuais > 1) {
        const parcelaEstimada = totalAnterior / parcelasAtuais;
        let parcelasPagasInt = 0;
        if (parcelaEstimada > 0) {
            parcelasPagasInt = Math.floor(valorParaAbaterDoSaldo / parcelaEstimada);
            if ((valorParaAbaterDoSaldo - (parcelasPagasInt * parcelaEstimada)) >= (parcelaEstimada * 0.90)) parcelasPagasInt += 1;
        }

        rpcPayload.p_evento = pago > 0 ? (excedenteRetidoComoJuros > 0 ? "Pagamento + Juros Retidos" : "Pagamento de Parcela") : "Ajuste de Balcão";
        rpcPayload.p_detalhes += `${tagPgto} Abateu R$ ${pago.toFixed(2)} (Cap: R$${rpcPayload.p_valor_capital.toFixed(2)} | Lucro: R$${rpcPayload.p_valor_juros.toFixed(2)}).`;

        if (parcelasPagasInt > 0) {
            let dataBaseObj = new Date(strVencimento + 'T12:00:00Z');
            if (dev.frequencia === 'MENSAL') {
                const diaOriginal = dataBaseObj.getDate();
                dataBaseObj.setMonth(dataBaseObj.getMonth() + parcelasPagasInt);
                if (dataBaseObj.getDate() < diaOriginal && diaOriginal >= 28) dataBaseObj.setDate(0); 
            } else {
                dataBaseObj.setDate(dataBaseObj.getDate() + (7 * parcelasPagasInt));
            }
            rpcPayload.p_novo_vencimento = dataBaseObj.toISOString().split('T')[0];
            rpcPayload.p_novas_parcelas = Math.max(1, parcelasAtuais - parcelasPagasInt);
            
            if (dataBaseObj <= dataObjOperacao) {
                rpcPayload.p_status = 'ATRASADO'; 
                rpcPayload.p_detalhes += ` Ainda em ATRASO. Restam ${rpcPayload.p_novas_parcelas} parc.`;
            } else {
                rpcPayload.p_limpar_atraso = true; 
                rpcPayload.p_status = 'ABERTO';
                rpcPayload.p_detalhes += ` Ficou em dia. Restam ${rpcPayload.p_novas_parcelas} parc.`;
            }
        }
        const falha = await executarNoBanco(rpcPayload);
        if (falha) return falha;
        return { sucesso: true, status: 'parcela_abatida', novoVencimento: rpcPayload.p_novo_vencimento };
    }

    // C - ROLAGEM 30 DIAS
    const valorJurosAtual = totalAnterior - capitalAtual;
    if (valorParaAbaterDoSaldo >= (valorJurosAtual * 0.95)) {
        const multiplicadorJuros = 1 + taxaAtualDec;
        let saldoDevedorDosJuros = Math.max(0, valorJurosAtual - valorParaAbaterDoSaldo);
        
        rpcPayload.p_capital = Math.max(0, rpcPayload.p_capital + saldoDevedorDosJuros);
        rpcPayload.p_novo_total = rpcPayload.p_capital * multiplicadorJuros; 
        
        let dataReferencia = new Date(strVencimento + 'T12:00:00Z');
        if (dataReferencia < dataObjOperacao) dataReferencia = new Date(dataObjOperacao.getTime()); 
        dataReferencia.setDate(dataReferencia.getDate() + (dev.frequencia === 'SEMANAL' ? 7 : 30));
        
        rpcPayload.p_novo_vencimento = dataReferencia.toISOString().split('T')[0];
        rpcPayload.p_status = 'ABERTO';
        rpcPayload.p_limpar_atraso = true;
        rpcPayload.p_evento = "Rolagem de Contrato";
        rpcPayload.p_detalhes += `${tagPgto} Rolou com R$ ${pago.toFixed(2)} (Lucro Base: R$${rpcPayload.p_valor_juros.toFixed(2)}). Novo Venc: ${rpcPayload.p_novo_vencimento}.`;

        const falha = await executarNoBanco(rpcPayload);
        if (falha) return falha;
        return { sucesso: true, status: 'rolado', novoVencimento: rpcPayload.p_novo_vencimento };
    } else {
        rpcPayload.p_evento = "Pagamento Incompleto";
        rpcPayload.p_detalhes += `${tagPgto} R$ ${pago.toFixed(2)} não cobriu juros mínimos. Lucro extraído: R$${rpcPayload.p_valor_juros.toFixed(2)}.`;
        
        const falha = await executarNoBanco(rpcPayload);
        if (falha) return falha;
        return { sucesso: true, status: 'parcial_abatido', novoVencimento: rpcPayload.p_novo_vencimento };
    }
};

module.exports = { recalcularDivida };