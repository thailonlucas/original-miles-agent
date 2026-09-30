import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { generateDailySchedule } from '../../daily-schedule/generate-daily-schedule';

// "Gerar Dia a Dia" — refaz do zero os cards que vêm dos vouchers; sugestões aprovadas, eventos do chat
// e à mão e títulos editados ficam. Chama `generateDailySchedule`, a mesma função da rota `POST
// /travel_agent/daily-schedule` (botão de gerar do front). É o único caminho que refaz cards de
// voucher do zero — mudança de voucher só encaixa.
//
// `requireApproval: true` — edições feitas nos cards de voucher se perdem; o cartão
// (`describeScheduleRebuild`, `ori-agent.ts`) diz quantos cards são refeitos e o que fica.
export const generateDailyScheduleTool = createTool({
  id: 'gerarDiaADia',
  requireApproval: true,
  description:
    'Refaz do zero todos os cards que vêm dos vouchers — edições feitas neles se perdem. Sugestões aprovadas, eventos adicionados ' +
    'à mão ou pelo chat e títulos editados dos dias ficam. Use só quando o consultor pedir explicitamente pra montar ou refazer o ' +
    'dia a dia; pra incluir, mudar ou tirar um evento use as tools ' +
    'de um evento. Voucher novo ou alterado já entra sozinho no dia a dia, sem esta tool. Nunca escreva o dia a dia você mesmo na ' +
    'resposta. A chamada pausa esperando confirmação do consultor antes de executar.',
  inputSchema: z.object({}),
  outputSchema: z.unknown(),
  execute: async (_, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('gerarDiaADia: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    // Devolve só um resumo pro model — o dia a dia inteiro já está gravado e o front recarrega
    // sozinho (`updated_data`); repassar o array todo aqui só enche o contexto.
    const { days, analysedDocIds } = await generateDailySchedule(tenantId, travelId, userId);
    return {
      day_count: days.length,
      first_day: days[0]?.date ?? null,
      last_day: days[days.length - 1]?.date ?? null,
      days: days.map((day) => ({ date: day.date, title: day.title })),
      analysed_doc_ids: analysedDocIds,
    };
  },
});
