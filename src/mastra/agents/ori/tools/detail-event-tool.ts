import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { schedulePeriodSchema } from '../../schedule-suggestion/schema';
import { eventDetailGaps } from '../../daily-schedule/event-format';
import { getDailyScheduleEvent, getSuggestions } from '../../../services/travel-db';

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// "Detalhar Evento" — só leitura. Abre UM evento do dia a dia (date/period/index) ou UMA sugestão
// (suggestionId) e compara o conteúdo com a lista de detalhes do tipo dele (`eventDetailGaps`,
// `daily-schedule/event-format.ts`): o que já tem e o que falta, separando o que o Ori pode completar
// sozinho ("lugar") do que só o consultor sabe ("reserva"). A escrita vem depois, pelas tools de
// sempre (`atualizarEventoDiaADia`/`atualizarSugestao`), com prévia e aprovação.
export const detailEventTool = createTool({
  id: 'detalharEvento',
  description:
    'Mostra o que falta num evento do dia a dia (date/period/index) ou numa sugestão (suggestionId) pra ficar completo, pela lista ' +
    'de detalhes do tipo dele. Use quando o consultor pedir pra detalhar/completar um evento ou sugestão, e antes de mostrar um ' +
    'evento novo que tenha pouca informação. "missing_from_place": complete você com o que sabe do lugar (aproximado). ' +
    '"missing_from_booking": pergunte ao consultor — nunca deduza.',
  inputSchema: z
    .object({
      date: z.string().regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD').optional().describe('Dia do evento no dia a dia.'),
      period: schedulePeriodSchema.optional().describe('Período do evento: "morning", "afternoon" ou "night".'),
      index: z.number().int().min(0).optional().describe('Posição (0-based) do evento naquele dia/período.'),
      suggestionId: z.string().optional().describe('Id de uma sugestão (de "buscarSugestoes"), no lugar de date/period/index.'),
    })
    .refine((v) => v.suggestionId !== undefined || (v.date !== undefined && v.period !== undefined && v.index !== undefined), {
      message: 'Informe date/period/index de um evento ou suggestionId de uma sugestão.',
    }),
  outputSchema: z.unknown(),
  execute: async ({ date, period, index, suggestionId }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    if (!tenantId || !travelId) {
      throw new Error('detalharEvento: requestContext "tenant_id"/"travel_id" são obrigatórios.');
    }

    const found = suggestionId
      ? await findSuggestion(tenantId, travelId, suggestionId)
      : await findEvent(tenantId, travelId, date!, period!, index!);
    if ('error' in found) return found;

    const { filled, missing } = eventDetailGaps(found.event);
    return {
      ...found,
      filled,
      missing_from_place: missing.filter((d) => d.from === 'lugar').map((d) => d.label),
      missing_from_booking: missing.filter((d) => d.from === 'reserva').map((d) => d.label),
    };
  },
});

async function findEvent(tenantId: string, travelId: string, date: string, period: 'morning' | 'afternoon' | 'night', index: number) {
  const event = await getDailyScheduleEvent(tenantId, travelId, date, period, index);
  if (!event) return { error: `evento não encontrado nesse dia/período/índice (${date}/${period}/${index}).` };
  const where = event.source?.type === 'voucher' || !event.source ? 'dia a dia (veio de voucher)' : 'dia a dia';
  return { where, date, period, index, event: { title: event.title, type: event.type, content: event.content } };
}

async function findSuggestion(tenantId: string, travelId: string, suggestionId: string) {
  const suggestion = (await getSuggestions(tenantId, travelId)).find((s) => s.id === suggestionId);
  if (!suggestion) return { error: `sugestão ${suggestionId} não encontrada.` };
  return {
    where: `sugestão ${suggestion.status}`,
    date: suggestion.date,
    period: suggestion.period,
    event: { title: suggestion.event.title, type: suggestion.event.type, content: suggestion.event.content },
  };
}
