import {
  appendPendingSuggestions,
  getSuggestions,
  getTravelSchedule,
  getTravelSummary,
  getVoucherSummaries,
  type StoredSuggestion,
  type VoucherSummary,
} from '../../services/travel-db';
import { isRelevant } from '../daily-schedule/rebuild-daily-schedule';
import { dailyScheduleSchema, type DailyScheduleDay } from '../daily-schedule/schema';
import { regeneratePeriodSuggestions, suggestActivitiesForDay } from './schedule-suggestion-agent';
import { validateSuggestions } from './schedule-suggestion-validator';
import type { ScheduleSuggestionEvent, ScheduleSuggestionResult, SchedulePeriod } from './schema';

// Quantas vezes o loop de correção tenta regenerar sugestões rejeitadas/sinalizadas pelo validador
// antes de desistir e simplesmente descartá-las (ver `runValidationAndRepair` abaixo). 1 tentativa
// é suficiente pro caso comum (poucas sugestões ruins por chamada) sem multiplicar custo/latência
// indefinidamente se o validador continuar rejeitando o que o gerador propõe.
const MAX_REPAIR_ATTEMPTS = 1;

// Post-processor: roda o `schedule-suggestion-validator` sobre o resultado recém-gerado e, pra
// cada período com sugestão rejeitada/sinalizada, pede ao gerador (`regeneratePeriodSuggestions`)
// substitutas só pras posições problemáticas — mantendo as já aprovadas. Repete até
// `MAX_REPAIR_ATTEMPTS` vezes; se ainda sobrar algo ruim depois disso, descarta (nunca deixa passar
// pro cliente uma sugestão que o validador marcou como problema).
async function runValidationAndRepair(
  day: string,
  existingDay: DailyScheduleDay | null,
  fullSchedule: DailyScheduleDay[],
  vouchers: VoucherSummary[],
  decisionHistory: StoredSuggestion[],
  tenantId: string,
  prompt: string | null,
  summary: string | null,
  initial: ScheduleSuggestionResult,
): Promise<ScheduleSuggestionResult> {
  let current = initial;

  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const validation = await validateSuggestions(day, existingDay, fullSchedule, vouchers, decisionHistory, tenantId, prompt, summary, current);

    const isLastAttempt = attempt === MAX_REPAIR_ATTEMPTS;
    let anyBad = false;
    const next: ScheduleSuggestionResult = { ...current };

    for (const period of PERIODS as readonly SchedulePeriod[]) {
      const suggestions = current[period].suggestions;
      const verdicts = validation[period];
      const keep: ScheduleSuggestionEvent[] = [];
      const replace: { suggestion: ScheduleSuggestionEvent; reason: string }[] = [];

      suggestions.forEach((suggestion, i) => {
        const verdict = verdicts[i];
        if (!verdict || verdict.verdict === 'approved') {
          keep.push(suggestion);
        } else {
          anyBad = true;
          replace.push({ suggestion, reason: verdict.reason });
        }
      });

      if (replace.length === 0) continue;

      if (isLastAttempt) {
        // Última tentativa esgotada: descarta as que ainda estão ruins em vez de regenerar de novo.
        next[period] = { has_existing_events: current[period].has_existing_events, suggestions: keep };
      } else {
        const regenerated = await regeneratePeriodSuggestions(
          period,
          day,
          existingDay,
          fullSchedule,
          vouchers,
          decisionHistory,
          tenantId,
          prompt,
          summary,
          keep,
          replace,
        );
        next[period] = { has_existing_events: current[period].has_existing_events, suggestions: [...keep, ...regenerated] };
      }
    }

    current = next;
    if (!anyBad) break;
  }

  return current;
}

// Mesmo formato de `ScheduleSuggestionResult`, mas cada sugestão carrega o `id` com que acabou de
// ser persistida como "pending" (ver `appendPendingSuggestions`) — o frontend usa esse id pra
// aprovar/rejeitar/mover/apagar essa sugestão depois, sem precisar reenviar o objeto inteiro.
export type ScheduleSuggestionEventWithId = ScheduleSuggestionEvent & { id: string };
export interface ScheduleSuggestionResultWithIds {
  date: string;
  morning: { has_existing_events: boolean; suggestions: ScheduleSuggestionEventWithId[] };
  afternoon: { has_existing_events: boolean; suggestions: ScheduleSuggestionEventWithId[] };
  night: { has_existing_events: boolean; suggestions: ScheduleSuggestionEventWithId[] };
}

