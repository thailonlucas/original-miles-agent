import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { schedulePeriodSchema } from '../../schedule-suggestion/schema';
import { keepDailyScheduleEvent } from '../../../services/travel-db';

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// "Manter Evento sem Voucher" — decisão "manter" de um card marcado como voucher excluído: a marca sai
// e, se o card tinha sido criado por esse voucher, ele vira evento manual. A decisão "remover" é
// `removerEventoDiaADia`. Mesma função (`keepDailyScheduleEvent`) da rota `POST
// /travel_agent/daily-schedule/event/keep`.
export const keepDailyScheduleEventTool = createTool({
  id: 'manterEventoSemVoucher',
  requireApproval: true,
  description:
    'Mantém no dia a dia UM card marcado como "voucher excluído" (date/period/index do resumo do dia a dia): a marca sai e o card ' +
    'fica como evento manual. Use só quando o consultor decidir manter o card; se ele decidir tirar, é "removerEventoDiaADia". ' +
    'Nunca decida sozinho.',
  inputSchema: z.object({
    date: z.string().regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD').describe('Dia do card.'),
    period: schedulePeriodSchema.describe('Período do card: "morning", "afternoon" ou "night".'),
    index: z.number().int().min(0).describe('Posição (0-based) do card naquele dia/período.'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ date, period, index }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('manterEventoSemVoucher: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    const result = await keepDailyScheduleEvent(tenantId, travelId, userId, date, period, index);
    if (!result) {
      return { error: `evento não encontrado nesse dia/período/índice (${date}/${period}/${index}).` };
    }
    if (!result.changed) return { kept: false, reason: 'Este card não estava marcado como voucher excluído.', title: result.event.title };
    return { kept: true, date, period, title: result.event.title };
  },
});
