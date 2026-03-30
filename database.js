require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

// SUPABASE_SERVICE_KEY é a chave de serviço (service_role) obtida em:
// Supabase Dashboard → Project Settings → API → "service_role" (secret)
// Ela bypassa as políticas RLS e é necessária para o backend gravar logs, etc.
// Se não configurada, cai no SUPABASE_KEY (mas inserts em tabelas com RLS vão falhar).
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || supabaseKey;

if (!supabaseUrl || !supabaseKey) {
    console.warn("⚠️ ATENÇÃO: Variáveis SUPABASE_URL ou SUPABASE_KEY não encontradas no .env");
}
if (!process.env.SUPABASE_SERVICE_KEY) {
    console.warn("⚠️ ATENÇÃO: SUPABASE_SERVICE_KEY não configurada — inserts no banco podem falhar por RLS. Configure a service_role key no .env");
} else {
    const kInicio = supabaseServiceKey.substring(0, 12);
    const isSameKey = supabaseServiceKey === supabaseKey;
    if (isSameKey) {
        console.warn(`⚠️ SUPABASE_SERVICE_KEY é igual ao SUPABASE_KEY (${kInicio}...) — provavelmente está usando a chave errada. Verifique no Supabase Dashboard → Project Settings → API → "service_role"`);
    } else {
        console.log(`✅ SUPABASE_SERVICE_KEY carregada (${kInicio}...) — backend usando chave de serviço.`);
    }
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

module.exports = { supabase };