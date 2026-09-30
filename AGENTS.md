# AGENTS.md

## CRITICAL: Load `mastra` skill first

Load the `mastra` skill BEFORE any Mastra work. Never rely on cached knowledge — APIs change between versions.

## Rules

- Register all agents, tools, workflows, and scorers in `src/mastra/index.ts`
- Use the `dev` and `build` scripts from `package.json` instead of running `mastra dev` / `mastra build` directly

## Agent folder structure

Each agent lives in its own folder under `src/mastra/agents/<agent-id>/`:

- `<agent-id>-agent.ts` — the Mastra `Agent` definition, imported and registered in `src/mastra/index.ts`
- `AGENTS.md` — this agent's objective and rules; read it before changing anything in the folder
- `prompts/system-prompt.ts` — the agent's system prompt (used as `instructions`)
- `prompts/context-prompt.ts` — the wrapper text meant to accompany every user message (available skills/tools, etc.), when the agent needs one
- `schema.ts` / `output-processor.ts` — structured output schema and/or `Processor`, when the agent needs one

Not every agent needs every file above — a plain classifier or media-analysis agent may only need the main file, `AGENTS.md`, and `prompts/system-prompt.ts`.

Tools (whether colocated in an agent's own `tools/` folder or under the shared `src/mastra/tools/`) are named `<tool-name>-tool.ts`.

Follow this same layout when adding a new agent. Read the agent's own `AGENTS.md` before touching its folder.

## Agents (roadmap)

- `luna` — agente principal, responde o cliente via WhatsApp com base na F.A.Q. da empresa.
- `original-miles-guardrail` — roda depois da Luna em toda resposta; decide se ela pode ir pro cliente final ou se deve transferir pra um humano.
- `trending` — observa as mensagens da conversa e popula uma base de conhecimento para o time acompanhar erros e desejos dos clientes em tempo real.
- `ori-memory-learner` — observa as conversas com o Ori e aprende como cada consultor trabalha (memória por usuário + candidatas a regra do tenant).
- `tags` — vários agentes que observam a conversa e adicionam tags para ajudar na tabulação do ticket no Zendesk.

Only `luna` exists so far; the others are built one at a time as their prompts are provided.

## Resources

- [Mastra Documentation](https://mastra.ai/llms.txt)
