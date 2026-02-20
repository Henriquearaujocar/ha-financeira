require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Configuração exclusiva e segura para o Supabase (Removido Sequelize/SQLite)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.warn("⚠️ ATENÇÃO: Variáveis SUPABASE_URL ou SUPABASE_KEY não encontradas no .env");
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = { supabase };