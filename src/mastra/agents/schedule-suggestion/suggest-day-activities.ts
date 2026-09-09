import {
  appendPendingSuggestions,
  getSuggestions,
  getTravelSchedule,
  getTravelSummary,
  getVoucherSummaries,
  type StoredSuggestion,
} from '../../services/travel-db';
import { isRelevant } from '../daily-schedule/rebuild-daily-schedule';
import { dailyScheduleSchema, type DailyScheduleDay } from '../daily-schedule/schema';
import { suggestActivitiesForDay } from './schedule-suggestion-agent';
import type { ScheduleSuggestionEvent, ScheduleSuggestionResult, SchedulePeriod } from './schema';

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

  const result: ScheduleSuggestionResult = await suggestActivitiesForDay(
    day,
    existingDay,
    fullSchedule,
    vouchers.filter(isRelevant),
    decisionHistory,
    tenantId,
    prompt,
    quantity,
    summary,
  );

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
