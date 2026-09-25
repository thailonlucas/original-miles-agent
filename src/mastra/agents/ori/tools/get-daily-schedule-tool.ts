import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getTravelSchedule } from '../../../services/travel-db';
import { dailyScheduleSchema, type DailyScheduleDay } from '../../daily-schedule/schema';
import { describeStay, ongoingStays } from '../../daily-schedule/schedule-merge';

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const PERIODS = ['morning', 'afternoon', 'night'] as const;

// "Buscar Dia a Dia" — duas respostas de tamanhos diferentes pra não encher o contexto (e a memória
// da thread, que guarda o resultado das tools):
// - sem `date`: índice enxuto da viagem inteira (título, período e posição de cada evento, sem
//   `content`) — basta pra responder "o que tem na viagem" e pra achar o date/period/index de um
//   evento antes de "atualizarEventoDiaADia".
// - com `date`: o dia inteiro, com o `content` completo de cada evento.
export const getDailyScheduleTool = createTool({
  id: 'buscarDiaADia',
  description:
    'Abre o dia a dia (roteiro, daily_schedule) já montado da viagem. Sem "date": devolve um índice enxuto de todos os dias ' +
    '(título, período e index de cada evento, sem detalhes). Com "date" (YYYY-MM-DD): devolve aquele dia completo, com os detalhes ' +
    'de cada evento. Use o índice pra se localizar e peça um dia específico quando precisar dos detalhes.',
  inputSchema: z.object({
    date: z.string().regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD').optional().describe('Dia a abrir com todos os detalhes. Omita pra ver o índice.'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ date }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    if (!tenantId || !travelId) {
      throw new Error('buscarDiaADia: requestContext "tenant_id"/"travel_id" são obrigatórios.');
    }

    const { dailySchedule, travelStartAt, travelEndAt } = await getTravelSchedule(tenantId, travelId);
    const parsed = dailyScheduleSchema.safeParse(dailySchedule);
    const days: DailyScheduleDay[] = parsed.success ? parsed.data : [];

    // Onde o cliente está nos dias do meio de uma hospedagem/aluguel — o dia a dia só tem o evento
    // de início e o de fim.
    const stays = ongoingStays(days);
    const ongoingOn = (d: string) => (stays.has(d) ? { ongoing: stays.get(d)!.map(describeStay) } : {});

    if (date) {
      const day = days.find((d) => d.date === date);
      return day ? { ...day, ...ongoingOn(date) } : { date, message: 'Nenhum evento neste dia.', ...ongoingOn(date) };
    }

    return {
      travel_start_at: travelStartAt,
      travel_end_at: travelEndAt,
      days: days.map((day) => ({
        date: day.date,
        title: day.title,
        events: PERIODS.flatMap((period) =>
          day.events[period].map((event, index) => ({ period, index, title: event.title, type: event.type, origin: event.source?.type ?? 'voucher' })),
        ),
        ...ongoingOn(day.date),
      })),
    };
  },
});
