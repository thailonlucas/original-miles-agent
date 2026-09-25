import { normalizeEventContent } from './event-format';
import type { DailyScheduleDay, DailyScheduleEvent, VoucherScheduleDay } from './schema';

export type SchedulePeriod = 'morning' | 'afternoon' | 'night';

const PERIODS: readonly SchedulePeriod[] = ['morning', 'afternoon', 'night'];

// Regras de junção do dia a dia, sem LLM e sem banco: a LLM só gera eventos de voucher, e é aqui
// que se decide o que fica e o que sai quando um voucher muda (ver AGENTS.md desta pasta).
//
// - "voucher": veio de um voucher conhecido — é regerado/removido junto com ele.
// - "kept": sugestão aprovada, evento criado no chat ou à mão — nenhuma reconstrução a partir de
//   vouchers toca.
// - "untagged": linha antiga, de antes da proveniência existir — veio de voucher, mas não diz de
//   qual. Quando aparece, a viagem é reconstruída uma vez do zero e passa a ser toda "voucher"/"kept".
type EventOrigin = { kind: 'voucher'; voucherId: string } | { kind: 'kept' } | { kind: 'untagged' };

export function eventOrigin(event: DailyScheduleEvent): EventOrigin {
  if (event.source?.type === 'voucher') return { kind: 'voucher', voucherId: event.source.voucher_id };
  if (event.source || event.suggested) return { kind: 'kept' };
  return { kind: 'untagged' };
}

function allEvents(day: DailyScheduleDay): DailyScheduleEvent[] {
  return PERIODS.flatMap((period) => day.events[period]);
}

export function hasUntaggedEvents(days: DailyScheduleDay[]): boolean {
  return days.some((day) => allEvents(day).some((event) => eventOrigin(event).kind === 'untagged'));
}

// Mantém só os eventos aprovados por `keep`, e tira da lista os dias que ficaram vazios (o array é
// esparso). Se o título do dia era o de um evento removido, passa a ser o do primeiro que sobrou.
function filterEvents(days: DailyScheduleDay[], keep: (event: DailyScheduleEvent) => boolean): DailyScheduleDay[] {
  return days.flatMap((day) => {
    const events = {
      morning: day.events.morning.filter(keep),
      afternoon: day.events.afternoon.filter(keep),
      night: day.events.night.filter(keep),
    };
    const remaining = [...events.morning, ...events.afternoon, ...events.night];
    if (remaining.length === 0) return [];

    const titleWasRemoved = allEvents(day).some((event) => !keep(event) && event.title === day.title);
    return [{ ...day, title: titleWasRemoved ? remaining[0].title : day.title, events }];
  });
}

export function withoutVoucher(days: DailyScheduleDay[], voucherId: string): DailyScheduleDay[] {
  return filterEvents(days, (event) => {
    const origin = eventOrigin(event);
    return !(origin.kind === 'voucher' && origin.voucherId === voucherId);
  });
}

// Tira do dia a dia o evento que uma sugestão aprovada virou (`source.suggestion_id`).
export function withoutSuggestion(days: DailyScheduleDay[], suggestionId: string): DailyScheduleDay[] {
  return filterEvents(days, (event) => !(event.source?.type === 'suggestion' && event.source.suggestion_id === suggestionId));
}

export function keptEventsOnly(days: DailyScheduleDay[]): DailyScheduleDay[] {
  return filterEvents(days, (event) => eventOrigin(event).kind === 'kept');
}

// Converte a saída da LLM no formato gravado: `voucher_id` vira `source`. `forcedVoucherId` é pra
// quando a chamada foi sobre UM voucher só — o código já sabe a origem, não depende da LLM acertar.
export function toStoredDays(llmDays: VoucherScheduleDay[], forcedVoucherId?: string): DailyScheduleDay[] {
  const days = llmDays.map((day) => {
    const convert = ({ voucher_id, ...event }: VoucherScheduleDay['events']['morning'][number]): DailyScheduleEvent => ({
      ...event,
      content: normalizeEventContent(event.content),
      source: { type: 'voucher', voucher_id: forcedVoucherId ?? voucher_id },
    });
    return {
      date: day.date,
      title: day.title,
      events: { morning: day.events.morning.map(convert), afternoon: day.events.afternoon.map(convert), night: day.events.night.map(convert) },
    };
  });
  return days.filter((day) => allEvents(day).length > 0);
}

