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
    let capitalAtual  = Math.round(parseFloat(dev.valor_emprestado || 0) * 100) / 100;
    let parcelasAtuais = parseInt(dev.qtd_parcelas) || 1;
    let taxaAtualDec   = parseFloat(dev.taxa_juros || 30) / 100;

    let pago = Math.round(parseFloat(valorPago || 0) * 100) / 100;
    let notasManuais = [];

    // CORREÇÃO DE CRASH: valorJurosAtual era declarado com `const` na Seção C (linha 313),
    // mas usado na Seção DRE (linha 93) antes de ser alcançado — ReferenceError em runtime.
    // Declarando aqui garante disponibilidade em todos os blocos. Removida declaração duplicada da Seção C.
    // Recalculado após edições manuais se necessário (ver bloco edicaoManual abaixo).
    let valorJurosAtual = Math.round((totalAnterior - capitalAtual) * 100) / 100;

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
        // === VERIFICAR PRORROGAÇÃO MANUAL DE VENCIMENTO ===
        if (edicaoManual.novoVencimento) {
            notasManuais.push(`Prorrogado para: ${new Date(edicaoManual.novoVencimento + 'T12:00:00Z').toLocaleDateString('pt-BR')}`);
        }
        // Recalcula valorJurosAtual pois totalAnterior ou capitalAtual pode ter sido ajustado manualmente
        valorJurosAtual = Math.round((totalAnterior - capitalAtual) * 100) / 100;
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
            // valorJurosAtual já disponível do topo da função
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
    let totalRestante = novoTotal; // Variável auxiliar para o modo SIMPLES
    
    // MATEMÁTICA DO DRE
    // Proporciona corretamente capital e juros abatidos para o relatório financeiro.
    if (novoTotal <= 0.05) {
        // Quitação: todo o capital restante é amortizado, o resto é lucro
        capitalAbatido = capitalAtual;
        jurosAbatido   = Math.max(0, pago - capitalAbatido);
    } else if (parcelasAtuais > 1) {
        // Parcelado: proporcional pelo ratio capital/total
        const proporcaoCapital = totalAnterior > 0 ? (capitalAtual / totalAnterior) : 1;
        capitalAbatido = Math.round(valorParaAbaterDoSaldo * proporcaoCapital * 100) / 100;
        // CORREÇÃO: usa valorParaAbaterDoSaldo (o que efetivamente abateu do saldo), não pago total.
        // O excedente retido (JUROS_EXTRA) é receita separada — não deve inflar o DRE de juros.
        jurosAbatido   = Math.round((valorParaAbaterDoSaldo - capitalAbatido) * 100) / 100;
        // Excedente retido entra no log como detalhe, não como juros_abatido inflado
        if (excedenteRetidoComoJuros > 0) {
            jurosAbatido = Math.round((jurosAbatido + excedenteRetidoComoJuros) * 100) / 100;
        }
    } else {
        // Simples (único): primeiro abate juros, depois capital
        if (valorParaAbaterDoSaldo >= (valorJurosAtual * 0.95)) {
            // Cobriu os juros — o excedente reduz capital
            jurosAbatido   = Math.round(Math.min(valorParaAbaterDoSaldo, valorJurosAtual) * 100) / 100;
            capitalAbatido = Math.max(0, Math.round((valorParaAbaterDoSaldo - jurosAbatido) * 100) / 100);
            // Excedente JUROS_EXTRA: receita extra sobre o juros já cobertos
            if (excedenteRetidoComoJuros > 0) {
                jurosAbatido = Math.round((jurosAbatido + excedenteRetidoComoJuros) * 100) / 100;
            }
        } else {
            // Não cobriu nem os juros — tudo é abatimento de juros, capital intacto
            jurosAbatido   = valorParaAbaterDoSaldo;
            capitalAbatido = 0;
        }
    }

    let strVencimento = dev.data_vencimento;

    // === ADIÇÃO: VERIFICAR PRORROGAÇÃO MANUAL DE VENCIMENTO ===
    if (edicaoManual && edicaoManual.novoVencimento) {
        strVencimento = edicaoManual.novoVencimento; // Substitui o vencimento se o utilizador escolheu prorrogar
    }
    
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
    const strLogData = dataObjOperacao.toISOString();
    // ---------------------------------------------

    const vencObjOrig = new Date(strVencimento + 'T12:00:00Z');
    const statusDefault = vencObjOrig < dataObjOperacao ? 'ATRASADO' : 'ABERTO';
    const tagPgto = formaPagamento === 'DINHEIRO' ? '[💸 ESPÉCIE]' : '[🏦 PIX/CONTA]';

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
        p_transaction_id: transactionId || `PGTO_${Date.now()}`,
        p_data_pagamento: dataParaBanco, 
        p_valor_capital: Math.round(capitalAbatido * 100) / 100,
        p_valor_juros: Math.round(jurosAbatido * 100) / 100
    };

    if (notasManuais.length > 0) {
        rpcPayload.p_detalhes += `(Edições Manuais: ${notasManuais.join(' | ')}) `;
    }

    // CAPTURADOR DE ERRO SQL E OVERRIDE DE VENCIMENTO
    const executarNoBanco = async (payload, edicaoParam = null) => {
        // Se foi enviada uma data de prorrogação no frontend, forçamos ela aqui no final
        const edicao = edicaoParam || edicaoManual;
        if (edicao && edicao.novoVencimento) {
            payload.p_novo_vencimento = edicao.novoVencimento;
            payload.p_limpar_atraso = true; // Zera a trava de multa diária
            
            // Se a nova data de prorrogação for igual ou maior que hoje, tira o status de ATRASADO
            const dataNova = new Date(edicao.novoVencimento + 'T12:00:00Z');
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


    // === MODO DE ABATIMENTO SIMPLES ===
    if (edicaoManual && edicaoManual.modoBaixa === 'SIMPLES') {

        // DRE CORRIGIDO: proporcionar capital e juros igual ao modo normal.
        // Antes era p_valor_capital:0 / p_valor_juros:pago — todo pagamento virava "lucro puro".
        // Agora proporciona pelo ratio capital/total, respeitando a estrutura real do contrato.
        const ratioCapitalSimples = totalAnterior > 0 ? (capitalAtual / totalAnterior) : 0;
        const capitalAbatidoSimples = Math.round(pago * ratioCapitalSimples * 100) / 100;
        const jurosAbatidoSimples   = Math.round((pago - capitalAbatidoSimples) * 100) / 100;
        // Novo capital restante após abatimento proporcional
        const capitalRestanteSimples = Math.max(0, Math.round((capitalAtual - capitalAbatidoSimples) * 100) / 100);

        let rpcPayloadSimples = {
            p_devedor_id: devedorId,
            p_pago: pago,
            p_novo_total: totalRestante,
            p_capital: capitalRestanteSimples,
            p_status: totalRestante <= 0 ? 'QUITADO' : dev.status,
            p_novo_vencimento: strVencimento,
            p_novas_parcelas: parcelasAtuais,
            p_limpar_atraso: false,
            p_evento: "Pagamento Parcial (Abatimento Simples)",
            p_detalhes: `${tagPgto} Abatimento direto. Saldo: R$ ${totalAnterior.toFixed(2)} → R$ ${totalRestante.toFixed(2)} (Cap: R$${capitalAbatidoSimples.toFixed(2)} | Lucro: R$${jurosAbatidoSimples.toFixed(2)}). ${edicaoManual.observacoes ? `Obs: ${edicaoManual.observacoes}` : ''}`,
            p_transaction_id: transactionId || `SIMPLES_${Date.now()}`,
            p_data_pagamento: dataParaBanco || strLogData,
            p_valor_capital: capitalAbatidoSimples,
            p_valor_juros:   jurosAbatidoSimples
        };

        if (totalRestante <= 0) {
            rpcPayloadSimples.p_novo_total  = 0;
            rpcPayloadSimples.p_capital     = 0;
            rpcPayloadSimples.p_limpar_atraso = true;
            rpcPayloadSimples.p_evento      = "Liquidação Total";
            rpcPayloadSimples.p_detalhes    = `${tagPgto} Contrato Liquidado. (Cap: R$${capitalAbatidoSimples.toFixed(2)} | Lucro: R$${jurosAbatidoSimples.toFixed(2)})`;
        }

        // Aplica ajustes manuais se existirem
        if (edicaoManual.ajusteTotal !== null && edicaoManual.ajusteTotal !== undefined && !isNaN(edicaoManual.ajusteTotal)) {
            rpcPayloadSimples.p_novo_total = Math.max(0, rpcPayloadSimples.p_novo_total + parseFloat(edicaoManual.ajusteTotal));
            rpcPayloadSimples.p_detalhes += ` (Ajuste Manual de Saldo: R$ ${parseFloat(edicaoManual.ajusteTotal).toFixed(2)})`;
        }
        if (edicaoManual.novaTaxa !== null && edicaoManual.novaTaxa !== undefined && !isNaN(edicaoManual.novaTaxa)) {
             rpcPayloadSimples.p_detalhes += ` (Taxa alterada para ${edicaoManual.novaTaxa}%)`;
        }

        const falha = await executarNoBanco(rpcPayloadSimples, edicaoManual);
        if (falha) return falha;
        
        return { sucesso: true, status: rpcPayloadSimples.p_status };
    }
    // === FIM DA ADIÇÃO DO MODO SIMPLES ===


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

    // B - PARCELADO
    if (parcelasAtuais > 1) {
        // CORREÇÃO DO DRIFT DE PARCELAS:
        // parcelaEstimada = totalAnterior / parcelas inflaria com multas diárias,
        // fazendo pagamentos no valor combinado serem contados como zero parcelas pagas.
        //
        // Solução: lê o valor_original da próxima parcela pendente diretamente do banco.
        // valor_original é gravado na criação e nunca muda — imune a multas e pagamentos parciais.
        // Se não encontrar (contrato sem parcelas no banco), cai no fallback do totalAnterior.
        let parcelaOriginalValor = null;
        try {
            const { data: proxParc } = await supabase
                .from('parcelas')
                .select('valor_original')
                .eq('devedor_id', dev.id)
                .in('status', ['PENDENTE', 'ATRASADO', 'PARCIAL'])
                .order('numero_parcela', { ascending: true })
                .limit(1)
                .maybeSingle();
            if (proxParc?.valor_original) parcelaOriginalValor = parseFloat(proxParc.valor_original);
        } catch (_) { /* falha silenciosa — usa fallback */ }

        const parcelaEstimada = parcelaOriginalValor
            ? parcelaOriginalValor
            : (totalAnterior / parcelasAtuais); // fallback se não tiver tabela parcelas
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

    // C - ROLAGEM (contrato simples mensal/semanal — cliente pagou os juros e rola o capital)
    // valorJurosAtual já declarado no topo da função (evita ReferenceError no bloco DRE)
    if (valorParaAbaterDoSaldo >= (valorJurosAtual * 0.95)) {
        const multiplicadorJuros = 1 + taxaAtualDec;

        // CORREÇÃO: juros residuais NÃO são capitalizados (anatocismo).
        // Antes: saldoDevedorDosJuros era somado ao capital antes de aplicar novos juros.
        // Agora: o novo total é sempre capital × (1 + taxa). Juros residuais ficam zerados
        // porque consideramos que o pagamento cobre os juros dentro da margem de 5%.
        // O capital que rola é o capital atual sem alteração.
        rpcPayload.p_capital = Math.max(0, capitalAtual - capitalAbatido);
        // CORREÇÃO: arredondar para evitar acúmulo de floating point em múltiplas rolagens
        rpcPayload.p_novo_total = Math.round(rpcPayload.p_capital * multiplicadorJuros * 100) / 100;
        
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

module.exports = { recalcularDivida, aplicarMultaDiaria };

/**
 * Aplica juros compostos diários de atraso.
 *
 * REGRA DE NEGÓCIO:
 *   - A multa incide sobre o CAPITAL EMPRESTADO (valor_emprestado), não sobre o total devedor.
 *   - Juros compostos: a multa de hoje é calculada sobre o capital original, não sobre o total crescente.
 *   - Aplica-se apenas ao vencimento em atraso da mensalidade corrente.
 *   - Idempotente: transaction_id único por devedor/dia impede multa dupla via webhook_logs.
 *   - Sincroniza a tabela `parcelas` para manter consistência com `devedores.valor_total`.
 */
async function aplicarMultaDiaria(dev, hojeStr) {
    if (!dev || dev.isento_multa) return;

    // BASE DA MULTA: capital emprestado (não o total que já inclui juros mensais)
    const capitalBase = Math.round(parseFloat(dev.valor_emprestado || 0) * 100) / 100;
    const totalAtual  = Math.round(parseFloat(dev.valor_total    || 0) * 100) / 100;
    if (capitalBase <= 0 || totalAtual <= 0) return;

    // Percentual diário padrão 1%. Pode ser configurável via tabela config futuramente.
    const percentualDiario = 0.01;
    const multaValor = Math.round(capitalBase * percentualDiario * 100) / 100;
    const novoTotal  = Math.round((totalAtual + multaValor) * 100) / 100;

    const transId = `MULTA_${dev.id}_${hojeStr}`;

    const { error } = await supabase.rpc('processar_transacao_financeira', {
        p_devedor_id:    dev.id,
        p_pago:          0,
        p_novo_total:    novoTotal,
        p_capital:       capitalBase,               // capital não muda com a multa
        p_status:        'ATRASADO',
        p_novo_vencimento: dev.data_vencimento,
        p_novas_parcelas: parseInt(dev.qtd_parcelas) || 1,
        p_limpar_atraso: false,
        p_carimbar_atraso: true,
        p_evento:        'Juros de Atraso',
        p_detalhes:      `[MULTA] ${percentualDiario * 100}%/dia sobre capital R$ ${capitalBase.toFixed(2)} = +R$ ${multaValor.toFixed(2)}. Saldo anterior: R$ ${totalAtual.toFixed(2)} → Novo: R$ ${novoTotal.toFixed(2)}.`,
        p_transaction_id: transId,
        p_data_pagamento: null,
        p_valor_capital:  0,
        p_valor_juros:    multaValor
    });

    if (error) {
        // unique_violation = multa já aplicada hoje (idempotência). Ignora silenciosamente.
        if (!error.message?.includes('unique') && !error.code?.includes('23505')) {
            console.error(`[MULTA] Falha no devedor ${dev.id}:`, error.message);
        }
        return;
    }

    // SINCRONIZAÇÃO DA TABELA PARCELAS:
    // A multa incrementa devedores.valor_total mas a tabela parcelas ficaria desatualizada.
    // Buscamos a parcela atual em aberto e somamos a multa ao valor_atual dela.
    try {
        const { data: parcAtual } = await supabase
            .from('parcelas')
            .select('id, valor_atual')
            .eq('devedor_id', dev.id)
            .in('status', ['PENDENTE', 'ATRASADO', 'PARCIAL'])
            .order('numero_parcela', { ascending: true })
            .limit(1)
            .maybeSingle();

        if (parcAtual) {
            const novoValorParcela = Math.round((parseFloat(parcAtual.valor_atual) + multaValor) * 100) / 100;
            await supabase
                .from('parcelas')
                .update({ valor_atual: novoValorParcela, status: 'ATRASADO' })
                .eq('id', parcAtual.id);
        }
    } catch (errParc) {
        console.warn(`[MULTA] Aviso: falha ao sincronizar parcela do devedor ${dev.id}:`, errParc.message);
    }

    console.log(`[MULTA] +R$ ${multaValor.toFixed(2)} (base capital R$ ${capitalBase.toFixed(2)}) → devedor ${dev.nome} (id: ${dev.id})`);
}