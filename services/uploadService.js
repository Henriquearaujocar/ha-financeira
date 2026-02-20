const { createClient } = require('@supabase/supabase-js');

// Inicializa o Supabase com as variáveis de ambiente
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Processa o upload de fotos em Base64 para o Supabase Storage
 */
const fazerUploadNoSupabase = async (imagem, nomeArquivo) => {
    try {
        if (!imagem) return null;

        // Limpa a string base64 e converte em Buffer
        const base64Data = imagem.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');
        
        // Sobe para o bucket 'documentos'
        const { error } = await supabase.storage
            .from('documentos')
            .upload(`${nomeArquivo}`, buffer, { 
                contentType: 'image/jpeg', 
                upsert: true 
            });

        if (error) throw error;

        // Gera a URL pública
        const { data: { publicUrl } } = supabase.storage
            .from('documentos')
            .getPublicUrl(`${nomeArquivo}`);

        return publicUrl;
    } catch (err) {
        console.error("❌ Erro no UploadService:", err.message);
        return null;
    }
};

module.exports = { fazerUploadNoSupabase };