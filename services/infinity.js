const axios = require('axios');

/**
 * Gera um link de pagamento utilizando a API de Invoices Pública da InfinitePay.
 * Baseado nas instruções oficiais: Não requer JWT, apenas o Handle (InfiniteTag) no body.
 */
async function gerarLinkCobranca(devedor, valor) {
    let appUrl = process.env.APP_URL;
    
    // 🛡️ ALERTA INTELIGENTE DE INFRAESTRUTURA
    if (!appUrl || appUrl.includes('localhost')) {
        console.warn("⚠️ AVISO: Seu APP_URL no .env não está configurado ou é 'localhost'.");
        console.warn("A InfinitePay não consegue enviar a confirmação de pagamento (Webhook) para o seu computador. Use Ngrok para testes locais ou um Domínio Público.");
        appUrl = appUrl || "https://seusite.com"; 
    }
    
    // Converte R$ 15.50 para 1550 centavos (Exigência da InfinitePay)
    const valorCentavos = Math.round(parseFloat(valor) * 100);

    // Pega a Tag do seu .env
    const handleTag = process.env.INFINITY_API_KEY || "henrique_de_araujo";

    // Payload Exato instruído pelo suporte (Enxuto, com valor livre em centavos)
    const data = {
        "handle": handleTag, 
        "order_nsu": devedor.uuid,
        "redirect_url": `${appUrl}/pagamento-concluido`,
        "webhook_url": `${appUrl}/webhook-infinitepay`, // A URL pública que o InfinitePay vai bater
        "items": [
            {
                "id": "pagamento_avulso",
                "quantity": 1,
                "price": valorCentavos,
                "description": `Pgto HA Elite - ${devedor.nome.substring(0, 15)}`
            }
        ]
    };

    try {
        console.log(`⏳ Solicitando Link IP Público para ${devedor.nome} (R$ ${valor})...`);
        
        // ROTA PÚBLICA: Sem envio de Token (Authorization: Bearer)
        const response = await axios.post('https://api.infinitepay.io/invoices/public/checkout/links', data, {
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        console.log("✅ Link InfinitePay Gerado com Sucesso via API Pública!");
        return response.data.url || response.data.checkout_url || response.data.payment_url;
        
    } catch (error) {
        console.error("❌ Falha na API Pública da InfinitePay:");
        if (error.response) {
            console.error("Motivo:", JSON.stringify(error.response.data));
        } else {
            console.error(error.message);
        }

        // PLANO B: Link Direto 
        const valorFormatado = Number(valor).toFixed(2);
        console.log("🔄 Acionando Link Público Estático (Plano B)...");
        return `https://pay.infinitepay.io/${handleTag}/${valorFormatado}`;
    }
}

module.exports = { gerarLinkCobranca };