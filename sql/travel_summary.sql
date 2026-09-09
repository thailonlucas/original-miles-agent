-- Resumo livre da viagem (perfil do cliente, tipo de viagem, preferências etc.), cadastrado uma
-- vez e reaproveitado como contexto extra tanto pelo agente `daily-schedule` (montagem do roteiro)
-- quanto pelo `schedule-suggestion` (sugestão pontual de atividades) — ver
-- `services/travel-db.ts` -> `getTravelSummary`/`saveTravelSummary` e
-- `routes/travel-summary-routes.ts`.
--
-- Em produção, a coluna `description` (existente e sem uso) foi renomeada para `summary`
-- em vez de criar uma coluna nova. O `alter table` abaixo cobre o caso de um ambiente onde
-- `description` não existe (ex.: staging/local criado do zero).
alter table travel add column if not exists summary text;
