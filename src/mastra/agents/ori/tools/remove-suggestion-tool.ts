import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { PREVIEW_BEFORE_REMOVE } from './preview-rule';
import { removeSuggestion } from '../../../services/travel-db';

// "Remover Sugestão" — apaga uma sugestão de vez (qualquer status). Se ela já tinha sido aprovada, o
// evento que ela virou no dia a dia sai junto. Mesma função (`removeSuggestion`) da rota
// `DELETE /travel_agent/schedule-suggestion/decision` (botão de apagar do histórico).
export const removeSuggestionTool = createTool({
  id: 'removerSugestao',
  requireApproval: true,
  description:
    'Apaga uma sugestão de vez, pelo "suggestionId" (de "buscarSugestoes") — some do histórico, e se ela já estava aprovada o ' +
    'evento dela sai do dia a dia junto. Diferente de rejeitar ("decidirSugestao"), que guarda a recusa e o motivo pra calibrar ' +
    'as próximas sugestões: prefira rejeitar quando o cliente não gostou, e remover quando a sugestão simplesmente não deveria ' +
    'existir. ' +
    PREVIEW_BEFORE_REMOVE,
  inputSchema: z.object({
    suggestionId: z.string().describe('Id da sugestão, de "buscarSugestoes".'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ suggestionId }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('removerSugestao: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    const removed = await removeSuggestion(tenantId, travelId, userId, suggestionId);
    if (!removed) {
      return { error: `sugestão ${suggestionId} não encontrada.` };
    }
    return { removed: true, title: removed.event.title, removedFromSchedule: removed.status === 'approved' };
  },
});
