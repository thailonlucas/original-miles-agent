import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getTravelSchedule } from '../../../services/travel-db';

// "Buscar Dia a Dia" — abre o `daily_schedule` atual da viagem (dias com evento + o range
// `travel_start_at`/`travel_end_at`), pra consultar o dia a dia já montado sem precisar
// reconstruí-lo a partir dos vouchers a cada pergunta. "Dia a dia" é como o consultor chama isso
// na prática (o termo "roteiro" é mais um sinônimo técnico/interno) — por isso o nome da tool e a
// description usam esse termo, pro model reconhecer o pedido mesmo quando ninguém diz "roteiro".
// Mesmo contrato de `search-voucher-tool.ts`: `tenant_id`/`travel_id` vêm do `requestContext`,
// nunca de argumento que o model preenche.
export const getDailyScheduleTool = createTool({
  id: 'buscarDiaADia',
  description:
    'Abre o dia a dia (também chamado de roteiro, campo daily_schedule) já montado da viagem: os dias com evento confirmado (com ' +
    'date, period e index de cada evento) e o período total da viagem (travel_start_at/travel_end_at). Use para responder perguntas ' +
    'sobre o dia a dia atual (ex: "o que tem no dia 3?", "qual o próximo evento?") e para descobrir o date/period/index exatos antes ' +
    'de chamar "atualizarEventoDiaADia".',
  inputSchema: z.object({}),
  outputSchema: z.unknown(),
  execute: async (_, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    if (!tenantId || !travelId) {
      throw new Error('buscarDiaADia: requestContext "tenant_id"/"travel_id" são obrigatórios.');
    }

    const { dailySchedule, travelStartAt, travelEndAt } = await getTravelSchedule(tenantId, travelId);
    return { schedule: dailySchedule, travel_start_at: travelStartAt, travel_end_at: travelEndAt };
  },
});
