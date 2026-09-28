# AGENTS.md — voucher-type

Leia este arquivo antes de alterar qualquer coisa nesta pasta.

## Objetivo

Classifica o tipo de um voucher/comprovante de viagem (imagem ou PDF: passagem aérea, hospedagem,
seguro viagem, transfer, aluguel de carro, reserva de restaurante, experiência/passeio, ferry etc.)
antes da extração estruturada dos dados. O resultado (`voucher_type_slug`) decide qual linha da
tabela `voucher_type` (prompt + `structured_output`) o agente extrator de vouchers deve usar —
ver `services/travel-db.ts`.

## Relação com outros agentes

- Roda **antes** do agente extrator de vouchers (ainda não construído — ver conversa/roadmap):
  primeiro classifica o tipo, depois a extração usa o `prompt`/`structured_output` daquele tipo
  específico (colunas da tabela `voucher_type`, não hardcoded no código).
- Não tem relação com o guardrail nem com a working memory do agente principal
  (`agents/original-miles/`) — é uma etapa isolada do fluxo de vouchers/viagem.

## Arquivos desta pasta

- `voucher-type-agent.ts` — define o `Agent` classificador e exporta
  `classifyVoucherType(mediaUrl, mediaType, tenantId)`. Multimodal (imagem/PDF via URL, mesmo
  padrão de `agents/shared/media-analysis-agent.ts`) + `structuredOutput` (`schema.ts`).
- `schema.ts` — `voucherTypeClassificationSchema`: `{ voucher_type_slug, confidence }`.
- `prompts/system-prompt.ts` — `buildSystemPrompt(voucherTypes)`: monta a lista de tipos
  disponíveis (slug/nome/descrição) dinamicamente a partir do que veio do Supabase — **não** é uma
  lista fixa no código, novos tipos cadastrados (via CRUD de `voucher_type`) aparecem automaticamente
  na próxima classificação.

## Tenant

- `tenantId` é **obrigatório** nas chamadas reais e passado via `requestContext`
  (`RequestContext`, chave `tenant_id`) — nunca por env var fixa. `instructions` chama
  `requestContext.get('tenant_id')`; se não vier (introspecção do Mastra sem contexto, ex.:
  Studio/`formatAgentList` do endpoint `/api/agents`, que chama `getInstructions()` pra cada agente
  registrado sem `tenant_id` nenhum), cai num prompt com a lista de tipos vazia em vez de lançar
  erro — lançar erro ali gerava warning/alerta a cada listagem de agentes sem nenhuma classificação
  real acontecer. Isso é diferente do padrão antigo
  de `agents/original-miles/` (tenant único via `LUNA_TENANT_ID`/`OM_TENANT_ID`): o schema real do
  Supabase (`voucher_type`, `voucher`, `travel`, `team`, `tenant`) é multi-tenant de verdade, com
  RLS por `tenant_id` resolvido a partir do usuário autenticado (ver `team.email = auth.jwt()->>'email'`
  nas policies). Quem chamar `classifyVoucherType` precisa resolver o `tenantId` do usuário antes
  (rota HTTP ainda não construída — ver notas abaixo).

## Notas de desenvolvimento

- **Acesso ao banco**: `services/travel-db.ts` usa `pg` direto via `SUPABASE_DB_URL` (connection
  string do Postgres), não o client REST de `services/supabase.ts`
  (`SUPABASE_SERVICE_ROLE_KEY`) — a service role key atual em `.env` não autenticou contra o
  projeto Supabase da Original Miles (401 "Invalid API key" via PostgREST) quando isso foi
  construído. Corrigir a key e trocar pro client REST é só mudar a implementação de
  `services/travel-db.ts`; nada aqui precisa mudar.
- **Sem rota HTTP ainda.** Este agente só expõe `classifyVoucherType(...)`; falta decidir/montar o
  endpoint real (provavelmente parte do fluxo de upload de voucher, junto com a extração) e como o
  `tenantId` é resolvido a partir do `Authorization: Bearer <access_token>` que o frontend manda
  (Supabase Auth — ver `team` table, resolução por email). Ver `/devs` do projeto
  `original-miles-cartinhas` (`src/routes/devs.tsx`) para o contrato de endpoints já documentado
  pelo time (hoje implementado em n8n, ainda não neste servidor Mastra).
- Modelo `openai/gpt-4.1-mini` (classificação simples, mesmo modelo já usado pelos agentes de
  análise de mídia) — os `ai_model`/`ai_provider` que existem por linha em `voucher_type`
  (`gpt-5.6-luna` / `gpt-5.6-terra`) são para a etapa de **extração**, não para esta classificação.
