import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { generateDailySchedule } from '../../daily-schedule/generate-daily-schedule';

// "Gerar Dia a Dia" — refaz do zero os eventos que vêm dos vouchers e grava no `daily_schedule`.
// Chama `generateDailySchedule`, a mesma função da rota `POST /travel_agent/daily-schedule` (botão
// de gerar do front). Sugestões aprovadas e eventos manuais são mantidos pelo próprio código.
//
// `requireApproval: true` — reescreve o dia a dia inteiro (edições feitas à mão em eventos de
// voucher são refeitas a partir do voucher), então só roda depois de aprovado.
export const generateDailyScheduleTool = createTool({
  id: 'gerarDiaADia',
  requireApproval: true,
  description:
    'Gera (ou regenera) o dia a dia completo da viagem a partir de todos os vouchers e grava de verdade — use quando o consultor ' +
    'pedir pra montar, refazer ou reorganizar o dia a dia. Nunca escreva o dia a dia você mesmo na resposta: chame esta tool. ' +
    'Sugestões aprovadas e eventos manuais são mantidos. A chamada pausa esperando confirmação do consultor antes de executar.',
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
