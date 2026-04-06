const { createClient } = require('@supabase/supabase-js');

// Inicializa o Supabase com as variáveis de ambiente
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Processa o upload de fotos em Base64 para o Supabase Storage
 */
const fazerUploadNoSupabase = async (imagem, nomeArquivo) => {
    if (!imagem) return null;

    try {
        // Deteta dinamicamente o tipo (image/jpeg, image/png, application/pdf, etc.)
        const matches = imagem.match(/^data:([\w\/]+);base64,/);
        const mimeType = matches ? matches[1] : 'image/jpeg';
        const extensao = mimeType === 'application/pdf' ? 'pdf' : (mimeType.split('/')[1] || 'jpeg');

        // Substitui a extensão no nome do ficheiro pelo tipo real
        const nomeComExtensao = nomeArquivo.replace(/\.[^.]+$/, `.${extensao}`);

        // Limpa a string base64 e converte em Buffer
        const base64Data = imagem.replace(/^data:[^;]+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');

        // Sobe para o bucket 'documentos' com timeout de 120s por arquivo
        const uploadPromise = supabase.storage
            .from('documentos')
            .upload(nomeComExtensao, buffer, {
                contentType: mimeType,
                upsert: true
            });
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout no upload do arquivo. Conexão lenta ou instável.')), 120000)
        );
        const { error } = await Promise.race([uploadPromise, timeoutPromise]);

        if (error) throw error;

        // Gera a URL pública
        const { data: { publicUrl } } = supabase.storage
            .from('documentos')
            .getPublicUrl(nomeComExtensao);

        return publicUrl;
    } catch (err) {
        console.error("❌ Erro no UploadService:", err.message);
        throw new Error("Falha ao processar as imagens da proposta na nuvem.");
    }
};

module.exports = { fazerUploadNoSupabase };