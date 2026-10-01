# AGENTS.md — ori-memory-learner

Leia este arquivo antes de alterar qualquer coisa nesta pasta.

## Objetivo

Aprender, a partir das conversas com o Ori, como CADA consultor gosta de trabalhar (tom, formato dos
cards, o que perguntar, vocabulário) e guardar em `ori_user_memory`. Essa memória entra no prompt do
Ori em toda conversa daquele consultor (`buildOriInstructions`, seção "Como este consultor trabalha").
Também propõe candidatas a regra da agência ou a ajuste do prompt base (`ori_memory_candidate`).

## Camadas da memória (prioridade de cima pra baixo)

1. Regras obrigatórias do tenant (`ori_tenant_memory`, `required: true`) — só admin altera.
2. Preferências do consultor (`ori_user_memory`) — o que ele pede é lei acima de tudo abaixo. O kind
   "cards" entra também nos prompts dos geradores de card (`getCardPreferences`).
3. Regras não obrigatórias do tenant — o padrão da agência, que o consultor pode ajustar.
4. Prompt base (código) — todos os tenants. É só o ponto de partida: tom, fluxo e formato dos cards
   são padrões que as camadas de cima mudam. O Ori nunca recusa um pedido do consultor dizendo que
   "as regras não permitem".

Tabelas em `sql/ori_memory.sql`; acesso em `services/ori-memory-db.ts`.

## Como um item entra na memória do consultor

- **Explícito** — o consultor pede ("sempre...", "nunca...") e o Ori chama `anotarPreferenciaConsultor`
  (`agents/ori/tools/`), ou ele edita pela tela. Vale na hora. Este agente nunca altera nem remove.
- **Aprendido** — este agente percebe sozinho. `evidence` guarda as sessões em que apareceu (hits =
  tamanho da lista, nunca um contador solto: a mesma sessão não conta duas vezes e dá pra abrir a
  conversa de origem). Só entra no prompt com 2+ sessões (`LEARNED_MIN_SESSIONS`).
- Teto de `MAX_USER_ITEMS`: sai primeiro o aprendido com menos sessões e mais antigo
  (`trimUserMemory`). Explícito nunca sai sozinho.

## Quando roda

`ori-memory-learner-trigger.ts`, fire-and-forget depois que `POST /travel_agent/ori` grava o histórico
(`routes/ori-routes.ts`). `learnFromSession` só chama a LLM a cada `LEARN_EVERY_USER_MESSAGES`
mensagens do consultor na sessão, olhando as últimas `LEARN_WINDOW` (janela sobreposta de propósito).
Pedido explícito não depende disso — o próprio Ori grava na hora.

A LLM devolve operações (`schema.ts`); `applyLearnedOperations` aplica com as regras do código
(add de algo que já existe = reforço; update/remove só em item aprendido). Candidatas somam evidência
numa pendente igual (`existing_id` ou mesmo texto) em vez de duplicar.

## Candidatas

Admin decide em `POST /travel_agent/ori/memory-candidates/:id/decision` (`routes/ori-memory-routes.ts`):
"tenant" cria a regra do tenant na hora; "base" só marca — o ajuste é código, feito pelo time; "rejected"
descarta.

## Arquivos

- `ori-memory-learner-agent.ts` — o `Agent`, `applyLearnedOperations` (pura) e `learnFromSession`.
- `ori-memory-learner-trigger.ts` — gatilho em background.
- `prompts/system-prompt.ts` — instruções e mensagem (memória atual, regras do tenant, candidatas, trecho da conversa).
- `schema.ts` — saída estruturada (objeto plano, campos null quando não se aplicam).
