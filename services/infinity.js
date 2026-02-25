const axios = require('axios');

/**
 * Gera um link de pagamento utilizando a API de Invoices Pública da InfinitePay.
 * Baseado nas instruções oficiais: Não requer JWT, apenas o Handle (InfiniteTag) no body.
 */
async function gerarLinkCobranca(devedor, valor) {
    // ✅ URL da sua API no Render como padrão (fallback)
    let appUrl = process.env.APP_URL || "https://ha-financeira.onrender.com";
    
    // Remove a barra final se existir, para evitar erro de rotas (ex: .com//webhook)
    if (appUrl.endsWith('/')) {
        appUrl = appUrl.slice(0, -1);
    }
    
    // 🛡️ ALERTA INTELIGENTE DE INFRAESTRUTURA
    if (appUrl.includes('localhost')) {
        console.warn("⚠️ AVISO: Seu APP_URL é 'localhost'.");
        console.warn("A InfinitePay não consegue enviar a confirmação de pagamento (Webhook) para o seu servidor. Use Ngrok para testes locais ou um Domínio Público (ex: VPS/Railway).");
    }
    
    // Converte R$ 15.50 para 1550 centavos (Exigência da InfinitePay)
    const valorCentavos = Math.round(parseFloat(valor) * 100);

    // Pega a Tag do seu .env
    const handleTag = process.env.INFINITY_API_KEY || "henrique_de_araujo";

    // 🚨 CORREÇÃO: Captura o token secreto que a rota do index.js está a exigir
    const tokenSecreto = process.env.WEBHOOK_SECRET || "cms_seguro_2024";

    // Payload Exato instruído pelo suporte (Enxuto, com valor livre em centavos)
    const data = {
        "handle": handleTag, 
        "order_nsu": devedor.uuid,
        "redirect_url": `${appUrl}/pagamento-concluido`,
        
        // ✅ AQUI ESTÁ A CORREÇÃO: Injeção do token secreto na URL do webhook
        "webhook_url": `${appUrl}/webhook-infinitepay/${tokenSecreto}`, 
        
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