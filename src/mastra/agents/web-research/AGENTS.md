# AGENTS.md — web-research

Leia este arquivo antes de alterar qualquer coisa nesta pasta.

## Objetivo

Pesquisar na internet um termo que o consultor APROVOU e devolver um resumo curto (até 150 palavras)
com o link de cada informação. Só é chamado pelo `execute` da tool `pesquisarNaInternet` do Ori
(`agents/ori/tools/web-search-tool.ts`), que tem `requireApproval: true`.

## Regras

- Nunca registrar `webSearchTool` direto no Ori: a busca nativa do provedor roda na OpenAI e escapa
  do `requireApproval` — o Ori poderia buscar sem o consultor aprovar. A aprovação fica na tool do Ori;
  este agente só roda depois dela.
- Recebe só o termo (e, opcional, um link) — nada da viagem nem do cliente. O termo é o que vai pro
  buscador.
- Sem structured output: a combinação com a tool nativa do provedor não é documentada no Mastra.
- O resultado nunca vira conteúdo de evento do dia a dia sozinho (ver prompt do Ori, "Pesquisa na
  internet"): só se o consultor pedir depois de conferir.

## Arquivos

- `web-research-agent.ts` — o `Agent` (`webSearchTool` + `webFetchTool`) e `researchWeb`.
- `prompts/system-prompt.ts` — como pesquisar e responder (fontes oficiais, data da fonte, "Fontes:").
