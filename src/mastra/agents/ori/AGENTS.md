# AGENTS.md — ori

Leia este arquivo antes de alterar qualquer coisa nesta pasta.

## Objetivo

"Ori", o agente de chat da Original Miles usado pelos consultores de viagem internos (não pelo
cliente final). Recebe uma pergunta/pedido em texto livre (`prompt`) sobre uma viagem específica
(`travel_id`) e responde com base nos vouchers já extraídos dessa viagem — desde responder uma
pergunta pontual ("qual o hotel do dia 3?") até montar o roteiro completo. Também pode
buscar/criar/atualizar/excluir vouchers da viagem, consultar e corrigir eventos do roteiro
(`daily_schedule`) já montado, e ler/editar o "Contexto da Viagem" cadastrado no front, tudo
através de tools, sempre por iniciativa conversacional (nunca por comando estruturado).

Chamado via `POST /travel_agent/ori` (`routes/ori-routes.ts`).

## Prompt — reproduzido sem alteração de texto

`prompts/system-prompt.ts` (`buildOriInstructions`) reproduz **exatamente** o texto do prompt hoje
em produção no n8n para este agente — a pedido explícito de quem definiu esse prompt, pra não
quebrar um comportamento que já funciona. Não reescreva o texto por conta própria; qualquer ajuste
de redação é uma decisão separada, futura.

A parte dinâmica do texto original é a seção "## Documentos disponíveis": no n8n era uma expressão
(`$('Busca vouchers da viagem').all().filter(...).map(...)`) que buscava os vouchers da viagem;
aqui é `formatVoucherList` (mesmo módulo), que reproduz o mesmo filtro (`title` E `content`
precisam existir) e o mesmo formato de linha (`doc_id: ..., title: ..., content: ...`) a partir de
`getVoucherSummaries` (`services/travel-db.ts`).

Duas seções foram acrescentadas por cima do texto original (decisão explícita, não fazem parte do
prompt do n8n):

- **"## Contexto da viagem"** — só aparece quando `travel.summary` (`getTravelSummary`) não é
  `null`; injeta o mesmo texto do campo "Contexto da Viagem" do front (ver tool
  `buscarContextoViagem` abaixo) direto nas instructions, pro model já partir sabendo o perfil do
  cliente/preferências sem precisar chamar a tool. `askOri` busca `vouchers` e `tripContext` em
  paralelo (`Promise.all`) antes de montar as instructions.
- **"## Roteiro já montado"** — aviso fixo (não depende de dado nenhum) de que a viagem pode já ter
  um `daily_schedule` montado e que o model deve consultar com "buscarRoteiro" antes de responder
  sobre o roteiro atual ou de corrigir um evento. É a ÚNICA exceção à regra abaixo de "nenhuma
  instrução de tool no prompt" — decisão explícita de quem pediu esta mudança, pra reduzir a chance
  do model tentar remontar o roteiro do zero quando já existe um.

**Fora essas duas seções, nenhuma instrução sobre as 8 tools foi adicionada ao prompt** (mesma
razão original: não alterar o texto do n8n) — o comportamento esperado de cada tool (quando usar,
pedir confirmação antes de criar/excluir) fica só na `description` de cada tool, que o model sempre
vê independente das instructions.

## Saída — envelope fixo `{ response, analysed_doc_ids }`

