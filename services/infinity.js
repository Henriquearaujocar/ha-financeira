const axios = require('axios');

async function gerarLinkCobranca(nomeDevedor, valor) {
    const data = {
        "handle": "henrique_de_araujo", // Seu handle da InfinitePay
        "items": [
            {
                "quantity": 1,
                "price": valor * 100, // A API geralmente recebe em centavos (Ex: 10.00 vira 1000)
                "description": `Empréstimo/Cobrança - ${nomeDevedor}`
            }
        ]
    };

    try {
        // Aqui usamos a URL de produção ou sandbox da InfinitePay
        const response = await axios.post('https://api.infinitepay.io/v1/checkout', data, {
            headers: { 'Authorization': `Bearer ${process.env.INFINITY_TOKEN}` }
        });

        return response.data.checkout_url;
    } catch (error) {
        console.error("Erro ao gerar link na InfinitePay", error);
        return null;
    }
}

module.exports = { gerarLinkCobranca };