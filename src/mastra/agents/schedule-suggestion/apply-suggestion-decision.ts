import {
  appendApprovedSuggestion,
  getTravelSchedule,
  saveTravelSchedule,
  withTravelScheduleLock,
  type ScheduleSuggestionDecision,
} from '../../services/travel-db';
import { dailyScheduleSchema, type DailyScheduleDay, type DailyScheduleEvent } from '../daily-schedule/schema';
import type { SchedulePeriod } from './schema';

export interface SuggestionDecisionInput {
  day: string; // YYYY-MM-DD
  period: SchedulePeriod;
  event: { title: string; content: string; type: string; observation: string | null };
  reason: string | null;
  status: 'approved' | 'rejected';
}

function emptyEvents(): DailyScheduleDay['events'] {
  return { morning: [], afternoon: [], night: [] };
}

// Aplica a decisão do cliente sobre UMA sugestão do agente `schedule-suggestion`:
// 1. Loga a decisão (aprovada OU rejeitada) em `travel.approved_suggestions` — histórico usado
//    como "inteligência" da viagem pras próximas chamadas de sugestão (ver
//    `suggest-day-activities.ts` -> `getApprovedSuggestions`).
// 2. Só se aprovada: insere o evento no `daily_schedule`, no dia/período indicado, com
//    `suggested: true` (ver `daily-schedule/schema.ts` -> `dailyScheduleEventSchema.suggested`) —
//    cria o dia se ele ainda não existir no roteiro (dia até então livre).
//
// Mesmo lock de `daily_schedule` das outras escritas (`rebuild-daily-schedule.ts`,
// `generate-daily-schedule.ts`) — evita pisar num rebuild/update incremental disparado ao mesmo
// tempo por um voucher novo.
//
// Limitação conhecida: um rebuild completo (`rebuildDailySchedule`/`generateDailySchedule`, hoje
// só disparado após excluir um voucher ou pelo endpoint `POST /travel_agent/daily-schedule`)
// reconstrói o roteiro do zero A PARTIR SÓ DOS VOUCHERS — eventos de sugestão aprovada (que não
// vêm de voucher nenhum) não sobrevivem a um rebuild. Fora do escopo deste endpoint corrigir.
export async function applySuggestionDecision(
  tenantId: string,
  travelId: string,
  input: SuggestionDecisionInput,
  userId: string,
): Promise<void> {
  await withTravelScheduleLock(tenantId, travelId, userId, async (client) => {
    const decision: ScheduleSuggestionDecision = {
      date: input.day,
      period: input.period,
      event: input.event,
      reason: input.reason,
      status: input.status,
      decidedAt: new Date().toISOString(),
    };
    await appendApprovedSuggestion(tenantId, travelId, decision, client);

    if (input.status !== 'approved') return;

    const current = await getTravelSchedule(tenantId, travelId, client);
    const parsed = dailyScheduleSchema.safeParse(current.dailySchedule);
    const days: DailyScheduleDay[] = parsed.success ? [...parsed.data] : [];

    const newEvent: DailyScheduleEvent = { ...input.event, suggested: true };
    const existingIndex = days.findIndex((d) => d.date === input.day);
    if (existingIndex >= 0) {
      const existingDay = days[existingIndex];
      days[existingIndex] = {
        ...existingDay,
        events: { ...existingDay.events, [input.period]: [...existingDay.events[input.period], newEvent] },
      };
    } else {
      days.push({ date: input.day, title: input.event.title, events: { ...emptyEvents(), [input.period]: [newEvent] } });
    }
    days.sort((a, b) => a.date.localeCompare(b.date));

    const travelStartAt = !current.travelStartAt || input.day < current.travelStartAt ? input.day : current.travelStartAt;
    const travelEndAt = !current.travelEndAt || input.day > current.travelEndAt ? input.day : current.travelEndAt;

    await saveTravelSchedule(tenantId, travelId, { dailySchedule: days, travelStartAt, travelEndAt }, client);
  });
}
