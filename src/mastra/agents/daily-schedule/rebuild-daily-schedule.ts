import type pg from 'pg';
import {
  getTravelSchedule,
  getTravelClientContext,
  getVoucherSummaries,
  saveTravelSchedule,
  withTravelScheduleLock,
  type VoucherSummary,
} from '../../services/travel-db';
import { getCardPreferences } from '../../services/ori-memory-db';
import { buildVoucherOperations, buildVoucherSchedule } from './daily-schedule-agent';
import { applyVoucherOperations, keepEditedTitles, keptEventsOnly, markVoucherRemoved, mergeDays, scheduleRange } from './schedule-merge';
import { dailyScheduleSchema, type DailyScheduleDay } from './schema';

// Nunca gera evento — cobertura, não atividade agendada. Filtrado em código (não só no prompt) pra
// essa regra nunca falhar por esquecimento do model.
const EXCLUDED_VOUCHER_TYPES = new Set(['travel_insurance']);

export function isRelevant(voucher: VoucherSummary): boolean {
  return !EXCLUDED_VOUCHER_TYPES.has(voucher.voucherTypeSlug);
}

// Formato inválido gravado (ex: linha antiga corrompida) é tratado como dia a dia vazio.
export async function readScheduleDays(tenantId: string, travelId: string, client: pg.PoolClient): Promise<DailyScheduleDay[]> {
  const { dailySchedule } = await getTravelSchedule(tenantId, travelId, client);
  const parsed = dailyScheduleSchema.safeParse(dailySchedule);
  return parsed.success ? parsed.data : [];
}

export async function saveScheduleDays(tenantId: string, travelId: string, days: DailyScheduleDay[], client: pg.PoolClient): Promise<void> {
  const { travelStartAt, travelEndAt } = scheduleRange(days);
  await saveTravelSchedule(tenantId, travelId, { dailySchedule: days, travelStartAt, travelEndAt }, client);
}

// "Refazer o dia a dia" (`generateDailySchedule`): refaz do zero SÓ os cards de voucher e junta de
// volta o que não veio de voucher (sugestões aprovadas, eventos do chat e à mão), que passa intacto —
// assim como os títulos de dia editados. Os cards mantidos vão pra LLM como contexto: um deles pode
// já cobrir um compromisso de voucher (a sugestão do restaurante enriquecida pela reserva), e aí ela
// não cria outro.
// `userId`: quem pediu pra refazer — os cards novos seguem o formato que ele pediu (`getCardPreferences`).
export async function rebuildVoucherEvents(
  tenantId: string,
  travelId: string,
  userId: string,
  currentDays: DailyScheduleDay[],
  client: pg.PoolClient,
): Promise<{ days: DailyScheduleDay[]; openedVoucherIds: string[] }> {
  const vouchers = (await getVoucherSummaries(tenantId, travelId, client)).filter(isRelevant);
  const summary = await getTravelClientContext(tenantId, travelId, client);
  const kept = keptEventsOnly(currentDays);
  const cardPreferences = await getCardPreferences(tenantId, userId);

  const fromVouchers =
    vouchers.length > 0 ? await buildVoucherSchedule(vouchers, kept, tenantId, summary, cardPreferences) : { days: [], openedVoucherIds: [] };

  const days = keepEditedTitles(currentDays, mergeDays(fromVouchers.days, kept, 'base'));
  return { days, openedVoucherIds: fromVouchers.openedVoucherIds };
}

// Voucher criado ou atualizado: encaixa no dia a dia que já existe. A LLM devolve operações (enriquecer
// o card do mesmo compromisso, de qualquer origem, ou criar um card novo) e o código aplica — nenhum
// card é recriado, substituído, movido ou apagado, então o trabalho do consultor fica intacto. Vale
// também pra linhas antigas sem `source`: os cards delas são enriquecidos como qualquer outro.
export async function updateDailyScheduleForVoucher(tenantId: string, travelId: string, voucher: VoucherSummary, userId: string): Promise<void> {
  if (!isRelevant(voucher)) return;
  await withTravelScheduleLock(tenantId, travelId, userId, async (client) => {
    const currentDays = await readScheduleDays(tenantId, travelId, client);
    const vouchers = (await getVoucherSummaries(tenantId, travelId, client)).filter(isRelevant);
    const summary = await getTravelClientContext(tenantId, travelId, client);
    // Quem subiu/alterou o voucher: o card novo segue o formato que ele pediu.
    const cardPreferences = await getCardPreferences(tenantId, userId);
    const { operations, dayTitles } = await buildVoucherOperations(voucher.id, currentDays, vouchers, tenantId, summary, cardPreferences);

    const { days, skipped } = applyVoucherOperations(currentDays, voucher.id, operations, dayTitles);
    if (skipped.length > 0) {
      console.error(`[dia a dia] voucher ${voucher.id} (viagem ${travelId}): ${skipped.length} operação(ões) ignorada(s)`, JSON.stringify(skipped));
    }
    if (days !== currentDays) await saveScheduleDays(tenantId, travelId, days, client);
  });
}

// Voucher excluído: nenhum card sai — os cards que ele sustentava ficam marcados (`markVoucherRemoved`)
// até o consultor decidir remover ou manter. Sem chamada de IA.
export async function removeVoucherFromDailySchedule(tenantId: string, travelId: string, voucherId: string, userId: string): Promise<void> {
  await withTravelScheduleLock(tenantId, travelId, userId, async (client) => {
    const currentDays = await readScheduleDays(tenantId, travelId, client);
    const { days, marked } = markVoucherRemoved(currentDays, voucherId, new Date().toISOString());
    if (marked > 0) await saveScheduleDays(tenantId, travelId, days, client);
  });
}
