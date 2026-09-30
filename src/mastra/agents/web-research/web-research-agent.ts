import { Agent } from '@mastra/core/agent';
import { webFetchTool, webSearchTool } from '@mastra/core/tools';
import { buildWebResearchInstructions } from './prompts/system-prompt';

// Faz a pesquisa na internet pedida pelo Ori (tool `pesquisarNaInternet`, `agents/ori/tools/`),
// SEMPRE depois de o consultor aprovar o cartão. Fica separado do Ori de propósito: a busca nativa do
// provedor (`webSearchTool`) roda do lado da OpenAI e não passa pelo `requireApproval` do Mastra — se
// ficasse direto no Ori, ele poderia buscar sem pedir. Aqui ele só é chamado pelo `execute` da tool
// aprovada. Não recebe nada da viagem/cliente, só o termo aprovado. Sem structured output: a
// combinação com a tool nativa do provedor não é documentada; texto com as fontes basta.
export const webResearchAgent = new Agent({
  id: 'web-research',
  name: 'Web Research',
  description: 'Pesquisa na internet um termo aprovado pelo consultor e devolve um resumo curto com as fontes.',
  instructions: buildWebResearchInstructions(new Date().toISOString().slice(0, 10)),
  model: 'openai/gpt-5.6-terra',
  tools: { buscarNaWeb: webSearchTool, abrirPagina: webFetchTool },
  defaultOptions: { maxSteps: 8 },
});

export async function researchWeb(query: string, url?: string): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = url ? `Pesquise: ${query}\n\nComece lendo esta página: ${url}` : `Pesquise: ${query}`;
  const { text } = await webResearchAgent.generate(prompt, { instructions: buildWebResearchInstructions(today) });
  return text.trim();
}