const PERIODS = ['morning', 'afternoon', 'night'] as const;

// Usado só pelo endpoint `POST /travel_agent/schedule-suggestion`. Ao contrário do fluxo antigo,
// agora GRAVA as sugestões geradas (como "pending", ver `appendPendingSuggestions`) antes de
// devolver a resposta — precisa de `userId` só por causa disso (`ensureTravelExists`). Não usa
// `withTravelScheduleLock`: não mexe em `daily_schedule`, só na coluna independente `suggestions`.
export async function suggestDayActivities(
  tenantId: string,
  travelId: string,
  userId: string,
  day: string,
  prompt: string | null = null,
  quantity = 3,
): Promise<ScheduleSuggestionResultWithIds> {
  const [scheduleState, vouchers, allSuggestions, summary] = await Promise.all([
    getTravelSchedule(tenantId, travelId),
    getVoucherSummaries(tenantId, travelId),
    getSuggestions(tenantId, travelId),
    // Resumo geral cadastrado pelo cliente (ver `routes/travel-summary-routes.ts`) — contexto que
    // complementa (ou, na ausência de `prompt`, substitui) o padrão "high ticket" fixo do prompt.
    getTravelSummary(tenantId, travelId),
  ]);

  // "Inteligência" da viagem pro prompt: só sugestões já DECIDIDAS (aprovadas/rejeitadas) carregam
  // sinal de gosto — uma "pending" ainda não diz nada sobre o que o cliente gostou ou não.
  const decisionHistory = allSuggestions.filter((s) => s.status !== 'pending');

  // `dailySchedule` é `unknown[]` (ver `TravelScheduleState`) — revalida contra o schema real antes
  // de procurar o dia, em vez de confiar cegamente no formato salvo.
  const parsedSchedule = dailyScheduleSchema.safeParse(scheduleState.dailySchedule);
  const fullSchedule: DailyScheduleDay[] = parsedSchedule.success ? parsedSchedule.data : [];
  const existingDay: DailyScheduleDay | null = fullSchedule.find((d) => d.date === day) ?? null;

  const relevantVouchers = vouchers.filter(isRelevant);

  const generated: ScheduleSuggestionResult = await suggestActivitiesForDay(
    day,
    existingDay,
    fullSchedule,
    relevantVouchers,
    decisionHistory,
    tenantId,
    prompt,
    quantity,
    summary,
  );

  // Post-processor: nunca persiste o que sai direto do gerador sem passar pelo validador (ver
  // `runValidationAndRepair`) — garante que sugestões óbvias demais (repetidas do histórico,
  // fora do nível esperado, violando restrição do cliente etc.) sejam corrigidas ou descartadas
  // antes de chegar ao cliente.
  const result = await runValidationAndRepair(day, existingDay, fullSchedule, relevantVouchers, decisionHistory, tenantId, prompt, summary, generated);

  const now = new Date().toISOString();
  const withIds: ScheduleSuggestionResultWithIds = {
    date: result.date,
    morning: { has_existing_events: result.morning.has_existing_events, suggestions: [] },
    afternoon: { has_existing_events: result.afternoon.has_existing_events, suggestions: [] },
    night: { has_existing_events: result.night.has_existing_events, suggestions: [] },
  };
  const toPersist: StoredSuggestion[] = [];
  for (const period of PERIODS as readonly SchedulePeriod[]) {
    for (const suggestion of result[period].suggestions) {
      const id = crypto.randomUUID();
      withIds[period].suggestions.push({ ...suggestion, id });
      toPersist.push({
        id,
        date: result.date,
        period,
        event: { title: suggestion.title, content: suggestion.content, type: suggestion.type, observation: suggestion.observation },
        reason: suggestion.reason,
        status: 'pending',
        feedback: null,
        createdAt: now,
        decidedAt: null,
      });
    }
  }
  await appendPendingSuggestions(tenantId, travelId, userId, toPersist);

  return withIds;
}
