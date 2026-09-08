-- Resumo livre da viagem (perfil do cliente, tipo de viagem, preferências etc.), cadastrado uma
-- vez e reaproveitado como contexto extra tanto pelo agente `daily-schedule` (montagem do roteiro)
-- quanto pelo `schedule-suggestion` (sugestão pontual de atividades) — ver
-- `services/travel-db.ts` -> `getTravelSummary`/`saveTravelSummary` e
-- `routes/travel-summary-routes.ts`.
alter table travel add column if not exists summary text;
