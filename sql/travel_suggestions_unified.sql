-- Consolida `approved_suggestions`/`rejected_suggestions` (colunas separadas por status, ver
-- `sql/travel_rejected_suggestions.sql`) numa única coluna `suggestions`, com um terceiro status
-- possível: "pending" (gerada pelo agente, ainda não aprovada nem rejeitada). Necessário porque:
--  1. O histórico no frontend agora mostra TODAS as sugestões já geradas, incluindo as pendentes —
--     duas colunas por status não davam conta de um terceiro estado sem duplicar toda a lógica.
--  2. Mover um card de sugestão de um dia pro outro (drag and drop) e apagar uma sugestão aprovada
--     do histórico precisam de um id estável por sugestão, independente de em qual coluna ela mora.
-- Ver `services/travel-db.ts` -> `getSuggestions`/`appendPendingSuggestions`/`decideSuggestion`/
-- `moveSuggestion`/`deleteSuggestion`.
alter table travel add column if not exists suggestions jsonb;

-- Backfill: migra o que já existia nas duas colunas antigas pra `suggestions`, gerando um `id`
-- pra cada elemento que ainda não tiver um (decisões gravadas antes desta migration).
update travel
set suggestions = (
  select coalesce(jsonb_agg(elem || jsonb_build_object('id', coalesce(elem->>'id', gen_random_uuid()::text))), '[]'::jsonb)
  from jsonb_array_elements(coalesce(approved_suggestions, '[]'::jsonb) || coalesce(rejected_suggestions, '[]'::jsonb)) elem
)
where suggestions is null and (approved_suggestions is not null or rejected_suggestions is not null);
