import { rebuildDailySchedule, updateDailyScheduleForVoucher } from '../../daily-schedule/rebuild-daily-schedule';
import type { VoucherSummary } from '../../../services/travel-db';

// Mesmos gatilhos fire-and-forget de `routes/voucher-routes.ts` (criar/editar voucher -> update
// incremental; excluir voucher -> rebuild completo), reusados aqui pelas tools de criar/atualizar/
// excluir do agente Ori — manter o daily_schedule reagindo a QUALQUER mudança de voucher, não só
// às feitas pelo pipeline de extração automática.
//
// Usa `console.error` (não `helpers/logger.ts`) de propósito: este arquivo é importado pelas
// tools do agente (`ori-agent.ts` -> bundle do Mastra), e `logger.ts` importa `mastra-instance.ts`
// de volta (ver comentário lá) — encadear os dois cria um ciclo real no grafo de módulos do bundle
// (`mastra-instance -> ori-agent -> tools -> este arquivo -> logger -> mastra-instance`), diferente
// de `voucher-routes.ts`, que só é importado UMA VEZ por `mastra-instance.ts` (rota, fora do bundle
// dos agents/tools).
export function triggerDailyScheduleUpdate(tenantId: string, travelId: string, voucher: VoucherSummary, userId: string): void {
  void updateDailyScheduleForVoucher(tenantId, travelId, voucher, userId).catch((error) =>
    console.error(`[Ori] falha ao atualizar daily_schedule da viagem ${travelId}`, error),
  );
}

export function triggerDailyScheduleRebuild(tenantId: string, travelId: string, userId: string): void {
  void rebuildDailySchedule(tenantId, travelId, userId).catch((error) =>
    console.error(`[Ori] falha ao reconstruir daily_schedule da viagem ${travelId}`, error),
  );
}
