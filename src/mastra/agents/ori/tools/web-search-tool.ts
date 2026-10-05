import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { researchWeb } from '../../web-research/web-research-agent';

// "Pesquisar na Internet" — sem aprovação do consultor: o Ori pesquisa direto. O `execute` chama o
// agente `web-research`, que é quem de fato busca — ver `agents/web-research/AGENTS.md` pra por que a
// busca não fica direto no Ori. Só leitura: não grava nada na viagem. Todo o "como pesquisar" mora
// aqui (description + `how_to_present`) — saiu do prompt do Ori, onde ficava repetido: uma tool só,
// sempre visível pro model, não precisa de seção nem de skill.
export const internetSearchTool = createTool({
  id: 'pesquisarNaInternet',
  description:
    'Pesquisa na internet um fato atual que NÃO está nos vouchers, no Contexto da Viagem nem no dia a dia. Use quando o consultor ' +
    'pedir pesquisa ou quando a resposta depender de um fato que muda com o tempo e você não tem como saber (horário de funcionamento, ' +
    'se abre em tal dia, se ainda existe, evento numa data, regra de entrada) — chame direto. ' +
    'NÃO use pra recomendar, comparar ou opinar — nem pra "confirmar" antes de recomendar: ' +
    'responda com o que já sabe. Nunca ofereça pesquisar no fim de uma resposta. No "query", NUNCA coloque nome, documento, contato ' +
    'ou qualquer dado do cliente — só o assunto (ex: "horário de funcionamento Cenacolo Vinciano Milão setembro 2026").',
  inputSchema: z.object({
    query: z.string().min(3).max(200).describe('O que pesquisar, sem dado do cliente. Específico: lugar, cidade e data quando fizer diferença.'),
    url: z.string().url().optional().describe('Link pra ler, se o consultor mandou um.'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ query, url }) => {
    const summary = await researchWeb(query, url);
    return {
      summary,
      searched_at: new Date().toISOString(),
      how_to_present:
        'Responda com o resumo e os links das fontes. Feche com uma linha curta lembrando que é informação da internet, a conferir ' +
        'nas fontes antes de repassar ao cliente. Nada disso entra num card do dia a dia, a menos que o consultor peça depois de conferir.',
    };
  },
});
