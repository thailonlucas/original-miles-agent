import type pg from 'pg';
import {
  getTravelSchedule,
  getTravelClientContext,
  getVoucherSummaries,
  saveTravelSchedule,
  withTravelScheduleLock,
  type VoucherSummary,
} from '../../services/travel-db';
import { buildVoucherEvents, buildVoucherSchedule } from './daily-schedule-agent';
import { hasUntaggedEvents, keepEditedTitles, keptEventsOnly, mergeDays, replaceVoucherEvents, scheduleRange, withoutVoucher } from './schedule-merge';
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

// Refaz TODOS os eventos de voucher do zero e devolve eles junto com o que não veio de voucher
// (sugestões aprovadas, eventos manuais), que passa intacto — assim como os títulos de dia editados à mão.
export async function rebuildVoucherEvents(
  tenantId: string,
  travelId: string,
  currentDays: DailyScheduleDay[],
  client: pg.PoolClient,
): Promise<{ days: DailyScheduleDay[]; openedVoucherIds: string[] }> {
  const vouchers = (await getVoucherSummaries(tenantId, travelId, client)).filter(isRelevant);
  const summary = await getTravelClientContext(tenantId, travelId, client);

  const fromVouchers = vouchers.length > 0 ? await buildVoucherSchedule(vouchers, tenantId, summary) : { days: [], openedVoucherIds: [] };

  const days = keepEditedTitles(currentDays, mergeDays(fromVouchers.days, keptEventsOnly(currentDays), 'base'));
  return { days, openedVoucherIds: fromVouchers.openedVoucherIds };
}

// Voucher criado ou atualizado: tira os eventos antigos dele e gera os novos, no mesmo lugar que os
// antigos ocupavam — o resto do dia a dia (outros vouchers, sugestões, eventos manuais) não passa
// pela LLM e não muda.
export async function updateDailyScheduleForVoucher(tenantId: string, travelId: string, voucher: VoucherSummary, userId: string): Promise<void> {
  await withTravelScheduleLock(tenantId, travelId, userId, async (client) => {
    const currentDays = await readScheduleDays(tenantId, travelId, client);

    // Linha antiga, sem origem nos eventos: não dá pra saber quais eram deste voucher — reconstrói
    // uma vez do zero, e a viagem passa a ter origem em tudo.
    if (hasUntaggedEvents(currentDays)) {
      const { days } = await rebuildVoucherEvents(tenantId, travelId, currentDays, client);
      await saveScheduleDays(tenantId, travelId, days, client);
      return;
    }

    const withoutThisVoucher = withoutVoucher(currentDays, voucher.id);
    if (!isRelevant(voucher)) {
      await saveScheduleDays(tenantId, travelId, withoutThisVoucher, client);
      return;
    }

    const vouchers = (await getVoucherSummaries(tenantId, travelId, client)).filter(isRelevant);
    const summary = await getTravelClientContext(tenantId, travelId, client);
    const newEvents = await buildVoucherEvents(voucher.id, withoutThisVoucher, vouchers, tenantId, summary);

    // `currentDays` (não `withoutThisVoucher`): é dele que sai a posição que os eventos do voucher
    // ocupavam — eles voltam pro mesmo lugar em vez de ir pro fim do período.
    await saveScheduleDays(tenantId, travelId, replaceVoucherEvents(currentDays, voucher.id, newEvents), client);
  });
}

// Voucher excluído: só tira os eventos dele — sem chamada de IA.
export async function removeVoucherFromDailySchedule(tenantId: string, travelId: string, voucherId: string, userId: string): Promise<void> {
  await withTravelScheduleLock(tenantId, travelId, userId, async (client) => {
    const currentDays = await readScheduleDays(tenantId, travelId, client);

    // Mesmo caso de linha antiga de `updateDailyScheduleForVoucher`: o voucher já saiu do banco,
    // então reconstruir do zero já não inclui ele.
    const days = hasUntaggedEvents(currentDays)
      ? (await rebuildVoucherEvents(tenantId, travelId, currentDays, client)).days
      : withoutVoucher(currentDays, voucherId);

    await saveScheduleDays(tenantId, travelId, days, client);
  });
}
