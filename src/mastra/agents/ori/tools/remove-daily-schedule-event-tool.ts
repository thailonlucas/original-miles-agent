import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { PREVIEW_BEFORE_REMOVE } from './preview-rule';
import { schedulePeriodSchema } from '../../schedule-suggestion/schema';
import { removeDailyScheduleEvent } from '../../../services/travel-db';

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// "Remover Evento do Dia a Dia" — tira UM evento, localizado por (date, period, index), sem mexer no
// resto. Mesma função (`removeDailyScheduleEvent`) da rota `DELETE /travel_agent/daily-schedule/event`.
export const removeDailyScheduleEventTool = createTool({
  id: 'removerEventoDiaADia',
  requireApproval: true,
  description:
    'Remove UM evento do dia a dia, localizado pelo date/period/index do resumo do dia a dia (ou de "buscarDiaADia"), sem mexer no ' +
    'resto. Atenção: um evento que vem de voucher volta se aquele voucher for atualizado ou o dia a dia regenerado — pra tirar de ' +
    'vez, o caminho é excluir o voucher ("deletarDocumento"). ' + PREVIEW_BEFORE_REMOVE,
  inputSchema: z.object({
    date: z.string().regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD').describe('Dia do evento.'),
    period: schedulePeriodSchema.describe('Período do evento: "morning", "afternoon" ou "night".'),
    index: z.number().int().min(0).describe('Posição (0-based) do evento naquele dia/período.'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ date, period, index }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('removerEventoDiaADia: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    const removed = await removeDailyScheduleEvent(tenantId, travelId, userId, date, period, index);
    if (!removed) {
      return { error: `evento não encontrado nesse dia/período/índice (${date}/${period}/${index}).` };
    }
    return { removed: true, date, period, title: removed.title };
  },
});