`schema.ts` (`oriResultSchema`): mesmo envelope hoje vinculado ao node de IA do n8n —
`response` (string) e `analysed_doc_ids` (ids dos vouchers abertos com "buscarDocumento"). Como
`response` é uma string livre, ela comporta tanto uma resposta conversacional comum (pergunta
pontual, pedido de confirmação antes de criar um voucher) quanto o roteiro completo serializado
como JSON dentro dela, quando o pedido for "monta o roteiro" (aí valem as regras de "## Formato da
resposta" do prompt). O schema do roteiro em si (o JSON que vai dentro de `response` nesse caso)
não está tipado aqui — é o model seguindo o prompt em texto livre, igual já acontece hoje no n8n.

## As 8 tools — todas escopadas por `requestContext`

`tenant_id`/`travel_id`/`user_id` vêm sempre do `requestContext` (nunca de argumento que o model
preenche, mesmo contrato de `agents/daily-schedule/tools/open-voucher-tool.ts`) — evita um voucher
de outro tenant/viagem vazar ou ser editado por um id adivinhado/errado.

- **`buscarDocumento`** (`tools/search-voucher-tool.ts`) — abre `ai_extracted_data` completo de um
  voucher por `doc_id` (mesmo padrão de `openVoucherTool`).
- **`atualizarDocumento`** (`tools/update-voucher-tool.ts`) — corrige `title`/`content`/
  `ai_extracted_data` de um voucher já existente (`updateVoucherFields`, `services/travel-db.ts`,
  criada para esta feature). Sobrescreve `ai_extracted_data` direto (decisão explícita — ver
  histórico da conversa que criou este agente: diferente de outras partes do sistema, aqui não há
  separação entre "dado extraído pela IA" e "correção humana").
- **`criarDocumento`** (`tools/create-voucher-tool.ts`) — cria um voucher a partir de uma
  informação que o consultor digitou no chat (não upload). **Regra central, só na description da
  tool**: nunca criar sem antes perguntar ao consultor se ele quer adicionar aquilo como voucher, e
  só chamar depois que ele confirmar numa mensagem seguinte — por isso o agente precisa de memória
  de conversa real (ver abaixo), não só do prompt da chamada atual.
- **`deletarDocumento`** (`tools/delete-voucher-tool.ts`) — exclui um voucher por `doc_id`. Mesma
  regra de confirmação explícita antes de chamar (ação irreversível), só na description da tool.
- **`buscarRoteiro`** (`tools/get-daily-schedule-tool.ts`) — abre o `daily_schedule` atual da
  viagem inteiro (`getTravelSchedule`, `services/travel-db.ts`) — os dias com evento confirmado
  (cada um já com `date`/`period`/índice implícito na posição do array) e
  `travel_start_at`/`travel_end_at`. Sem input — sempre a viagem do `requestContext`. Usado tanto
  pra responder perguntas sobre o roteiro já montado quanto pro model descobrir a posição exata de
  um evento antes de chamar `atualizarEventoRoteiro`.
- **`atualizarEventoRoteiro`** (`tools/update-daily-schedule-event-tool.ts`) — corrige
  `title`/`content` de UM evento já confirmado do roteiro, localizado por `(date, period, index)`
  (`updateDailyScheduleEvent`, `services/travel-db.ts` — mesma função usada pela rota `PATCH
  /travel_agent/daily-schedule/event`, `routes/daily-schedule-event-routes.ts`). Mesma regra de
  confirmação explícita antes de chamar, só na description da tool. Não dispara
  `triggerDailyScheduleUpdate`/`Rebuild` — a escrita já é direto em `daily_schedule` via
  `saveTravelSchedule` (com `withTravelScheduleLock`), não em `voucher`.
- **`buscarContextoViagem`** (`tools/get-travel-context-tool.ts`) — abre `travel.summary`
  (`getTravelSummary`, `services/travel-db.ts`), o texto livre do campo "Contexto da Viagem" do
  front (perfil do cliente, tipo de viagem, preferências etc. — ver
  `original-miles-cartinhas/src/routes/index.tsx`, campo `tripContext`/`saveTripSummary`). Sem
  input — sempre a viagem do `requestContext`. `summary` vem `null` se a viagem ainda não tiver
  contexto cadastrado.
- **`atualizarContextoViagem`** (`tools/update-travel-context-tool.ts`) — cria/substitui
  `travel.summary` inteiro (`saveTravelSummary`, `services/travel-db.ts` — mesma função usada pela
  rota `PUT /travel_agent/travel-summary`, `routes/travel-summary-routes.ts`; mesmo limite de 4000
  caracteres). Não é um append: o texto novo substitui o anterior por completo. `summary: null`
  (ou string vazia) limpa o campo. Mesma regra de nunca preencher por iniciativa própria sem o
  consultor ter pedido, só na description da tool.

Todas as três tools de escrita de voucher (criar/atualizar/excluir) disparam os mesmos gatilhos
fire-and-forget de `routes/voucher-routes.ts` para manter `travel.daily_schedule` reagindo a
qualquer mudança de voucher, não só às feitas pelo pipeline de extração automática — ver
`tools/daily-schedule-trigger.ts` (`triggerDailyScheduleUpdate`/`triggerDailyScheduleRebuild`).
Esse arquivo usa `console.error` em vez de `helpers/logger.ts` de propósito: é importado pelas
tools do agente (dentro do bundle do Mastra), e `logger.ts` importa `mastra-instance.ts` de volta —
encadear os dois criaria um ciclo real no grafo de módulos (`mastra dev` já mostrou esse warning
antes desse ajuste).

## Memória de conversa (`session_id` -> thread)

`ori-agent.ts` usa `@mastra/memory` (`Memory`, sem `storage` explícito — herda o storage já
configurado na instância do Mastra, `mastra-instance.ts`). `askOri` passa
`memory: { thread: `${travelId}:${sessionId}`, resource: tenantId }` a cada chamada — o
`travelId` entra no id da thread (não só no `resource`) pra um `session_id` reaproveitado por
engano em outra viagem nunca colidir com uma thread já existente de outro dono (uma thread não pode
trocar de "owner"/resource depois de criada).

Sem essa memória, o fluxo de confirmação de `criarDocumento` não funcionaria: a resposta de
confirmação do consultor chega numa chamada HTTP separada (`session_id` igual), e só o histórico da
mesma thread permite o agente lembrar o que ele mesmo perguntou.

## Arquivos desta pasta

- `ori-agent.ts` — `Agent` (`memory`, as 8 tools, `structuredOutput: oriResultSchema`) + `askOri`,
  chamado pela rota.
- `schema.ts` — `oriResultSchema`.
- `prompts/system-prompt.ts` — `buildOriInstructions` (texto fixo do prompt + lista de vouchers).
- `tools/` — as 8 tools + `daily-schedule-trigger.ts` (gatilhos compartilhados de criar/atualizar/
  excluir voucher).
