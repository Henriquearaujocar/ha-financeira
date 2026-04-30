-- ==============================================================================
-- CORREÇÕES DO BANCO DE DADOS
-- Execute este script no SQL Editor do Supabase
-- ==============================================================================


-- ==============================================================================
-- FIX 1: vw_cobranca_ativa_parcelas — adicionar url_rg
-- O campo d.url_rg estava faltando na view, causando foto do RG não aparecer
-- na aba de cobrança ativa ao abrir o dossiê do cliente
-- ==============================================================================

DROP VIEW IF EXISTS vw_cobranca_ativa_parcelas CASCADE;
CREATE VIEW vw_cobranca_ativa_parcelas AS
SELECT
    p.id                        AS parcela_id,
    d.id                        AS devedor_id,
    d.uuid,
    d.nome,
    d.cpf,
    d.telefone,
    d.url_rg,
    p.numero_parcela,
    (SELECT MAX(p2.numero_parcela)
     FROM parcelas p2
     WHERE p2.devedor_id = d.id AND p2.status != 'CANCELADA'
    )                           AS total_parcelas_originais,
    p.valor_original,
    p.valor_atual,
    p.valor_pago,
    p.data_vencimento           AS vencimento_parcela,
    p.status                    AS status_parcela,
    d.status                    AS status_contrato,
    d.valor_total,
    d.valor_emprestado,
    d.total_ja_pego,
    d.qtd_parcelas,
    d.taxa_juros,
    d.frequencia,
    d.data_vencimento           AS vencimento_contrato,
    d.data_promessa,
    d.cobrar_so_em_dinheiro,
    d.isento_multa,
    d.crm_status,
    d.crm_nota,
    d.referencia1_nome,
    d.referencia1_tel,
    d.referencia2_nome,
    d.referencia2_tel,
    d.ultima_cobranca_atraso,
    d.score,
    d.indicado_por,
    d.observacoes
FROM parcelas p
JOIN devedores d ON p.devedor_id = d.id
WHERE d.status IN ('ABERTO', 'ATRASADO', 'APROVADO_AGUARDANDO_ACEITE')
  AND p.status IN ('PENDENTE', 'ATRASADO', 'PARCIAL');

GRANT SELECT ON vw_cobranca_ativa_parcelas TO postgres, anon, authenticated, service_role;


-- ==============================================================================
-- FIX 2: obter_resumo_dashboard — recebidoHoje independente do filtro de período
-- Bug: quando o usuário filtrava por um período passado, recebidoHoje ficava 0
-- porque os logs de hoje eram excluídos pelo WHERE de período.
-- Fix: recebidoHoje é calculado em query separada, sempre usando a data de hoje.
-- ==============================================================================

CREATE OR REPLACE FUNCTION obter_resumo_dashboard(
    p_inicio TIMESTAMPTZ DEFAULT NULL,
    p_fim    TIMESTAMPTZ DEFAULT NULL
) RETURNS json AS $$
DECLARE
    v_total_receber NUMERIC;
    v_capital_rua   NUMERIC;
    v_atrasos       INT;
    v_fluxo_total   NUMERIC;
    v_recebido_hoje NUMERIC;
    v_finalizados   INT;
    v_hoje          DATE := (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::DATE;
    v_inicio_dia    TIMESTAMPTZ := (v_hoje::text || ' 00:00:00-03')::TIMESTAMPTZ;
BEGIN
    SELECT
        COALESCE(SUM(valor_total), 0),
        COALESCE(SUM(valor_emprestado), 0),
        COUNT(*) FILTER (WHERE data_vencimento < v_hoje)
    INTO v_total_receber, v_capital_rua, v_atrasos
    FROM devedores WHERE status IN ('ABERTO', 'ATRASADO');

    SELECT COUNT(*) INTO v_finalizados
    FROM devedores WHERE status = 'QUITADO';

    -- fluxo total do período filtrado
    SELECT COALESCE(SUM(valor_fluxo), 0)
    INTO v_fluxo_total
    FROM logs
    WHERE (p_inicio IS NULL OR created_at >= p_inicio)
      AND (p_fim    IS NULL OR created_at <= p_fim);

    -- recebidoHoje é SEMPRE de hoje, independente do filtro de período
    SELECT COALESCE(SUM(valor_fluxo), 0)
    INTO v_recebido_hoje
    FROM logs
    WHERE created_at >= v_inicio_dia
      AND valor_fluxo > 0;

    RETURN json_build_object(
        'totalAReceber',     v_total_receber,
        'capitalNaRua',      v_capital_rua,
        'pendencias',        v_atrasos,
        'finalizados',       v_finalizados,
        'fluxoLiquidoTotal', v_fluxo_total,
        'recebidoHoje',      v_recebido_hoje
    );
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION obter_resumo_dashboard TO postgres, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';


-- ==============================================================================
-- FIX 3: Reconciliar devedores.valor_total com a soma real das parcelas
-- Bug: o TDZ no backend causava retorno 500 após processar o pagamento,
--      deixando valor_total e data_vencimento desincronizados das parcelas.
-- Execute UMA vez para corrigir clientes com divergência > R$ 1,00
-- ==============================================================================

UPDATE devedores d
SET valor_total = sub.saldo_real
FROM (
    SELECT
        p.devedor_id,
        GREATEST(0, SUM(GREATEST(0, p.valor_atual - COALESCE(p.valor_pago, 0)))) AS saldo_real
    FROM parcelas p
    WHERE p.status NOT IN ('CANCELADA', 'PAGA')
    GROUP BY p.devedor_id
) sub
WHERE d.id = sub.devedor_id
  AND d.status IN ('ABERTO', 'ATRASADO')
  AND ABS(d.valor_total - sub.saldo_real) > 1;


-- ==============================================================================
-- FIX 4: Corrigir data_vencimento do contrato para bater com a próxima parcela aberta
-- Bug: quando o admin definia novo vencimento em baixas PARCIAL, o contrato
--      ficava com a data antiga porque o branch PARCIAL não atualizava o devedor.
-- Execute UMA vez para sincronizar data_vencimento do contrato com a parcela ativa
-- ==============================================================================

UPDATE devedores d
SET data_vencimento = sub.prox_venc
FROM (
    SELECT DISTINCT ON (p.devedor_id)
        p.devedor_id,
        p.data_vencimento AS prox_venc
    FROM parcelas p
    WHERE p.status IN ('PENDENTE', 'ATRASADO', 'PARCIAL')
    ORDER BY p.devedor_id, p.numero_parcela ASC
) sub
WHERE d.id = sub.devedor_id
  AND d.status IN ('ABERTO', 'ATRASADO')
  AND d.data_vencimento != sub.prox_venc;


NOTIFY pgrst, 'reload schema';
