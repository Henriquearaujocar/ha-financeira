const { supabase } = require('../database');

/**
 * Recalcula a dívida após um pagamento.
 * Lógica de Rolagem (Agiotagem) com Matemática Exata para Banco de Dados.
 */
const recalcularDivida = async (devedorId, valorPago) => {
    // 1. Busca o Devedor no Supabase
    const { data: dev, error } = await supabase
        .from('devedores')
        .select('*')
        .eq('id', devedorId)
        .single();

    if (error || !dev) return { erro: "Devedor não encontrado no Supabase" };

    // 2. Matemática Blindada (Evita bugs de dizima em floats)
    const pago = Math.round(parseFloat(valorPago) * 100) / 100;
    const totalAnterior = Math.round(parseFloat(dev.valor_total) * 100) / 100;
    const capitalAtual = Math.round(parseFloat(dev.valor_emprestado) * 100) / 100;
    
    // Novo total caso não haja rolagem
    let novoTotal = Math.round((totalAnterior - pago) * 100) / 100;

    if (novoTotal <= 0) {
        // --- 1. CLIENTE QUITOU TUDO ---
        await supabase.from('devedores').update({
            valor_emprestado: 0,
            valor_total: 0,
            pago: true,
            status: 'QUITADO'
        }).eq('id', dev.id);
        
        await supabase.from('logs').insert([{ 
            evento: "Quitação Total", 
            detalhes: `Pagamento de R$ ${pago.toFixed(2)} liquidou a dívida.`, 
            devedor_id: dev.id,
            valor_fluxo: pago // Registra o fluxo de caixa
        }]);
        
        return { sucesso: true, status: 'quitado' };
    }

    // Calcula qual é o valor apenas dos Juros
    const valorJurosAtual = Math.round((totalAnterior - capitalAtual) * 100) / 100;

    if (pago >= valorJurosAtual && valorJurosAtual > 0) {
        // --- 2. ROLAGEM DE DÍVIDA (Pagou os juros ou mais) ---
        
        const abateCapital = Math.round((pago - valorJurosAtual) * 100) / 100;
        const novoCapital = Math.round((capitalAtual - abateCapital) * 100) / 100;
        
        // Aplica os 30% (ou juros do sistema) para o PRÓXIMO MÊS em cima do novo capital
        const proximoTotal = Math.round((novoCapital * 1.30) * 100) / 100; 
        
        // Joga o vencimento para 30 dias pra frente
        const novaDataVencimento = new Date();
        novaDataVencimento.setDate(novaDataVencimento.getDate() + 30);
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
            detalhes: `Pagou R$ ${pago.toFixed(2)} (cobriu juros). Novo Capital: R$ ${novoCapital.toFixed(2)}. Novo Total (+30%): R$ ${proximoTotal.toFixed(2)}. Vencimento para ${dataFormatada}.`, 
            devedor_id: dev.id,
            valor_fluxo: pago
        }]);

        return { sucesso: true, status: 'rolado', novoVencimento: dataFormatada };
        
    } else {
        // --- 3. PAGAMENTO PARCIAL (Mixaria) - Não cobriu nem os juros ---
        
        await supabase.from('devedores').update({ 
            valor_total: novoTotal 
        }).eq('id', dev.id);

        await supabase.from('logs').insert([{ 
            evento: "Pagamento Parcial (Incompleto)", 
            detalhes: `Pagou apenas R$ ${pago.toFixed(2)}. Saldo restante: R$ ${novoTotal.toFixed(2)}. Vencimento não renovado.`, 
            devedor_id: dev.id,
            valor_fluxo: pago
        }]);

        return { sucesso: true, status: 'parcial_abatido' };
    }
};

module.exports = { recalcularDivida };