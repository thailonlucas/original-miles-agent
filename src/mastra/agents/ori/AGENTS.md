# AGENTS.md — ori

Leia este arquivo antes de alterar qualquer coisa nesta pasta.

## Objetivo

"Ori", o agente de chat da Original Miles usado pelos consultores de viagem internos (não pelo
cliente final). Recebe uma pergunta/pedido em texto livre (`prompt`) sobre uma viagem específica
(`travel_id`) e responde com base nos vouchers já extraídos dessa viagem — desde responder uma
pergunta pontual ("qual o hotel do dia 3?") até montar o dia a dia completo. "Dia a dia" é como o
consultor chama o roteiro da viagem na prática (ver "## Prompt" abaixo) — os nomes das tools e a
documentação aqui usam esse termo de propósito, "roteiro" aparece só como sinônimo técnico. Também
pode buscar/criar/atualizar/excluir vouchers da viagem, consultar e corrigir eventos do dia a dia
(`daily_schedule`) já montado, gerar sugestões de atividades pra dias específicos e decidir sobre
elas (aprovar insere o evento de verdade no dia a dia, rejeitar só registra), propor uma ideia em
conversa e adicioná-la direto ao dia a dia depois de convergir com o consultor, e ler/editar o
"Contexto da Viagem" cadastrado no front, tudo através de tools, sempre por iniciativa
conversacional (nunca por comando estruturado).

Chamado via `POST /travel_agent/ori` (`routes/ori-routes.ts`).

## Prompt

