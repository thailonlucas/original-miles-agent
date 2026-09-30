# AGENTS.md — daily-schedule

Leia este arquivo antes de alterar qualquer coisa nesta pasta.

## Objetivo

Mantém o dia a dia (roteiro) de uma viagem — `travel.daily_schedule` (jsonb) + `travel_start_at`/
`travel_end_at` — a partir dos vouchers extraídos: um item por dia com evento, eventos separados em
manhã/tarde/noite.

## Regra central: voucher nunca estraga o trabalho do consultor

O consultor pode passar horas arrumando o dia a dia. Por isso **mudança de voucher (criar, atualizar,
excluir) nunca recria, substitui, move nem apaga um card**:

- Voucher criado ou atualizado **encaixa**: atualiza o card do mesmo compromisso (de qualquer origem —
  a sugestão do restaurante aprovada e depois a reserva) ou cria um card novo. O card do consultor é a
  base: o voucher corrige o que comprova ("a confirmar" → 16h), acrescenta o que falta e mantém o
  resto. O que ele mudou num dado que o consultor escreveu fica em `observation` com o valor antigo.
- Voucher excluído **marca** os cards dele (`removed_vouchers`); o consultor decide remover ou manter.
- Só **refazer o dia a dia** (`generateDailySchedule`, rota do botão do front e tool `gerarDiaADia`)
  refaz do zero, e só os cards de voucher — o resto fica.

## Origem de um card

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

`source` diz quem CRIOU o card e não muda quando um voucher o enriquece. Além dele, só no formato
gravado:

- `linked_voucher_ids` — vouchers que enriqueceram o card depois (o de `source` não entra).
- `removed_vouchers` — `[{ voucher_id, removed_at }]`, vouchers do card que foram excluídos. Enquanto
  tiver item, o card aparece como "voucher excluído, aguardando decisão".

`eventVoucherIds(event)` = os vouchers que sustentam o card hoje (`source` + `linked`, menos os
excluídos). A LLM nunca vê nem escreve esses campos: ela devolve operações e `schedule-merge.ts`
aplica.

## Os três pontos de entrada

Todos dentro de `withTravelScheduleLock` (serializa escritas da mesma viagem, ver
`services/travel-db.ts`).