// Junta `incoming` em `base`, dia a dia (eventos entram no fim do período). `titleFrom` decide qual
// título vale num dia que existe nos dois lados.
export function mergeDays(base: DailyScheduleDay[], incoming: DailyScheduleDay[], titleFrom: 'base' | 'incoming'): DailyScheduleDay[] {
  const byDate = new Map(base.map((day) => [day.date, day]));
  for (const day of incoming) {
    const existing = byDate.get(day.date);
    if (!existing) {
      byDate.set(day.date, day);
      continue;
    }
    byDate.set(day.date, {
      date: day.date,
      title: titleFrom === 'incoming' ? day.title : existing.title,
      events: {
        morning: [...existing.events.morning, ...day.events.morning],
        afternoon: [...existing.events.afternoon, ...day.events.afternoon],
        night: [...existing.events.night, ...day.events.night],
      },
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Insere UM evento num dia/período, criando o dia (na posição certa por data) se ele ainda não
// tiver nenhum evento. Usado pelas escritas pontuais (sugestão aprovada, move do drag-and-drop).
// `position` (0-based) coloca o evento num ponto específico do período — é a ordem cronológica dentro
// da manhã/tarde/noite, já que eventos não têm horário estruturado. Sem `position`, vai pro fim.
export function insertEventIntoDays(
  days: DailyScheduleDay[],
  date: string,
  period: SchedulePeriod,
  event: DailyScheduleEvent,
  position?: number,
): DailyScheduleDay[] {
  const day = days.find((d) => d.date === date);
  if (day && position !== undefined) {
    const list = [...day.events[period]];
    list.splice(Math.max(0, Math.min(position, list.length)), 0, event);
    return days.map((d) => (d === day ? { ...d, events: { ...d.events, [period]: list } } : d));
  }
  const newDay: DailyScheduleDay = { date, title: event.title, events: { morning: [], afternoon: [], night: [], [period]: [event] } };
  return mergeDays(days, [newDay], 'base');
}

interface ApprovedSuggestionLike {
  id: string;
  date: string;
  period: SchedulePeriod;
  status: string;
  event: { title: string; content: string; type: string; observation: string | null };
  decidedAt: string | null;
  createdAt: string;
}

// Coloca no dia a dia as sugestões aprovadas que ainda não viraram evento (aprovadas antes de
// aprovar passar a inserir o evento). Uma aprovada que repete um evento que já existe no mesmo
// dia/período (mesmo título) não entra de novo — volta em `duplicateIds` pra quem chama decidir.
// Ordem de inserção = ordem em que foram aprovadas.
export function addApprovedSuggestions(
  days: DailyScheduleDay[],
  suggestions: ApprovedSuggestionLike[],
): { days: DailyScheduleDay[]; insertedIds: string[]; duplicateIds: string[] } {
  const slotKey = (date: string, period: string, title: string) => `${date}|${period}|${title.trim().toLowerCase()}`;
  const inSchedule = new Set<string>();
  const existing = new Set<string>();
  for (const day of days) {
    for (const period of PERIODS) {
      for (const event of day.events[period]) {
        if (event.source?.type === 'suggestion') inSchedule.add(event.source.suggestion_id);
        existing.add(slotKey(day.date, period, event.title));
      }
    }
  }

  const pending = suggestions
    .filter((s) => s.status === 'approved' && !inSchedule.has(s.id))
    .sort((a, b) => (a.decidedAt ?? a.createdAt).localeCompare(b.decidedAt ?? b.createdAt));

  let result = days;
  const insertedIds: string[] = [];
  const duplicateIds: string[] = [];
  for (const s of pending) {
    const key = slotKey(s.date, s.period, s.event.title);
    if (existing.has(key)) {
      duplicateIds.push(s.id);
      continue;
    }
    result = insertEventIntoDays(result, s.date, s.period, {
      ...s.event,
      content: normalizeEventContent(s.event.content),
      source: { type: 'suggestion', suggestion_id: s.id },
    });
    existing.add(key);
    insertedIds.push(s.id);
  }
  return { days: result, insertedIds, duplicateIds };
}

// Range da viagem = primeiro e último dia com evento (o array já vem ordenado por `mergeDays`).
export function scheduleRange(days: DailyScheduleDay[]): { travelStartAt: string | null; travelEndAt: string | null } {
  return { travelStartAt: days[0]?.date ?? null, travelEndAt: days[days.length - 1]?.date ?? null };
}