`prompts/system-prompt.ts` (`buildOriInstructions`) partiu do prompt do n8n. As seções que
definiam o formato de roteiro do n8n ("Estrutura do roteiro", "Regras para os textos", "Formato da
resposta", e o "consulte todos os vouchers antes de gerar o roteiro") foram **removidas de
propósito**: o formato delas (`morning_activities`, `end_datetime`...) não era o do
`daily_schedule`, o resultado nunca era gravado, e o "retorne somente JSON" brigava com um chat.
Gerar o dia a dia agora é a tool `gerarDiaADia`. As regras de datas/fusos e de passageiros foram
mantidas (resumidas), porque valem pra qualquer resposta.

Seções dinâmicas:

- **"## Documentos disponíveis"** — a lista de vouchers (`formatVoucherList`, mesmo filtro e formato
  de linha do n8n).
- **"## Contexto da viagem"** — só quando `travel.summary` existe.
- **"## Dia a dia atual"** — índice compacto do `daily_schedule` (`formatScheduleIndex`): uma linha
  por dia, título dos eventos por período com o index de cada um, sem `content`. O model já sabe o
  que tem na viagem sem gastar tool call, e só chama `buscarDiaADia` com a data quando precisa do
  detalhe. `askOri` busca vouchers, contexto e dia a dia em paralelo.
- **"## Sugestões de atividades"** — fluxo de sugestão (checar/perguntar o contexto antes, ideia
  pontual em texto + `adicionarSugestaoAoDiaADia`, ou várias opções com `sugerirAtividades` +
  `decidirSugestao`).

O resto do comportamento de cada tool fica na `description` dela.

## Saída — envelope fixo `{ response, analysed_doc_ids }`

`schema.ts` (`oriResultSchema`): `response` (texto conversacional) e `analysed_doc_ids` (ids dos
vouchers abertos com "buscarDocumento"). O dia a dia nunca vem dentro de `response` — ele é gravado
por `gerarDiaADia` e o front recarrega pelo `updated_data`.

Decisão explícita: uma edição pontual (`atualizarEventoDiaADia`, ou qualquer outra tool de escrita)
NÃO reserializa o dado inteiro em `response` — isso obrigaria o model a copiar/regerar dados
inteiros na saída a cada edição, gastando tokens à toa (chegou a ser tentado e foi revertido).

`schema.ts` também exporta `OriResponse` = `OriResult` + `updated_data` (boolean). Diferente do
resto do envelope, `updated_data` **não é preenchido pela LLM** — não está em `oriResultSchema`,
então o model nunca vê nem escreve esse campo. `askOri` calcula ele depois do `generate()`, olhando
`toolCalls` (retornado pelo próprio Mastra) contra `WRITE_TOOL_IDS` (a lista das 16 tools de escrita
do agente, em `ori-agent.ts`) — `true` se qualquer uma delas foi chamada nesta resposta. É só um
sinal binário ("o front pode estar desatualizado"), não diz o quê mudou; o consumidor (front) decide
o que fazer com isso — hoje provavelmente um botão/gatilho de "atualizar" que rebusca o dado
relevante (`GET /travel_agent/daily-schedule`, lista de vouchers, `travel-summary`, sugestões etc.),
não uma mudança automática de UI aqui no backend.

## As 20 tools — todas escopadas por `requestContext`

`tenant_id`/`travel_id`/`user_id` vêm sempre do `requestContext` (nunca de argumento que o model
preenche, mesmo contrato de `agents/daily-schedule/tools/open-voucher-tool.ts`) — evita um voucher
de outro tenant/viagem vazar ou ser editado por um id adivinhado/errado.

- **`buscarDocumento`** (`tools/search-voucher-tool.ts`) — abre `ai_extracted_data` completo de um
  voucher por `doc_id` (mesmo padrão de `openVoucherTool`).
- **`atualizarDocumento`** (`tools/update-voucher-tool.ts`) — corrige `title`/`content`/
  `ai_extracted_data` de um voucher já existente (`updateVoucherFields`, `services/travel-db.ts`,
  criada para esta feature). Sobrescreve `ai_extracted_data` direto (decisão explícita — ver
  histórico da conversa que criou este agente: diferente de outras partes do sistema, aqui não há
  separação entre "dado extraído pela IA" e "correção humana"). Mesma regra de confirmação
  explícita numa mensagem seguinte antes de chamar, só na description da tool.
- **`criarDocumento`** (`tools/create-voucher-tool.ts`) — cria um voucher a partir de uma
  informação que o consultor digitou no chat (não upload). **Regra central, só na description da
  tool**: nunca criar sem antes perguntar ao consultor se ele quer adicionar aquilo como voucher, e
  só chamar depois que ele confirmar numa mensagem seguinte — por isso o agente precisa de memória
  de conversa real (ver abaixo), não só do prompt da chamada atual.
- **`deletarDocumento`** (`tools/delete-voucher-tool.ts`) — exclui um voucher por `doc_id`. Mesma
  regra de confirmação explícita antes de chamar (ação irreversível), só na description da tool.
- **`buscarDiaADia`** (`tools/get-daily-schedule-tool.ts`) — sem `date`: índice enxuto da viagem
  (título, período, index, tipo e origem de cada evento, sem `content`) + `travel_start_at`/
  `travel_end_at`. Com `date`: o dia inteiro, com o `content` completo. Dividido assim pra não
  encher o contexto nem a memória da thread (que guarda o resultado das tools).
- **`gerarDiaADia`** (`tools/generate-daily-schedule-tool.ts`) — regenera o dia a dia a partir de
  todos os vouchers chamando `generateDailySchedule` (`agents/daily-schedule/`), a mesma função da
  rota `POST /travel_agent/daily-schedule`. Mantém sugestões aprovadas e eventos manuais; devolve
  ao model só um resumo (datas e títulos). **`requireApproval: true`**.
- **Um evento por vez, sem regenerar o resto** — as três com `requireApproval: true`, cada uma
  chamando a mesma função da rota equivalente em `routes/daily-schedule-event-routes.ts`:
  - **`adicionarEventoDiaADia`** (`tools/add-daily-schedule-event-tool.ts`) — `insertDailyScheduleEvent`
    (rota `POST`). Compromisso que o consultor informou (ex: um casamento), gravado com
    `source: { type: 'chat' }` — nenhuma reconstrução a partir de vouchers apaga. A rota grava o
    mesmo com `{ type: 'manual' }`.
  - **`atualizarEventoDiaADia`** (`tools/update-daily-schedule-event-tool.ts`) —
    `updateDailyScheduleEvent` (rota `PATCH`): corrige `title`/`content` e/ou move pra outro
    dia/período e/ou reordena dentro do período (`newDate`/`newPeriod`/`newIndex`, o mesmo move do
    drag-and-drop).
  - **`removerEventoDiaADia`** (`tools/remove-daily-schedule-event-tool.ts`) —
    `removeDailyScheduleEvent` (rota `DELETE`).

  Evento de voucher editado/removido por aqui é refeito se aquele voucher for atualizado ou o dia a
  dia regenerado — está na description das tools. O prompt roteia "pedido sobre UM evento" pra essas
  três e deixa `gerarDiaADia` só pra quando o consultor pedir pra refazer tudo (antes, sem tool de
  adicionar, o model caía no `gerarDiaADia` pra qualquer inclusão).
- **`buscarContextoViagem`** (`tools/get-travel-context-tool.ts`) — abre `travel.summary`
  (`getTravelSummary`, `services/travel-db.ts`), o texto livre do campo "Contexto da Viagem" do
  front (perfil do cliente, tipo de viagem, preferências etc. — ver
  `original-miles-cartinhas/src/routes/index.tsx`, campo `tripContext`/`saveTripSummary`). Sem
  input — sempre a viagem do `requestContext`. `summary` vem `null` se a viagem ainda não tiver
  contexto cadastrado.
- **`anotarContextoViagem`** (`tools/note-travel-context-tool.ts`) — **automático, sem
  confirmação**: tudo que o consultor conta sobre o cliente/viagem é anotado na hora.
  `appendTravelSummary` (`services/travel-db.ts`) acrescenta UMA linha ao fim de `travel.summary`
  concatenando no SQL, com o limite (`MAX_TRAVEL_SUMMARY_LENGTH`, 4000) conferido na mesma query —
  o model nunca reescreve o texto inteiro, então não tem como apagar algo por engano. Se não couber,
  devolve erro pedindo pra consolidar com `atualizarContextoViagem`.
- **`atualizarContextoViagem`** (`tools/update-travel-context-tool.ts`) — reescreve `travel.summary`
  inteiro (`saveTravelSummary`, a mesma função da rota `PUT /travel_agent/travel-summary`). Só pra
  corrigir ou consolidar o texto; informação nova vai por `anotarContextoViagem`. Como substitui tudo,
  **`requireApproval: true`**.
- **`buscarSugestoes`** (`tools/get-suggestions-tool.ts`) — lista as sugestões de atividades já
  geradas pra esta viagem (`getSuggestions`, `services/travel-db.ts`, coluna `travel.suggestions`),
  com filtro opcional por `status` (`pending`/`approved`/`rejected`/`all`). Sem `status`, esconde as
  rejeitadas por padrão (só mostra `pending`+`approved`) — o model só vê rejeitadas se pedir
  `"rejected"`/`"all"` explicitamente, decisão pra não poluir a resposta com o que já foi recusado a
  menos que o consultor pergunte por isso. A lista vem enxuta (sem `content`); `suggestionId`
  devolve uma sugestão só, completa. Tool de leitura, sem regra de confirmação.
- **`sugerirAtividades`** (`tools/suggest-activities-tool.ts`) — gera novas sugestões pra um dia
  específico (`suggestDayActivities`, `agents/schedule-suggestion/suggest-day-activities.ts` — o
  mesmo agente/pipeline usado pela rota `POST /travel_agent/schedule-suggestion`, com validação e
  correção automática, ver `schedule-suggestion-validator.ts`), gravadas como `pending`. Não altera
  nem apaga nada existente (só propõe), por isso é a única tool de escrita deste agente SEM regra
  de confirmação prévia — decisão explícita só na description da tool. Usada quando o consultor
  quer VÁRIAS opções pra escolher; pra um pedido pontual em conversa, o model propõe a ideia direto
  em texto (ver "## Sugestões de atividades" no prompt) e usa `adicionarSugestaoAoDiaADia` abaixo.
- **`decidirSugestao`** (`tools/decide-suggestion-tool.ts`) — aprova ou rejeita UMA sugestão já
  gerada, pelo `suggestionId` (de `buscarSugestoes`). Chama `applySuggestionDecision`
  (`agents/schedule-suggestion/apply-suggestion-decision.ts`) — a MESMA função usada pela rota
  `POST /travel_agent/schedule-suggestion/decision` (botão de aprovar/rejeitar do front) — pra
  decidir pelo chat ter o mesmo efeito de decidir pela tela: aprovar insere o evento em
  `daily_schedule`, atomicamente junto da decisão (mesmo lock de `withTravelScheduleLock`).
  **`requireApproval: true`** — ver "## Aprovação de tools sensíveis" abaixo.
- **`adicionarSugestaoAoDiaADia`** (`tools/add-suggestion-to-schedule-tool.ts`) — fluxo
  conversacional: uma ideia que nunca passou por `sugerirAtividades` (nasceu de uma proposta
  pontual do model, refinada em conversa até o consultor concordar). Chama
  `createDecidedSuggestion` (`services/travel-db.ts`) — grava a ideia já como sugestão `approved`
  (aparece no histórico de `buscarSugestoes` como qualquer outra) e insere o evento dela em
  `daily_schedule`, na mesma transação. Sem rota HTTP equivalente hoje (o front só gera sugestões em
  massa). **`requireApproval: true`** — ver "## Aprovação de tools sensíveis" abaixo.
- **Uma sugestão por vez** — as três com `requireApproval: true`, cada uma chamando a mesma função
  da rota equivalente em `routes/schedule-suggestion-decision-routes.ts`:
  - **`criarSugestao`** (`tools/create-suggestion-tool.ts`) — `createPendingSuggestion` (rota
    `POST /travel_agent/schedule-suggestion/item`): UMA sugestão pendente combinada na conversa, que
    vai pro kanban pra decidir depois (não entra no dia a dia).
  - **`atualizarSugestao`** (`tools/update-suggestion-tool.ts`) — `updatePendingSuggestion` (rota
    `PATCH /travel_agent/schedule-suggestion/item`): texto e/ou dia/período, só de pendentes — uma
    aprovada já é evento do dia a dia e se edita por `atualizarEventoDiaADia`.
  - **`removerSugestao`** (`tools/remove-suggestion-tool.ts`) — `removeSuggestion` (rota `DELETE
    /travel_agent/schedule-suggestion/decision`, o botão de apagar do histórico): apaga de vez e, se
    ela já estava aprovada, tira o evento dela do dia a dia na mesma transação (antes ficava órfão).

## Conversa x ação

O prompt ("## Como conversar") separa três tipos de escrita:

- **Automáticas, sem perguntar** — o que o consultor CONTA fica registrado na hora:
  `anotarContextoViagem` (qualquer informação sobre cliente/viagem) e `rejeitarSugestaoDoChat` (uma
  ideia que o Ori propôs no chat e o consultor recusou, gravada como `rejected` com o motivo — é o
  que impede o Ori e o gerador de sugestões de oferecerem a mesma coisa de novo).
- **Com prévia + cartão** — tudo que grava no dia a dia ou mexe em sugestões: primeiro o texto no
  chat ("está bom?"), depois o cartão de aprovação da tool (`tools/preview-rule.ts`). Uma ideia que o
  Ori sugeriu e o consultor aprovou já teve o texto mostrado, então vai direto pro cartão
  (`adicionarSugestaoAoDiaADia`).
- **Só leitura** — livres, sem anunciar.

Pergunta ou ideia solta recebe resposta, não ação. Sugestões são feitas na conversa (1 a 3 ideias
no formato do dia a dia); o Ori consulta `buscarSugestoes` com `status: "all"` antes, pra não repetir
o que já foi aprovado ou rejeitado. `createDecidedSuggestion` (`services/travel-db.ts`) é a função
única que registra uma sugestão decidida no chat — aprovada (entra no dia a dia) ou rejeitada.

## Aprovação de tools sensíveis (`requireApproval`)

Todas as tools que escrevem no dia a dia ou em sugestões (exceto `sugerirAtividades`, que só gera pendentes em massa) têm `requireApproval: true`
(mecanismo nativo do Mastra, não uma convenção de prompt como as outras tools de escrita acima) —
ver [Human-in-the-loop](https://mastra.ai/docs/agents/human-in-the-loop). Diferença real: nas
outras tools, a "confirmação antes de chamar" é só uma instrução na `description`, e nada no código
impede o model de chamar direto se ele "esquecer" a regra. Com `requireApproval`, o próprio Mastra
intercepta a chamada ANTES do `execute()` rodar — o model decide chamar e monta os args, mas a
tool só executa de verdade depois de aprovada por fora, não importa o que o model "ache" que já foi
confirmado.

Como isso aparece pro chamador (`askOri`/`ori-routes.ts`):

- `oriAgent.generate()` pausado devolve `finishReason: 'suspended'` + `suspendPayload`
  (`toolCallId`, `toolName`, `args`) + `runId`, em vez do `object` normal — `finalizeOriOutput`
  (`ori-agent.ts`) detecta isso e devolve `pending_approval: { run_id, tool_call_id, tool_name,
  args }` no lugar do envelope normal, com um `response` já preenchido em código (não pela LLM, que
  ainda não gerou nada) por `describePendingApproval` — que sempre diz O QUÊ vai ser feito (nome da
  sugestão, dia e período, buscados pelo `suggestionId`), nunca só "esta sugestão".
- A rota recebe `travel_id` junto (confere o tenant e dá contexto pra descrever uma próxima pausa
  encadeada).
- `decideOriToolCall(runId, toolCallId, approved, reason?)` resolve a pausa —
  `approveToolCallGenerate`/`declineToolCallGenerate` do Mastra — e passa pelo mesmo
  `finalizeOriOutput` (pode pausar de novo se o model encadear outra tool sensível).
- Rota nova: `POST /travel_agent/ori/approval` (`routes/ori-routes.ts`) — é assim que o consultor
  resolve a pausa. O front (`original-miles-cartinhas`) já tem um cartão de confirmação nos dois
  chats (drawer e principal) que aparece quando a resposta traz `pending_approval` e chama essa
  rota ao aprovar/recusar.

Todas as três tools de escrita de voucher (criar/atualizar/excluir) disparam os mesmos gatilhos
fire-and-forget de `routes/voucher-routes.ts` para manter `travel.daily_schedule` reagindo a
qualquer mudança de voucher, não só às feitas pelo pipeline de extração automática — ver
`tools/daily-schedule-trigger.ts` (`triggerDailyScheduleUpdate`/`triggerDailyScheduleRemoval`).
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

Sem essa memória, o fluxo de confirmação de `criarDocumento` (e das outras tools de escrita que
pedem confirmação por convenção de prompt — `atualizarDocumento`, `deletarDocumento`,
`atualizarEventoDiaADia`, `atualizarContextoViagem`) não funcionaria: a resposta de confirmação do
consultor chega numa chamada HTTP separada (`session_id` igual), e só o histórico da mesma thread
permite o agente lembrar o que ele mesmo perguntou. `decidirSugestao`/`adicionarSugestaoAoDiaADia`
não dependem disso — a pausa delas é resolvida pelo snapshot do próprio Mastra (`runId`/
`toolCallId`), não pelo histórico da thread (ver "## Aprovação de tools sensíveis" acima).

## Arquivos desta pasta

- `ori-agent.ts` — `Agent` (`memory`, as 20 tools, `structuredOutput: oriResultSchema`) + `askOri`,
  chamado pela rota.
- `schema.ts` — `oriResultSchema`.
- `prompts/system-prompt.ts` — `buildOriInstructions` (texto fixo do prompt + lista de vouchers).
- `tools/` — as 20 tools + `daily-schedule-trigger.ts` (gatilhos compartilhados de criar/atualizar/
  excluir voucher).
