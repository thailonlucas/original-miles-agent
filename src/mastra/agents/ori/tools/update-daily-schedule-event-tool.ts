import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { PREVIEW_BEFORE_WRITE } from './preview-rule';
import { schedulePeriodSchema } from '../../schedule-suggestion/schema';
import { EVENT_CONTENT_FORMAT, EVENT_TITLE_FORMAT } from '../../daily-schedule/event-format';
import { updateDailyScheduleEvent } from '../../../services/travel-db';

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// "Atualizar Evento do Dia a Dia" — corrige título/conteúdo de UM evento e/ou move ele pra outro
// dia/período, localizado por (date, period, index). Mesma função (`updateDailyScheduleEvent`) da
// rota `PATCH /travel_agent/daily-schedule/event` (edição e drag-and-drop do kanban).
export const updateDailyScheduleEventTool = createTool({
  id: 'atualizarEventoDiaADia',
  requireApproval: true,
  description:
    'Corrige o título/conteúdo de UM evento do dia a dia e/ou move ele pra outro dia, período ou posição dentro do período, sem mexer no resto. Localize o ' +
    'evento pelo date/period/index do resumo do dia a dia (ou de "buscarDiaADia"). Só envie o que muda. Atenção: um evento que vem ' +
    'de voucher é refeito a partir do voucher se ele for atualizado ou o dia a dia regenerado. ' +
    PREVIEW_BEFORE_WRITE,
  inputSchema: z
    .object({
      date: z.string().regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD').describe('Dia ATUAL do evento.'),
      period: schedulePeriodSchema.describe('Período ATUAL do evento: "morning", "afternoon" ou "night".'),
      index: z.number().int().min(0).describe('Posição (0-based) do evento naquele dia/período.'),
      title: z.string().optional().describe(`Novo título, se mudar. ${EVENT_TITLE_FORMAT}`),
      content: z
        .string()
        .optional()
        .describe(`Novo conteúdo COMPLETO (substitui o atual — mantenha os itens que não mudaram), se mudar. ${EVENT_CONTENT_FORMAT}`),
      newDate: z.string().regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD').optional().describe('Novo dia, se for mover.'),
      newPeriod: schedulePeriodSchema.optional().describe('Novo período, se for mover.'),
      newIndex: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Nova posição (0-based) no período de destino, pra reordenar (ex: colocar depois do jantar). Omitido num move = fim do período.'),
    })
    .refine((v) => v.title !== undefined || v.content !== undefined || v.newDate !== undefined || v.newPeriod !== undefined || v.newIndex !== undefined, {
      message: 'Informe o que muda: title, content, newDate, newPeriod ou newIndex.',
    }),
  outputSchema: z.unknown(),
  execute: async ({ date, period, index, title, content, newDate, newPeriod, newIndex }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('atualizarEventoDiaADia: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    const updated = await updateDailyScheduleEvent(tenantId, travelId, userId, date, period, index, { title, content, newDate, newPeriod, newIndex });
    if (!updated) {
      return { error: `evento não encontrado nesse dia/período/índice (${date}/${period}/${index}).` };
    }
    return { updated: true, date: newDate ?? date, period: newPeriod ?? period, title: updated.title };
  },
});
