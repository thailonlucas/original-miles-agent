import { withTravelScheduleLock } from '../../services/travel-db';
import { readScheduleDays, rebuildVoucherEvents, saveScheduleDays } from './rebuild-daily-schedule';
import type { DailyScheduleDay } from './schema';

export interface DailyScheduleGeneration {
  days: DailyScheduleDay[];
  // Mesmo array serializado, no contrato que o front já espera de `POST /travel_agent/daily-schedule`.
  response: string;
  analysedDocIds: string[];
}

// Regenera o dia a dia sob demanda: refaz todos os eventos de voucher do zero, mantendo sugestões
// aprovadas e eventos manuais. Única função usada tanto pela rota `POST
// /travel_agent/daily-schedule` quanto pela tool `gerarDiaADia` do Ori.
export async function generateDailySchedule(tenantId: string, travelId: string, userId: string): Promise<DailyScheduleGeneration> {
  return withTravelScheduleLock(tenantId, travelId, userId, async (client) => {
    const currentDays = await readScheduleDays(tenantId, travelId, client);
    const { days, openedVoucherIds } = await rebuildVoucherEvents(tenantId, travelId, currentDays, client);
    await saveScheduleDays(tenantId, travelId, days, client);
    return { days, response: JSON.stringify(days), analysedDocIds: openedVoucherIds };
  });
}
