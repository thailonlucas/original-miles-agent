import { withTravelScheduleLock } from '../../services/travel-db';
import { readScheduleDays, rebuildVoucherEvents, saveScheduleDays } from './rebuild-daily-schedule';
import type { DailyScheduleDay } from './schema';

export interface DailyScheduleGeneration {
  days: DailyScheduleDay[];
  // Mesmo array serializado, no contrato que o front já espera de `POST /travel_agent/daily-schedule`.
  response: string;
  analysedDocIds: string[];
}

// "Refazer o dia a dia": refaz do zero os cards de voucher (edições feitas neles se perdem) e mantém
// sugestões aprovadas, eventos do chat e à mão e títulos editados. Mudança de voucher NUNCA chama isto
// (ela só encaixa, ver `updateDailyScheduleForVoucher`). Única função usada pela rota `POST
// /travel_agent/daily-schedule` (botão do front) e pela tool `gerarDiaADia` do Ori.
export async function generateDailySchedule(tenantId: string, travelId: string, userId: string): Promise<DailyScheduleGeneration> {
  return withTravelScheduleLock(tenantId, travelId, userId, async (client) => {
    const currentDays = await readScheduleDays(tenantId, travelId, client);
    const { days, openedVoucherIds } = await rebuildVoucherEvents(tenantId, travelId, currentDays, client);
    await saveScheduleDays(tenantId, travelId, days, client);
    return { days, response: JSON.stringify(days), analysedDocIds: openedVoucherIds };
  });
}
