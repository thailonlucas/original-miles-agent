import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { PREVIEW_BEFORE_WRITE } from './preview-rule';
import { schedulePeriodSchema } from '../../schedule-suggestion/schema';
import { EVENT_CONTENT_FORMAT, EVENT_TITLE_FORMAT, EVENT_TYPE_FORMAT } from '../../daily-schedule/event-format';
import { insertDailyScheduleEvent } from '../../../services/travel-db';

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// "Adicionar Evento ao Dia a Dia" — insere UM evento que o consultor informou no chat (ex: "o
// cliente tem um casamento na noite do dia 12"), sem regenerar o resto. Grava com
// `source: { type: 'chat' }`, então nenhuma reconstrução a partir de vouchers apaga esse evento.
// Mesma função (`insertDailyScheduleEvent`) da rota `POST /travel_agent/daily-schedule/event`.
export const addDailyScheduleEventTool = createTool({
  id: 'adicionarEventoDiaADia',
  requireApproval: true,
  description:
    'Adiciona UM evento que o consultor informou (compromisso do cliente, ex: "casamento na noite do dia 12") num dia/período do ' +
    'dia a dia, sem mexer no resto — use isto em vez de "gerarDiaADia" sempre que o pedido for sobre um evento só. Pra uma ' +
    'atividade que VOCÊ sugeriu, use "adicionarSugestaoAoDiaADia". ' + PREVIEW_BEFORE_WRITE,
  inputSchema: z.object({
    date: z.string().regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD').describe('Dia do evento.'),
    period: schedulePeriodSchema.describe('Período: "morning" (00:00–11:59), "afternoon" (12:00–17:59) ou "night" (18:00–23:59).'),
    title: z.string().describe(EVENT_TITLE_FORMAT),
    content: z.string().describe(`${EVENT_CONTENT_FORMAT} Use só o que o consultor informou na conversa.`),
    type: z.string().describe(`${EVENT_TYPE_FORMAT} Na dúvida, "other".`),
  }),
  outputSchema: z.unknown(),
  execute: async ({ date, period, title, content, type }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('adicionarEventoDiaADia: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    const event = await insertDailyScheduleEvent(tenantId, travelId, userId, date, period, {
      title,
      content,
      type,
      observation: null,
      source: { type: 'chat' },
    });
    return { added: true, date, period, title: event.title };
  },
});
