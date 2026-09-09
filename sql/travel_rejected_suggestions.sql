-- Separa o histórico de decisões do agente `schedule-suggestion` em duas colunas físicas:
-- `approved_suggestions` (já existente) passa a guardar só `status: 'approved'`, e esta migration
-- cria `rejected_suggestions` (mesmo formato jsonb) pra guardar só `status: 'rejected'`. Antes as
-- duas conviviam no mesmo array, diferenciadas apenas pelo campo `status` — ver
-- `services/travel-db.ts` -> `appendSuggestionDecision`/`getApprovedSuggestions`/`getRejectedSuggestions`
-- e `routes/schedule-suggestion-decision-routes.ts`.
alter table travel add column if not exists rejected_suggestions jsonb;
