import { removeVoucherFromDailySchedule, updateDailyScheduleForVoucher } from './rebuild-daily-schedule';
import type { VoucherSummary } from '../../services/travel-db';

// Gatilhos fire-and-forget que mantêm o dia a dia reagindo a QUALQUER mudança de voucher (criar/
// editar -> regera os eventos dele; excluir -> remove os eventos dele, sem IA). Usados pelas rotas de
// `routes/voucher-routes.ts` e pelas tools de voucher do Ori — a resposta não espera o dia a dia.
//
// Usa `console.error` (não `helpers/logger.ts`) de propósito: `logger.ts` importa `mastra-instance.ts`
// de volta, e este arquivo é importado pelas tools do agente — encadear os dois cria um ciclo real no
// grafo de módulos do bundle (`mastra-instance -> ori-agent -> tools -> este arquivo -> logger ->
// mastra-instance`).
export function triggerDailyScheduleUpdate(tenantId: string, travelId: string, voucher: VoucherSummary, userId: string): void {
  void updateDailyScheduleForVoucher(tenantId, travelId, voucher, userId).catch((error) =>
    console.error(`[dia a dia] falha ao atualizar daily_schedule da viagem ${travelId}`, error),
  );
}

export function triggerDailyScheduleRemoval(tenantId: string, travelId: string, voucherId: string, userId: string): void {
  void removeVoucherFromDailySchedule(tenantId, travelId, voucherId, userId).catch((error) =>
    console.error(`[dia a dia] falha ao remover voucher ${voucherId} do daily_schedule da viagem ${travelId}`, error),
  );
}
