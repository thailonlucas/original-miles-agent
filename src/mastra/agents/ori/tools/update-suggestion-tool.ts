import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { PREVIEW_BEFORE_WRITE } from './preview-rule';
import { schedulePeriodSchema } from '../../schedule-suggestion/schema';
import { EVENT_CONTENT_FORMAT, EVENT_TITLE_FORMAT, EVENT_TYPE_FORMAT } from '../../daily-schedule/event-format';
import { updatePendingSuggestion } from '../../../services/travel-db';

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// "Atualizar Sugestão" — altera o texto e/ou move pra outro dia/período uma sugestão AINDA PENDENTE.
// Mesma função (`updatePendingSuggestion`) da rota `PATCH /travel_agent/schedule-suggestion/item`.
export const updateSuggestionTool = createTool({
  id: 'atualizarSugestao',
  requireApproval: true,
  description:
    'Altera o texto de uma sugestão pendente e/ou move ela pra outro dia ou período, pelo "suggestionId" (de "buscarSugestoes"). ' +
    'Só funciona pra sugestões ainda pendentes — uma sugestão aprovada já é um evento do dia a dia, e aí o certo é ' +
    '"atualizarEventoDiaADia". Só envie o que muda. ' +
    PREVIEW_BEFORE_WRITE,
  inputSchema: z
    .object({
      suggestionId: z.string().describe('Id da sugestão, de "buscarSugestoes".'),
      title: z.string().optional().describe(`Novo título, se mudar. ${EVENT_TITLE_FORMAT}`),
      content: z
        .string()
        .optional()
        .describe(`Novo conteúdo COMPLETO (substitui o atual — mantenha os itens que não mudaram), se mudar. ${EVENT_CONTENT_FORMAT}`),
      type: z.string().optional().describe(`Nova categoria, se mudar. ${EVENT_TYPE_FORMAT}`),
      reason: z.string().optional().describe('Novo motivo da sugestão, se mudar.'),
      date: z.string().regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD').optional().describe('Novo dia, se for mover.'),
      period: schedulePeriodSchema.optional().describe('Novo período, se for mover.'),
    })
    .refine((v) => [v.title, v.content, v.type, v.reason, v.date, v.period].some((x) => x !== undefined), {
      message: 'Informe o que muda: title, content, type, reason, date ou period.',
    }),
  outputSchema: z.unknown(),
  execute: async ({ suggestionId, ...patch }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('atualizarSugestao: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    const updated = await updatePendingSuggestion(tenantId, travelId, userId, suggestionId, patch);
    if (!updated) {
      return { error: `sugestão ${suggestionId} não encontrada ou já decidida (se foi aprovada, altere o evento no dia a dia).` };
    }
    return { updated: true, id: updated.id, date: updated.date, period: updated.period, title: updated.event.title };
  },
});