- **Voucher criado ou atualizado** — `updateDailyScheduleForVoucher` (`rebuild-daily-schedule.ts`),
  disparado por `routes/voucher-routes.ts` e pelas tools de voucher do Ori. A LLM recebe o dia a dia
  atual COM o conteúdo dos cards (`formatScheduleCards`, com `index` e `deste_voucher`) e devolve
  operações (`buildVoucherOperations`, `voucherOperationsResultSchema`):
  - `enrich` (date/period/index de um card existente) — `content` = o texto ATUAL do card atualizado
    (mantém o que o consultor escreveu, troca o que o voucher comprova diferente ou pendente, acrescenta
    o novo) e substitui o texto; `title` só se o voucher contradiz um dado dele; `place` se mudou;
    `observation` com o que mudou e o valor antigo ("Horário atualizado pelo voucher Casa Flo: 20h →
    16h"), acrescentada à que já existe. `applyVoucherOperations` liga o voucher (`linked_voucher_ids`)
    e tira a marca de voucher excluído, se houver. Dia e posição nunca mudam.
  - `create` — card novo com `source` do voucher, na posição cronológica pedida (`index`) ou no fim.
  - **Mesmo compromisso em outra data não é o mesmo card**: `create` na data do voucher com
    `observation` apontando o card parecido + `enrich` só com `observation` no card parecido. Nenhum
    card se move sozinho.
  - **Na dúvida, `create`**: um card a mais o consultor apaga; um card errado enriquecido ele pode nem
    perceber.
  - Voucher atualizado: enriquece os cards `deste_voucher` só com o que mudou (a mudança vai em
    `observation`). Sem nada novo, nenhuma operação.
  - Referência inválida (dia/período/index que não existe, create sem título/conteúdo) é ignorada e
    logada — nunca escreve num card errado. `travel_insurance` nem chama a LLM (`isRelevant`).
- **Voucher excluído** — `removeVoucherFromDailySchedule` → `markVoucherRemoved`: nenhum card sai.
  Os cards sustentados por ele ganham `removed_vouchers` e o voucher sai de `linked_voucher_ids`.
  **Sem chamada de IA.** O consultor decide: remover (`removeDailyScheduleEvent`, rota `DELETE
  /travel_agent/daily-schedule/event`, tool `removerEventoDiaADia`) ou manter
  (`keepDailyScheduleEvent`, rota `POST /travel_agent/daily-schedule/event/keep`, tool
  `manterEventoSemVoucher`) — manter tira a marca e, se o card foi criado pelo voucher excluído, ele
  vira `manual`. Um voucher enviado de novo que encaixa num card marcado tira a marca.
- **Refazer o dia a dia** — `generateDailySchedule` (`generate-daily-schedule.ts`): refaz do zero
  SÓ os cards de voucher (`rebuildVoucherEvents` → `buildVoucherSchedule`) — edições feitas neles se
  perdem — e junta de volta o que não veio de voucher (`keptEventsOnly`/`isKeptOnRebuild`: sugestões
  aprovadas, chat, à mão), intacto, com os títulos de dia editados (`keepEditedTitles`). Os cards que
  ficam vão pra LLM como contexto: um card que fica pode já ser o compromisso de um voucher (a sugestão
  do restaurante enriquecida pela reserva), e aí ela não cria outro. Sugestões, vouchers, Contexto da
  Viagem e memória da viagem não mudam. Única função usada pela rota `POST
  /travel_agent/daily-schedule` (botão do front) e pela tool `gerarDiaADia` do Ori (cujo cartão de
  aprovação, `describeScheduleRebuild` em `agents/ori/ori-agent.ts`, diz quantos cards são refeitos e
  o que fica). Mudança de voucher **nunca** chama isto. Devolve `{ days, response, analysedDocIds }` —
  `response` é o array serializado (contrato que o front já espera).

**Linhas antigas** (gravadas antes de `source` existir) não disparam mais reconstrução: os cards delas
são enriquecidos como qualquer outro. Eventos antigos com `suggested: true` contam como sugestão.

## Formato gravado

- Array **esparso**: só dias com pelo menos um evento. O front preenche os dias vazios entre o
  primeiro e o último ("Dia livre", `fillDailyScheduleGaps` no front), então o kanban continua
  mostrando a viagem inteira.
- O título do dia (subtítulo da coluna no kanban) pode ser editado à mão
  (`PATCH /travel_agent/daily-schedule/day` → `updateDailyScheduleDayTitle`, `services/travel-db.ts`).
  O dia fica com `title_edited: true` e nenhuma junção troca mais esse título (`mergeDays`,
  `filterEvents`). Encaixar um voucher nunca troca título de dia que já existe; dia novo nasce com o
  título do primeiro card. Refazer o dia a dia também mantém. Título vazio volta ao automático
  (primeiro evento do dia) e tira a marca. Se o dia ficar sem eventos, ele sai da lista e o título
  editado vai junto.
- `travel_start_at`/`travel_end_at` = primeiro e último dia com evento (`scheduleRange`),
  recalculados a cada escrita — encolhem quando um voucher sai.
- A ordem dos eventos dentro de um período é a cronologia (eventos não têm horário estruturado).
  `updateDailyScheduleEvent` aceita `newIndex` (posição final no período de destino) — é o que o
  drag-and-drop do kanban usa pra soltar um card entre dois outros, e o Ori pra "colocar o cinema
  depois do jantar". Sem `newIndex`, um move vai pro fim do período.
- Tudo que dura vários dias (hospedagem, aluguel de carro, cruzeiro, circuito) gera evento só no
  início e no fim (check-in/check-out, retirada/devolução...), nunca um por dia do meio — era ruído no
  kanban. Dia do meio só tem evento se o voucher trouxer uma programação própria daquele dia.
- Onde o cliente está nos dias do meio não é gravado: `ongoingStays` (`schedule-merge.ts`) deriva dos
  eventos de início e fim do mesmo voucher, pelo `place` deles ("Urban Hive Milano, Milão", preenchido
  pela LLM; linhas antigas caem no nome tirado do título). Usado pelo índice do prompt do Ori, por
  `buscarDiaADia` e pelo resumo do agente de sugestões/validador. O front tem a mesma regra
  (`ongoingStays` em `daily-schedule/utils.ts`) e mostra no cabeçalho do dia ("Hospedado em ...").
- Voo de madrugada (partida 00:00–05:59) ganha um evento a mais na noite do dia anterior ("Ida ao
  aeroporto — Voo X às 3h10"): o dia do cliente começa na véspera. Voo que chega em outro dia (noturno,
  longo) ganha um evento "Chegada do voo X em Y" no dia da chegada. Os dois têm o mesmo `voucher_id` do
  voo, então somem junto com ele. Regra só no prompt (`COMMON_RULES`) — o voucher não tem horário
  estruturado pro código conferir.
- `date` que a LLM devolve é validado (`YYYY-MM-DD` e dia existente, `voucherScheduleResultSchema` e
  `voucherOperationsResultSchema`).
  O formato gravado não valida, de propósito: uma linha antiga com data ruim faria `readScheduleDays`
  tratar o dia a dia inteiro como vazio.
- Refazer do zero: um evento por voucher — se dois vouchers descrevem o mesmo acontecimento (ex: o
  mesmo voo), cada um tem o seu evento, com `observation` apontando o outro. Encaixar é diferente: o
  segundo voucher enriquece o card que já existe, e excluir um deles só marca o card.

## Tradeoffs conhecidos

- Atualizar depende da LLM manter o que o consultor escreveu (o prompt manda, o código não tem como
  conferir). A `observation` registra o que o voucher mudou, com o valor antigo, pra nada passar
  despercebido.
- Um card de voucher que o consultor removeu à mão pode voltar se aquele voucher for atualizado (não
  há card pra enriquecer, então cria de novo).
- A LLM decide se um voucher é o mesmo compromisso de um card; errar pro lado de criar é de propósito.
- A conexão fica presa na transação durante a chamada de IA (lock). Aceitável pro volume atual.

## Arquivos desta pasta

- `schema.ts` — formato gravado (`dailyScheduleSchema`, com `source`/`linked_voucher_ids`/
  `removed_vouchers`) e os formatos da LLM (`voucherScheduleResultSchema` do zero, com `voucher_id`;
  `voucherOperationsResultSchema` pra encaixar).
- `event-format.ts` — as regras de escrita de TODO evento (gerador, sugestões, tools do Ori): um evento
  gerado, uma sugestão aprovada e um evento do chat ficam com a mesma cara e as mesmas regras. Mude só
  aqui. `EVENT_CONTENT_FORMAT` (resumo) + `EVENT_FORMAT_GUIDE` (guia completo): o card é um resumo do
  que acontece, sem repetir título/`place` nem o que já está no voucher (endereço, telefone,
  localizador). Logísticos (voo, hotel, transfer, carro, balsa): 1–3 rótulos (horários, aeroportos,
  regime). Experiências (passeio, restaurante, other): horário + parágrafo curto + linhas
  `**Dica:**`/`**Logística:**`/`**Atenção:**`. Todo evento começa pelo horário ("a confirmar" se a
  fonte não tiver); nada de duração/deslocamento estimados. Cada caminho junta a sua fonte permitida:
  `EVENT_SOURCE_VOUCHER` (gerador), `EVENT_SOURCE_CHAT` (Ori, evento pedido pelo consultor),
  `EVENT_SOURCE_SUGGESTION` (sugestões). `EVENT_DETAILS`/`eventDetailGaps` = o mínimo por tipo (o
  horário), pra tool `detalharEvento`. `normalizeEventContent(content, title)` roda em toda gravação:
  quebra de linha do markdown + tira linhas cujo valor só repete o título (rede de segurança).
- `schedule-merge.ts` — funções puras de junção (`applyVoucherOperations`, `markVoucherRemoved`,
  `eventVoucherIds`, `keptEventsOnly`, `keepEditedTitles`, `mergeDays`, `toStoredDays`, `insertEventIntoDays`,
  `scheduleRange`, `ongoingStays`).
- `daily-schedule-agent.ts` — o `Agent` + `buildVoucherSchedule` (do zero) e `buildVoucherOperations`
  (encaixar um voucher).
- `prompts/system-prompt.ts` — instructions/mensagem dos dois modos (do zero e encaixar), com as regras comuns
  (`COMMON_RULES`).
- `rebuild-daily-schedule.ts` — `updateDailyScheduleForVoucher`, `removeVoucherFromDailySchedule`,
  `rebuildVoucherEvents`, `isRelevant` (filtro de `travel_insurance`, aplicado em código).
- `generate-daily-schedule.ts` — `generateDailySchedule`.
- `daily-schedule-trigger.ts` — `triggerDailyScheduleUpdate`/`triggerDailyScheduleRemoval`, os
  gatilhos em background que as rotas de voucher e as tools de voucher do Ori chamam depois de
  criar/editar/excluir um voucher.
- `tools/open-voucher-tool.ts` — abre `ai_extracted_data` de um voucher (tenant via `requestContext`).
