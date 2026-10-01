import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { DAY_TITLE_FORMAT } from '../../daily-schedule/event-format';
import { updateDailyScheduleDayTitle } from '../../../services/travel-db';

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// "Atualizar Título do Dia" — o título do DIA (subtítulo da coluna no kanban), um ou vários de uma vez
// ("atualiza os títulos com a regra nova"). Mesma função (`updateDailyScheduleDayTitle`) da rota
// `PATCH /travel_agent/daily-schedule/day`: o título fica marcado como editado e nenhum voucher troca
// mais — o pedido veio do consultor. Antes o Ori não tinha como mudar o título de um dia, só propor
// em texto. O cartão de aprovação (`describePendingApproval`) lista os títulos novos.
export const updateDayTitlesTool = createTool({
  id: 'atualizarTituloDoDia',
  requireApproval: true,
  description:
    'Troca o título de um ou mais DIAS do dia a dia (o subtítulo do dia, não o título de um card). Use quando o consultor pedir pra ' +
    'mudar ou padronizar o título de um dia ou de todos. Mande todos os dias de uma vez.',
  inputSchema: z.object({
    days: z
      .array(
        z.object({
          date: z.string().regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD').describe('Dia (precisa ter pelo menos um evento).'),
          title: z.string().min(1).max(200).describe(DAY_TITLE_FORMAT),
        }),
      )
      .min(1),
  }),
  outputSchema: z.unknown(),
  execute: async ({ days }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('atualizarTituloDoDia: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    const updated: { date: string; title: string }[] = [];
    const notFound: string[] = [];
    for (const { date, title } of days) {
      const day = await updateDailyScheduleDayTitle(tenantId, travelId, userId, date, title);
      if (day) updated.push({ date, title: day.title });
      else notFound.push(date);
    }
    return notFound.length ? { updated, not_found: notFound, note: 'Dia sem nenhum evento não tem título pra editar.' } : { updated };
  },
});
