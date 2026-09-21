# AGENTS.md — ori

Leia este arquivo antes de alterar qualquer coisa nesta pasta.

## Objetivo

"Ori", o agente de chat da Original Miles usado pelos consultores de viagem internos (não pelo
cliente final). Recebe uma pergunta/pedido em texto livre (`prompt`) sobre uma viagem específica
(`travel_id`) e responde com base nos vouchers já extraídos dessa viagem — desde responder uma
pergunta pontual ("qual o hotel do dia 3?") até montar o roteiro completo. Também pode
buscar/criar/atualizar/excluir vouchers da viagem através de tools, sempre por iniciativa
conversacional (nunca por comando estruturado).

Chamado via `POST /travel_agent/ori` (`routes/ori-routes.ts`).

## Prompt — reproduzido sem alteração de texto

`prompts/system-prompt.ts` (`buildOriInstructions`) reproduz **exatamente** o texto do prompt hoje
em produção no n8n para este agente — a pedido explícito de quem definiu esse prompt, pra não
quebrar um comportamento que já funciona. Não reescreva o texto por conta própria; qualquer ajuste
de redação é uma decisão separada, futura.

A única parte dinâmica é a seção "## Documentos disponíveis": no n8n era uma expressão
(`$('Busca vouchers da viagem').all().filter(...).map(...)`) que buscava os vouchers da viagem;
aqui é `formatVoucherList` (mesmo módulo), que reproduz o mesmo filtro (`title` E `content`
precisam existir) e o mesmo formato de linha (`doc_id: ..., title: ..., content: ...`) a partir de
`getVoucherSummaries` (`services/travel-db.ts`).

**Nenhuma instrução sobre as 4 tools abaixo foi adicionada ao prompt** (mesma razão: não alterar o
texto atual) — o comportamento esperado de cada tool (quando usar, pedir confirmação antes de
criar/excluir) fica só na `description` de cada tool, que o model sempre vê independente das
instructions.

## Saída — envelope fixo `{ response, analysed_doc_ids }`

`schema.ts` (`oriResultSchema`): mesmo envelope hoje vinculado ao node de IA do n8n —
`response` (string) e `analysed_doc_ids` (ids dos vouchers abertos com "buscarDocumento"). Como
`response` é uma string livre, ela comporta tanto uma resposta conversacional comum (pergunta
pontual, pedido de confirmação antes de criar um voucher) quanto o roteiro completo serializado
como JSON dentro dela, quando o pedido for "monta o roteiro" (aí valem as regras de "## Formato da
resposta" do prompt). O schema do roteiro em si (o JSON que vai dentro de `response` nesse caso)
não está tipado aqui — é o model seguindo o prompt em texto livre, igual já acontece hoje no n8n.

## As 4 tools — todas escopadas por `requestContext`

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

Todas as três tools de escrita (criar/atualizar/excluir) disparam os mesmos gatilhos
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

- `ori-agent.ts` — `Agent` (`memory`, as 4 tools, `structuredOutput: oriResultSchema`) + `askOri`,
  chamado pela rota.
- `schema.ts` — `oriResultSchema`.
- `prompts/system-prompt.ts` — `buildOriInstructions` (texto fixo do prompt + lista de vouchers).
- `tools/` — as 4 tools + `daily-schedule-trigger.ts` (gatilhos compartilhados de criar/atualizar/
  excluir).
