import {
  getTravelSchedule,
  getVoucherSummaries,
  saveTravelSchedule,
  withTravelScheduleLock,
  type VoucherSummary,
} from '../../services/travel-db';
import { applyVoucherToDailySchedule, buildDailyScheduleFromScratch } from './daily-schedule-agent';

// Nunca gera evento — cobertura, não atividade agendada (regra do prompt, ver
// `prompts/system-prompt.ts`). Filtrado aqui em código, não deixado só a cargo do agente, pra essa
// regra nunca falhar por esquecimento/alucinação do model.
const EXCLUDED_VOUCHER_TYPES = new Set(['travel_insurance']);

// Exportado para reuso por `generate-daily-schedule.ts` (endpoint `POST /travel_agent/daily-schedule`) —
// mesma regra, um único lugar pra ela não divergir entre os dois fluxos.
export function isRelevant(voucher: VoucherSummary): boolean {
  return !EXCLUDED_VOUCHER_TYPES.has(voucher.voucherTypeSlug);
}

// Reconstrói `travel.daily_schedule`/`travel_start_at`/`travel_end_at` do ZERO, a partir de todos
// os vouchers atuais da viagem. Mais caro que o update incremental (reprocessa tudo numa única
// chamada de IA) — usado quando um voucher é EXCLUÍDO, porque remover a contribuição de um voucher
// específico de um roteiro montado incrementalmente não é confiável (não dá pra saber com
// segurança quais pedaços do roteiro atual vieram só daquele voucher). Extração de voucher novo usa
// `updateDailyScheduleForVoucher` abaixo, não esta função.
export async function rebuildDailySchedule(tenantId: string, travelId: string, userId: string): Promise<void> {
  await withTravelScheduleLock(tenantId, travelId, userId, async (client) => {
    const vouchers = (await getVoucherSummaries(tenantId, travelId, client)).filter(isRelevant);

    const update =
      vouchers.length > 0
        ? await buildDailyScheduleFromScratch(vouchers, tenantId)
        : { schedule: [], travel_start_at: null, travel_end_at: null };

    await saveTravelSchedule(
      tenantId,
      travelId,
      { dailySchedule: update.schedule, travelStartAt: update.travel_start_at, travelEndAt: update.travel_end_at },
      client,
    );
  });
}

// Caminho padrão a cada voucher extraído: não reprocessa os outros vouchers da viagem — só passa
// pro agente o resumo de todos (id/tipo/título/resumo, sem `ai_extracted_data`) + o estado atual do
// roteiro, apontando qual é o voucher novo. O agente abre (tool `openVoucher`) só o que precisar.
// Ver AGENTS.md desta pasta para o motivo (velocidade/custo) e o tradeoff (risco de deriva entre
// chamadas incrementais sucessivas, mitigado por sempre reenviar o roteiro completo atual).
export async function updateDailyScheduleForVoucher(
  tenantId: string,
  travelId: string,
  newVoucher: VoucherSummary,
  userId: string,
): Promise<void> {
  if (!isRelevant(newVoucher)) return;

  await withTravelScheduleLock(tenantId, travelId, userId, async (client) => {
    // Sequencial, não `Promise.all` — as duas queries rodam no mesmo `client` (uma conexão só),
    // então rodar "em paralelo" só enfileiraria uma atrás da outra mesmo assim.
    const currentState = await getTravelSchedule(tenantId, travelId, client);
    const vouchers = await getVoucherSummaries(tenantId, travelId, client);
    const update = await applyVoucherToDailySchedule(currentState, vouchers.filter(isRelevant), newVoucher.id, tenantId);

    await saveTravelSchedule(
      tenantId,
      travelId,
      { dailySchedule: update.schedule, travelStartAt: update.travel_start_at, travelEndAt: update.travel_end_at },
      client,
    );
  });
}
