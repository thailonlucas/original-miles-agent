import { getTravelSummary, getVoucherSummaries, saveTravelSchedule, withTravelScheduleLock } from '../../services/travel-db';
import { generateDailyScheduleReport } from './daily-schedule-agent';
import { isRelevant } from './rebuild-daily-schedule';
import { dailyScheduleSchema } from './schema';

export interface DailyScheduleGeneration {
  response: string;
  analysedDocIds: string[];
}

// Usado só pelo endpoint `POST /travel_agent/daily-schedule` — gera o roteiro do ZERO (como
// `rebuildDailySchedule`), mas com o prompt/schema de `generateDailyScheduleReport` (roteiro DENSO,
// um dia por item entre o primeiro e o último da viagem, dentro de um envelope { response,
// analysed_doc_ids }). `travel_start_at`/`travel_end_at` são derivados aqui do primeiro/último item
// do array retornado, já que esse fluxo não pede essas datas separadamente ao model.
export async function generateDailySchedule(tenantId: string, travelId: string, userId: string): Promise<DailyScheduleGeneration> {
  return withTravelScheduleLock(tenantId, travelId, userId, async (client) => {
    const [vouchers, summary] = await Promise.all([
      getVoucherSummaries(tenantId, travelId, client).then((all) => all.filter(isRelevant)),
      getTravelSummary(tenantId, travelId, client),
    ]);
    const { response, analysed_doc_ids: analysedDocIds } = await generateDailyScheduleReport(vouchers, tenantId, summary);

    const schedule = dailyScheduleSchema.parse(JSON.parse(response));
    const travelStartAt = schedule[0]?.date ?? null;
    const travelEndAt = schedule[schedule.length - 1]?.date ?? null;

    await saveTravelSchedule(tenantId, travelId, { dailySchedule: schedule, travelStartAt, travelEndAt }, client);

    return { response, analysedDocIds };
  });
}
