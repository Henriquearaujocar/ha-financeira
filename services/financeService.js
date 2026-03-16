const { supabase } = require('../database');

/**
 * Recalcula a dívida baseada no modelo de Parcelas Individuais.
 * Processa baixas parciais, totais, perdões e rolagem para faturas seguintes.
 */
const recalcularDivida = async (params) => {
    const { 
        parcelaId, 
        devedorId, 
        valorPago, 
        dataRecebimento, 
        formaPagamento = 'CONTA', 
        tratamentoRestante = 'MANTER_PARCIAL', 
        observacoes = '',
        descontoAplicado = 0
    } = params;

    // 1. Busca os dados da Parcela e do Contrato Pai (Devedor)
    const { data: parcela, error: errP } = await supabase.from('parcelas').select('*').eq('id', parcelaId).single();
    const { data: dev, error: errD } = await supabase.from('devedores').select('*').eq('id', devedorId).single();

    if (errP || !parcela) return { erro: "Parcela não encontrada no sistema." };
    if (errD || !dev) return { erro: "Contrato original não encontrado." };
    if (parcela.status === 'PAGA' || parcela.status === 'CANCELADA') return { erro: "Esta parcela já se encontra Paga ou Cancelada." };

    // 2. Padronização e Blindagem Anti-NaN (Tudo em 2 casas decimais)
    let pagoAgora = Math.round(parseFloat(valorPago || 0) * 100) / 100;
    let desconto = Math.round(parseFloat(descontoAplicado || 0) * 100) / 100;
    
    let valorAtualParcela = parseFloat(parcela.valor_atual || 0);
    let jaPagoNaParcela = parseFloat(parcela.valor_pago || 0);
    
    let faltaPagarNesta = Math.round((valorAtualParcela - jaPagoNaParcela) * 100) / 100;
    
    // 3. Verifica se houve excedente de pagamento (pagou a mais do que a parcela exige)
    let pagoExcedente = 0;
    if (pagoAgora > faltaPagarNesta) {
        pagoExcedente = pagoAgora - faltaPagarNesta;
        // Limita o valor a ser abatido nesta parcela ao máximo que ela exige
        pagoAgora = faltaPagarNesta; 
    }

    let saldoRestante = Math.round((faltaPagarNesta - pagoAgora - desconto) * 100) / 100;
    
    let novoStatusParcela = parcela.status;
    let novoValorAtualParcela = valorAtualParcela;
    let novoJaPagoNaParcela = jaPagoNaParcela + pagoAgora;
    let obsParcela = parcela.observacoes ? parcela.observacoes + " | " : "";

    // 4. MÁQUINA DE ESTADOS DA PARCELA
    if (saldoRestante <= 0.05) {
        // A. QUITAÇÃO DA PARCELA
        novoStatusParcela = 'PAGA';
        saldoRestante = 0;
        obsParcela += `[Liquidada] Pgto: R$ ${pagoAgora.toFixed(2)}. `;
        if (desconto > 0) obsParcela += `Desc: R$ ${desconto.toFixed(2)}. `;
    } 
    else {
        // B. PAGAMENTO PARCIAL E TRATAMENTO DO RESTANTE
        if (tratamentoRestante === 'JOGAR_PROXIMA') {
            novoStatusParcela = 'RENEGOCIADA';
            obsParcela += `[Rolagem] Faltou R$ ${saldoRestante.toFixed(2)}, movido p/ próxima. `;
            novoValorAtualParcela -= saldoRestante; // Retira a dívida desta parcela
            
            // Busca a próxima parcela do cliente
            const { data: prox } = await supabase.from('parcelas')
                .select('*')
                .eq('devedor_id', devedorId)
                .eq('numero_parcela', parcela.numero_parcela + 1)
                .single();
            
            if (prox) {
                // Infla a próxima parcela com o valor restante
                await supabase.from('parcelas').update({
                    valor_atual: parseFloat(prox.valor_atual) + saldoRestante,
                    observacoes: (prox.observacoes ? prox.observacoes + " | " : "") + `Adicionado R$ ${saldoRestante.toFixed(2)} da parc. #${parcela.numero_parcela}.`
                }).eq('id', prox.id);
            } else {
                // Fallback: Se for a última parcela e ele pediu para jogar pra próxima, cria uma parcela extra
                await supabase.from('parcelas').insert([{
                    devedor_id: devedorId,
                    numero_parcela: parcela.numero_parcela + 1,
                    valor_original: saldoRestante,
                    valor_atual: saldoRestante,
                    valor_pago: 0,
                    data_vencimento: new Date(new Date().setMonth(new Date().getMonth() + 1)).toISOString().split('T')[0],
                    status: 'PENDENTE',
                    observacoes: `Criada automaticamente por rolagem da parcela #${parcela.numero_parcela}.`
                }]);
            }
            saldoRestante = 0; 
        } 
        else if (tratamentoRestante === 'PERDOAR_RESTANTE') {
            novoStatusParcela = 'PAGA';
            obsParcela += `[Perdoado] Restante perdoado (Desc. de R$ ${saldoRestante.toFixed(2)}). `;
            novoValorAtualParcela -= saldoRestante; // A dívida evapora
            saldoRestante = 0;
        } 
        else {
            // C. MANTER PARCIAL (Padrão)
            novoStatusParcela = 'PARCIAL';
            obsParcela += `[Parcial] Pgto de R$ ${pagoAgora.toFixed(2)}. Resta R$ ${saldoRestante.toFixed(2)}. `;
        }
    }

    if (observacoes) obsParcela += `Nota: ${observacoes}`;

    // 5. ATUALIZA A PARCELA ATUAL NA BASE
    let dtPagamentoLocal = dataRecebimento;
    if (!dtPagamentoLocal) {
        dtPagamentoLocal = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"})).toISOString();
    }

    await supabase.from('parcelas').update({
        valor_pago: novoJaPagoNaParcela,
        valor_atual: novoValorAtualParcela,
        status: novoStatusParcela,
        observacoes: obsParcela,
        data_pagamento: novoStatusParcela === 'PAGA' ? dtPagamentoLocal : parcela.data_pagamento
    }).eq('id', parcelaId);

    // Se houve excedente, registramos um extra (Opcional para negócios onde se retém o lucro a mais)
    // Para simplificar a matemática do DRE, o excedente será jogado diretamente como Lucro no Log final.

    // 6. SINCRONIZAÇÃO GLOBAL (CONTRATO PAI) & MATEMÁTICA DO DRE
    const { data: todasParcelas } = await supabase.from('parcelas').select('*').eq('devedor_id', devedorId).not('status', 'in', '("CANCELADA")');
    
    let novoTotalGlobal = 0;
    let qtdPendentes = 0;
    let possuiAtrasoGlobal = false;
    let proximoVencimentoGlobal = null;

    const dataHojeArr = new Date().toISOString().split('T')[0];

    todasParcelas.forEach(p => {
        // Substitui temporariamente os valores se for a parcela que estamos iterando agora, pois o banco pode demorar 1ms para atualizar
        let valAtual = parseFloat(p.id === parcelaId ? novoValorAtualParcela : p.valor_atual);
        let valPago = parseFloat(p.id === parcelaId ? novoJaPagoNaParcela : p.valor_pago);
        let st = p.id === parcelaId ? novoStatusParcela : p.status;
        let saldoP = Math.round((valAtual - valPago) * 100) / 100;

        novoTotalGlobal += Math.max(0, saldoP);

        if (['PENDENTE', 'ATRASADO', 'PARCIAL', 'RENEGOCIADA'].includes(st)) {
            if (saldoP > 0) {
                qtdPendentes++;
                if (st === 'ATRASADO' || p.data_vencimento < dataHojeArr) possuiAtrasoGlobal = true;
                
                // Define o próximo vencimento global para o Dashboard
                if (!proximoVencimentoGlobal || p.data_vencimento < proximoVencimentoGlobal) {
                    proximoVencimentoGlobal = p.data_vencimento;
                }
            }
        }
    });

    let statusDevGlobal = dev.status;
    if (qtdPendentes === 0 && novoTotalGlobal <= 0) statusDevGlobal = 'QUITADO';
    else if (possuiAtrasoGlobal) statusDevGlobal = 'ATRASADO';
    else statusDevGlobal = 'ABERTO';

    // 7. DIVISÃO PARA O RELATÓRIO DRE (CAPITAL VS JUROS)
    // Calcula a proporção baseada no total inicial
    const totalOriginalDB = parseFloat(dev.valor_total) || 1;
    const capitalOriginalDB = parseFloat(dev.valor_emprestado) || 0;
    const proporcaoCapital = capitalOriginalDB / totalOriginalDB;
    
    const valorRealApurado = pagoAgora + pagoExcedente; // Dinheiro real que entrou hoje
    const capitalAbatido = valorRealApurado * proporcaoCapital;
    const jurosAbatido = valorRealApurado - capitalAbatido;

    let novoCapitalGlobal = Math.max(0, parseFloat(dev.valor_emprestado) - capitalAbatido);

    const tagPgto = formaPagamento === 'DINHEIRO' ? '[💸 ESPÉCIE]' : '[🏦 PIX/CONTA]';

    // 8. CHAMA A TRANSAÇÃO ACID DO BANCO DE DADOS
    let rpcPayload = {
        p_devedor_id: devedorId,
        p_pago: valorRealApurado,
        p_novo_total: novoTotalGlobal,
        p_capital: novoCapitalGlobal,
        p_status: statusDevGlobal,
        p_novo_vencimento: proximoVencimentoGlobal || dev.data_vencimento,
        p_novas_parcelas: Math.max(1, qtdPendentes),
        p_limpar_atraso: !possuiAtrasoGlobal, 
        p_evento: valorRealApurado > 0 ? "Recebimento de Parcela" : "Baixa por Desconto",
        p_detalhes: `${tagPgto} Parcela #${parcela.numero_parcela} atualizada. ${observacoes ? `Obs: ${observacoes}` : ''}`,
        p_transaction_id: `PGTO_${parcelaId}_${Date.now()}`,
        p_data_pagamento: dtPagamentoLocal,
        p_valor_capital: Math.round(capitalAbatido * 100) / 100,
        p_valor_juros: Math.round(jurosAbatido * 100) / 100
    };

    const { error: errDB } = await supabase.rpc('processar_transacao_financeira', rpcPayload);
    if (errDB) {
        console.error("❌ ERRO SQL processar_transacao_financeira:", errDB);
        return { erro: "Falha de Banco de Dados: " + errDB.message };
    }

    return { sucesso: true, status: statusDevGlobal, valorAbatido: valorRealApurado };
};

module.exports = { recalcularDivida };