import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { applySuggestionDecision } from '../../schedule-suggestion/apply-suggestion-decision';

// "Decidir Sugestão" — aprova ou rejeita UMA sugestão já gerada (por "sugerirAtividades" ou pelo
// botão "Sugerir atividades" do front), pelo `suggestionId` (de "buscarSugestoes"). Chama
// `applySuggestionDecision` — a MESMA função usada pela rota `POST
// /travel_agent/schedule-suggestion/decision` (botão de aprovar/rejeitar do front) — pra decidir
// pelo chat ter exatamente o mesmo efeito de decidir pela tela: aprovar insere o evento em
// `daily_schedule`, atomicamente junto da decisão.
//
// `requireApproval: true` — tool sensível (grava dado real, sem voucher por trás quando aprova):
// o Mastra pausa a execução ANTES de rodar (o model decide chamar e monta os args, mas o `execute`
// só roda depois de aprovado por fora) em vez de confiar só numa instrução de prompt pra "perguntar
// antes de chamar". Ver `askOri`/`decideOriToolCall` (`ori-agent.ts`) pra como o consultor
// aprova/recusa essa pausa.
export const decideSuggestionTool = createTool({
  id: 'decidirSugestao',
  requireApproval: true,
  description:
    'Aprova ou rejeita uma sugestão de atividade já gerada, pelo `suggestionId` (de "buscarSugestoes"). Ao aprovar, a atividade é ' +
    'inserida de verdade no dia a dia (`daily_schedule`) — mesmo sem nenhum voucher/reserva confirmando que ela vai acontecer. Esta ' +
    'chamada pausa automaticamente esperando confirmação explícita do consultor antes de executar — não é preciso perguntar antes de ' +
    'chamar, só chamar assim que a intenção estiver clara.',
  inputSchema: z.object({
    suggestionId: z.string().describe('Id da sugestão a decidir, da lista de "buscarSugestoes".'),
    decision: z.enum(['approved', 'rejected']).describe('"approved" insere a atividade no dia a dia; "rejected" só registra a rejeição.'),
    feedback: z
      .string()
      .max(1000)
      .optional()
      .describe('Motivo dado pela pessoa pra essa decisão (ex: "muito caro", "adoramos vinícolas") — ajuda a calibrar as próximas sugestões.'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ suggestionId, decision, feedback }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('decidirSugestao: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    const { decided, event } = await applySuggestionDecision(tenantId, travelId, userId, {
      id: suggestionId,
      status: decision,
      feedback: feedback?.trim() || null,
    });
    if (!decided) {
      return { error: `sugestão ${suggestionId} não encontrada ou já decidida.` };
    }
    return { decision, event };
  },
});
