const axios = require('axios');

/**
 * Gera um link de pagamento utilizando a API de Invoices da InfinitePay.
 */
async function gerarLinkCobranca(devedor, valor) {
    // 1. Garante que a URL do seu servidor está correta para receber o retorno
    // 🚨 FALLBACK SEGURO: Colado o seu domínio real da Render para evitar localhost
    let appUrl = process.env.APP_URL || "https://ha-financeira.onrender.com";
    
    if (appUrl.endsWith('/')) {
        appUrl = appUrl.slice(0, -1);
    }
    
    if (appUrl.includes('localhost')) {
        console.warn("⚠️ AVISO: O seu APP_URL é 'localhost'. A InfinitePay não conseguirá aceder ao seu computador para enviar a confirmação de pagamento automático.");
    }
    
    const valorCentavos = Math.round(parseFloat(valor) * 100);
    const tokenSecreto = process.env.WEBHOOK_SECRET || "cms_seguro_2024";

    // 🚨 2. PAYLOAD BLINDADO: Inclui Metadata, Webhook URL e a Tela de Sucesso
    const data = {
        "items": [
            {
                "id": "pagamento_avulso",
                "quantity": 1,
                "price": valorCentavos,
                "description": `Pgto HA Elite - ${devedor.nome.substring(0, 15)}`
            }
        ],
        "metadata": {
            "custom_id": devedor.uuid,
            "cpf": devedor.cpf
        },
        "payment_methods": ["pix", "credit_card"],
        // Força a InfinitePay a notificar a API da Render assim que o cliente pagar
        "callback_url": `${appUrl}/webhook-infinitepay/${tokenSecreto}`,
        // Devolve o cliente para a sua página bonita de "Pedido Recebido!" após pagar
        "redirect_url": `${appUrl}/pagamento-concluido.html`
    };

    try {
        console.log(`⏳ Solicitando Link IP Público para ${devedor.nome} (R$ ${valor})...`);
        
        const response = await axios.post('https://api.infinitepay.io/invoices/public/checkout/links', data, {
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        console.log("✅ Link InfinitePay Gerado com Sucesso!");
        return response.data.url || response.data.checkout_url || response.data.payment_url;
        
    } catch (error) {
        console.error("❌ Falha na API Pública da InfinitePay:");
        if (error.response) {
            console.error("Motivo:", JSON.stringify(error.response.data));
        } else {
            console.error(error.message);
        }

        // PLANO B: Link Direto (Fallback caso a API mude o padrão)
        const handleTag = process.env.INFINITY_API_KEY || "henrique_de_araujo";
        const valorFormatado = Number(valor).toFixed(2).replace('.', ',');
        return `https://pay.infinitepay.io/${handleTag}/${valorFormatado}?metadata=${devedor.uuid}`;
    }
}

module.exports = { gerarLinkCobranca };