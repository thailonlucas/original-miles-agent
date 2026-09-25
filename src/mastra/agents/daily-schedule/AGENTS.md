# AGENTS.md — daily-schedule

Leia este arquivo antes de alterar qualquer coisa nesta pasta.

## Objetivo

Mantém o dia a dia (roteiro) de uma viagem — `travel.daily_schedule` (jsonb) + `travel_start_at`/
`travel_end_at` — a partir dos vouchers extraídos: um item por dia com evento, eventos separados em
manhã/tarde/noite.

## Regra central: a LLM só gera eventos de voucher, o código decide o resto

Todo evento gravado tem `source` (`schema.ts` → `dailyScheduleEventSourceSchema`):

- `{ type: 'voucher', voucher_id }` — gerado pela LLM a partir de um voucher.
- `{ type: 'suggestion', suggestion_id }` — sugestão aprovada (`applySuggestionDecision`,
  `createDecidedSuggestion`, fora desta pasta).
- `{ type: 'chat' }` — evento que o consultor pediu ao Ori no chat (tool `adicionarEventoDiaADia`).
- `{ type: 'manual' }` — evento criado pelo app (`POST /travel_agent/daily-schedule/event`).

Edições de UM evento (adicionar/alterar/mover/remover) são escritas diretas em `services/travel-db.ts`
(`insertDailyScheduleEvent`, `updateDailyScheduleEvent`, `removeDailyScheduleEvent`) — sem LLM,
usadas pelas rotas de `routes/daily-schedule-event-routes.ts` (o kanban do front edita, move e
exclui por elas) e pelas tools do Ori.

Sugestões aprovadas ANTES de aprovar passar a criar o evento ficaram só como "sugestão aprovada",
fora da cronologia. `scripts/backfill-approved-suggestions.ts` (simula por padrão; `--apply` grava;
`--travel=<id>` pra uma viagem só) as transforma em eventos com `source: suggestion` — a origem
continua visível no kanban (selo "Sugestão aprovada"). Duplicada (mesmo título no mesmo dia/período)
não vira outro evento; a sugestão repetida é apagada. Seguro rodar de novo.

Sugestão aprovada e o evento dela existem ou somem juntos: excluir o evento
(`removeDailyScheduleEvent`) apaga a sugestão, e apagar a sugestão (`removeSuggestion`) tira o
evento. Sem isso, uma sugestão "aprovada" sem evento voltava a aparecer como card no kanban.

A LLM nunca vê nem escreve `source`: ela devolve eventos com `voucher_id`
(`voucherScheduleResultSchema`) e `schedule-merge.ts` converte, junta e remove. Por isso nenhuma
reconstrução a partir de vouchers pode apagar uma sugestão aprovada ou um evento manual — o código
só mexe em eventos `voucher`.

## Os três pontos de entrada

Todos dentro de `withTravelScheduleLock` (serializa escritas da mesma viagem, ver
`services/travel-db.ts`).

- **Voucher criado ou atualizado** — `updateDailyScheduleForVoucher` (`rebuild-daily-schedule.ts`),
  disparado por `routes/voucher-routes.ts` e pelas tools de voucher do Ori. Tira os eventos antigos
  daquele voucher (`withoutVoucher`) e pede à LLM só os eventos DELE (`buildVoucherEvents`), com o
  resto do dia a dia como contexto só de leitura. Os outros vouchers não passam pela LLM de novo.
- **Voucher excluído** — `removeVoucherFromDailySchedule`: só remove os eventos daquele
  `voucher_id`. **Sem chamada de IA.**
- **Gerar sob demanda** — `generateDailySchedule` (`generate-daily-schedule.ts`): refaz TODOS os
  eventos de voucher do zero (`buildVoucherSchedule`) e junta as sugestões/eventos manuais que já
  existiam. Única função usada pela rota `POST /travel_agent/daily-schedule` (botão do front) e pela
  tool `gerarDiaADia` do Ori. Devolve `{ days, response, analysedDocIds }` — `response` é o array
  serializado (contrato que o front já espera); `analysedDocIds` vem das tool calls de
  `openVoucher` de verdade, não de uma lista preenchida pela LLM.

**Linhas antigas** (gravadas antes de `source` existir): `hasUntaggedEvents` detecta eventos sem
origem e, nesse caso, qualquer um dos três caminhos reconstrói os eventos de voucher do zero uma vez
(`rebuildVoucherEvents`). Eventos antigos com `suggested: true` contam como sugestão (mantidos).

## Formato gravado

- Array **esparso**: só dias com pelo menos um evento. O front preenche os dias vazios entre o
  primeiro e o último ("Dia livre", `fillDailyScheduleGaps` no front), então o kanban continua
  mostrando a viagem inteira.
- `travel_start_at`/`travel_end_at` = primeiro e último dia com evento (`scheduleRange`),
  recalculados a cada escrita — encolhem quando um voucher sai.
- A ordem dos eventos dentro de um período é a cronologia (eventos não têm horário estruturado).
  `updateDailyScheduleEvent` aceita `newIndex` (posição final no período de destino) — é o que o
  drag-and-drop do kanban usa pra soltar um card entre dois outros, e o Ori pra "colocar o cinema
  depois do jantar". Sem `newIndex`, um move vai pro fim do período.
- Um evento por voucher: se dois vouchers descrevem o mesmo acontecimento (ex: o mesmo voo), cada um
  tem o seu evento, com `observation` apontando o outro. Assim excluir um voucher nunca leva junto
  informação que veio de outro.

## Tradeoffs conhecidos

- Editar título/conteúdo ou mover um evento de voucher (`updateDailyScheduleEvent`) mantém a origem
  `voucher` — se aquele voucher for atualizado ou o dia a dia for regenerado, os eventos dele são
  refeitos a partir do voucher e a edição se perde. Edições em eventos de OUTROS vouchers, sugestões
  e eventos manuais sobrevivem.
- A conexão fica presa na transação durante a chamada de IA (lock). Aceitável pro volume atual.

## Arquivos desta pasta

- `schema.ts` — formato gravado (`dailyScheduleSchema`, com `source`) e formato da LLM
  (`voucherScheduleResultSchema`, com `voucher_id`).
- `event-format.ts` — formato único de `title`/`content`/`type` de um evento, usado pelo gerador, pelas
  sugestões (`agents/schedule-suggestion/`) e pelas tools do Ori que incluem/alteram eventos — um evento
  gerado, uma sugestão aprovada e um evento do chat ficam com a mesma cara. Mude o formato só aqui.
- `schedule-merge.ts` — funções puras de junção (`withoutVoucher`, `keptEventsOnly`, `mergeDays`,
  `toStoredDays`, `insertEventIntoDays`, `scheduleRange`, `hasUntaggedEvents`).
- `daily-schedule-agent.ts` — o `Agent` + `buildVoucherSchedule` (do zero) e `buildVoucherEvents`
  (um voucher).
- `prompts/system-prompt.ts` — instructions/mensagem dos dois modos, com as regras comuns
  (`COMMON_RULES`).
- `rebuild-daily-schedule.ts` — `updateDailyScheduleForVoucher`, `removeVoucherFromDailySchedule`,
  `rebuildVoucherEvents`, `isRelevant` (filtro de `travel_insurance`, aplicado em código).
- `generate-daily-schedule.ts` — `generateDailySchedule`.
- `tools/open-voucher-tool.ts` — abre `ai_extracted_data` de um voucher (tenant via `requestContext`).
