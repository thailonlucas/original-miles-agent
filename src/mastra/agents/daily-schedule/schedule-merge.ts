import { normalizeEventContent } from './event-format';
import type { DailyScheduleDay, DailyScheduleEvent, VoucherOperation, VoucherScheduleDay } from './schema';

export type SchedulePeriod = 'morning' | 'afternoon' | 'night';

const PERIODS: readonly SchedulePeriod[] = ['morning', 'afternoon', 'night'];

// Regras de junção do dia a dia, sem LLM e sem banco (ver AGENTS.md desta pasta). Voucher novo ou
// atualizado nunca recria nem substitui um card: a LLM devolve operações ("enrich" um card que já
// existe, "create" um novo) e o código aplica (`applyVoucherOperations`). Voucher excluído só marca
// os cards dele (`markVoucherRemoved`) — quem decide se o card sai é o consultor. Refazer o dia a dia
// refaz só os cards de voucher e mantém o resto (`keptEventsOnly`, `keepEditedTitles`).

function allEvents(day: DailyScheduleDay): DailyScheduleEvent[] {
  return PERIODS.flatMap((period) => day.events[period]);
}

// Vouchers que sustentam um card hoje: o de `source` e os que o enriqueceram, menos os já excluídos.
export function eventVoucherIds(event: DailyScheduleEvent): string[] {
  const removed = new Set((event.removed_vouchers ?? []).map((r) => r.voucher_id));
  const ids = [...(event.source?.type === 'voucher' ? [event.source.voucher_id] : []), ...(event.linked_voucher_ids ?? [])];
  return [...new Set(ids)].filter((id) => !removed.has(id));
}

// Mantém só os eventos aprovados por `keep`, e tira da lista os dias que ficaram vazios (o array é
// esparso). Se o título do dia era o de um evento removido, passa a ser o do primeiro que sobrou —
// a não ser que o consultor tenha editado o título à mão (`title_edited`), que nunca muda sozinho.
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
    return [{ ...day, title: titleWasRemoved && !day.title_edited ? remaining[0].title : day.title, events }];
  });
}

// Tira do dia a dia o evento que uma sugestão aprovada virou (`source.suggestion_id`).
export function withoutSuggestion(days: DailyScheduleDay[], suggestionId: string): DailyScheduleDay[] {
  return filterEvents(days, (event) => !(event.source?.type === 'suggestion' && event.source.suggestion_id === suggestionId));
}

// O que "refazer o dia a dia" mantém: tudo que não veio de voucher (sugestão aprovada, chat, à mão).
// Linha antiga sem `source` conta como voucher (é refeita), e `suggested: true` legado como sugestão.
export function isKeptOnRebuild(event: DailyScheduleEvent): boolean {
  return event.source ? event.source.type !== 'voucher' : event.suggested === true;
}

export function keptEventsOnly(days: DailyScheduleDay[]): DailyScheduleDay[] {
  return filterEvents(days, isKeptOnRebuild);
}

// Converte a saída da LLM (modo do zero) no formato gravado: `voucher_id` vira `source`.
export function toStoredDays(llmDays: VoucherScheduleDay[]): DailyScheduleDay[] {
  const days = llmDays.map((day) => {
    const convert = ({ voucher_id, ...event }: VoucherScheduleDay['events']['morning'][number]): DailyScheduleEvent => ({
      ...event,
      content: normalizeEventContent(event.content, event.title),
      source: { type: 'voucher', voucher_id },
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
// título vale num dia que existe nos dois lados — exceto se um dos lados tiver o título editado à mão
// (`title_edited`), que sempre vence.
export function mergeDays(base: DailyScheduleDay[], incoming: DailyScheduleDay[], titleFrom: 'base' | 'incoming'): DailyScheduleDay[] {
  const byDate = new Map(base.map((day) => [day.date, day]));
  for (const day of incoming) {
    const existing = byDate.get(day.date);
    if (!existing) {
      byDate.set(day.date, day);
      continue;
    }
    const edited = existing.title_edited ? existing : day.title_edited ? day : null;
    byDate.set(day.date, {
      date: day.date,
      title: edited ? edited.title : titleFrom === 'incoming' ? day.title : existing.title,
      ...(edited ? { title_edited: true } : {}),
      events: {
        morning: [...existing.events.morning, ...day.events.morning],
        afternoon: [...existing.events.afternoon, ...day.events.afternoon],
        night: [...existing.events.night, ...day.events.night],
      },
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Devolve `next` com os títulos editados à mão (`title_edited`) de `previous` de volta, nos dias que
// continuam existindo — pro refazer do zero, em que os dias novos vêm da LLM e o dia editado pode nem
// ter um evento mantido pra carregar o título.
export function keepEditedTitles(previous: DailyScheduleDay[], next: DailyScheduleDay[]): DailyScheduleDay[] {
  const edited = new Map(previous.filter((day) => day.title_edited).map((day) => [day.date, day.title]));
  return next.map((day) => (edited.has(day.date) ? { ...day, title: edited.get(day.date)!, title_edited: true } : day));
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
      content: normalizeEventContent(s.event.content, s.event.title),
      source: { type: 'suggestion', suggestion_id: s.id },
    });
    existing.add(key);
    insertedIds.push(s.id);
  }
  return { days: result, insertedIds, duplicateIds };
}

// Aplica as operações do modo "encaixar" (`buildVoucherOperations`) de UM voucher:
// - "enrich": atualiza o card a partir dele mesmo — o texto do consultor é a base; a LLM devolve o
//   texto com o que o voucher comprova corrigido e o que ele traz de novo acrescentado (`content`
//   substitui), o título só se o voucher contradiz um dado dele. Dia e posição nunca mudam. O que o
//   voucher mudou em algo que o consultor escreveu vai em `observation` (acrescentada à que já
//   existe), e o voucher entra em `linked_voucher_ids`. Se estava marcado como "voucher excluído", a
//   marca sai: o card voltou a ter um voucher.
// - "create": card novo com `source` deste voucher, na posição pedida do período (ou no fim).
// Referência que não existe (dia/período/index errado) ou create sem título/conteúdo é ignorada e
// volta em `skipped` — nunca vira uma escrita num card errado.
export function applyVoucherOperations(
  days: DailyScheduleDay[],
  voucherId: string,
  operations: VoucherOperation[],
): { days: DailyScheduleDay[]; skipped: VoucherOperation[] } {
  const skipped: VoucherOperation[] = [];
  let result = days;

  for (const op of operations.filter((o) => o.action === 'enrich')) {
    const day = result.find((d) => d.date === op.date);
    const current = op.index === null ? undefined : day?.events[op.period][op.index];
    if (!day || !current || op.index === null) {
      skipped.push(op);
      continue;
    }
    const content = op.content?.trim();
    const title = op.title?.trim() || current.title;
    const observation = op.observation?.trim();
    const linked = current.source?.type === 'voucher' && current.source.voucher_id === voucherId ? current.linked_voucher_ids : [...new Set([...(current.linked_voucher_ids ?? []), voucherId])];
    const { removed_vouchers: _cleared, ...rest } = current;
    const enriched: DailyScheduleEvent = {
      ...rest,
      title,
      content: content ? normalizeEventContent(content, title) : current.content,
      observation: observation ? (current.observation ? `${current.observation}\n${observation}` : observation) : current.observation,
      ...(op.place ? { place: op.place } : {}),
      ...(linked?.length ? { linked_voucher_ids: linked } : {}),
    };
    const list = day.events[op.period].map((e, i) => (i === op.index ? enriched : e));
    result = result.map((d) => (d === day ? { ...d, events: { ...d.events, [op.period]: list } } : d));
  }

  // De trás pra frente dentro de cada período: inserir numa posição não desloca as posições menores,
  // então os índices pedidos (sobre o dia a dia de antes) continuam valendo.
  const creates = operations
    .map((op, order) => ({ op, order }))
    .filter(({ op }) => op.action === 'create')
    .sort((a, b) => (b.op.index ?? Infinity) - (a.op.index ?? Infinity) || b.order - a.order);
  for (const { op } of creates) {
    if (!op.title?.trim() || !op.content?.trim()) {
      skipped.push(op);
      continue;
    }
    const event: DailyScheduleEvent = {
      title: op.title.trim(),
      content: normalizeEventContent(op.content, op.title),
      type: op.type ?? 'other',
      observation: op.observation?.trim() || null,
      place: op.place,
      source: { type: 'voucher', voucher_id: voucherId },
    };
    result = insertEventIntoDays(result, op.date, op.period, event, op.index ?? undefined);
  }
  return { days: result, skipped };
}

// Voucher excluído: nenhum card sai. Todo card sustentado por ele (`source` ou `linked_voucher_ids`)
// ganha a marca em `removed_vouchers` e o voucher sai de `linked_voucher_ids` — o consultor decide
// depois se remove o card (`removeDailyScheduleEvent`) ou mantém (`keepDailyScheduleEvent`).
export function markVoucherRemoved(days: DailyScheduleDay[], voucherId: string, removedAt: string): { days: DailyScheduleDay[]; marked: number } {
  let marked = 0;
  const mark = (event: DailyScheduleEvent): DailyScheduleEvent => {
    if (!eventVoucherIds(event).includes(voucherId)) return event;
    marked += 1;
    const linked = (event.linked_voucher_ids ?? []).filter((id) => id !== voucherId);
    const { linked_voucher_ids: _previous, ...rest } = event;
    return {
      ...rest,
      ...(linked.length ? { linked_voucher_ids: linked } : {}),
      removed_vouchers: [...(event.removed_vouchers ?? []), { voucher_id: voucherId, removed_at: removedAt }],
    };
  };
  const result = days.map((day) => ({
    ...day,
    events: { morning: day.events.morning.map(mark), afternoon: day.events.afternoon.map(mark), night: day.events.night.map(mark) },
  }));
  return { days: marked ? result : days, marked };
}

// Range da viagem = primeiro e último dia com evento (o array já vem ordenado por `mergeDays`).
export function scheduleRange(days: DailyScheduleDay[]): { travelStartAt: string | null; travelEndAt: string | null } {
  return { travelStartAt: days[0]?.date ?? null, travelEndAt: days[days.length - 1]?.date ?? null };
}

// Todos os dias de `start` a `end` (YYYY-MM-DD, inclusive), em ordem.
export function datesBetween(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let d = new Date(`${start}T00:00:00Z`); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

export interface OngoingStay {
  voucherId: string;
  type: string;
  place: string;
}

// Um voo ou traslado que cai em dois dias (ex: voo noturno) não "hospeda" ninguém no meio.
const NOT_A_STAY = new Set(['flight', 'transfer']);

const STAY_LABELS: Record<string, string> = { accommodation: 'hospedado em', car_rental: 'com o carro', ferry_boat: 'a bordo de' };

export function describeStay(stay: OngoingStay): string {
  return `${STAY_LABELS[stay.type] ?? 'em andamento:'} ${stay.place}`;
}

// Nome do lugar pelo título, pra eventos gravados antes de `place` existir: "Check-in no Urban Hive
// Milano" -> "Urban Hive Milano", "Retirada do carro Movida em BPS" -> "Movida em BPS".
function placeFromTitle(title: string): string {
  return title.replace(/^(check-in|check-out|retirada|devolução|embarque|desembarque|início|fim)\s+((d|n)[oa]s?|em|de)?\s*(carro\s+)?/i, '').trim() || title;
}

// Onde o cliente está nos dias do MEIO de tudo que dura vários dias — hospedagem entre check-in e
// check-out, carro entre retirada e devolução, cruzeiro, circuito. O gerador só grava o evento de
// início e o de fim (sem repetir o voucher em cada dia); isto recupera o "estou no hotel X" desses
// dias a partir dos eventos de voucher, sem gravar nada. Chave = data; só dias estritamente entre o
// primeiro e o último evento do voucher.
export function ongoingStays(days: DailyScheduleDay[]): Map<string, OngoingStay[]> {
  const spans = new Map<string, { type: string; place: string | null; first: string; last: string }>();
  for (const day of days) {
    for (const event of allEvents(day)) {
      if (event.source?.type !== 'voucher' || NOT_A_STAY.has(event.type)) continue;
      const voucherId = event.source.voucher_id;
      const span = spans.get(voucherId);
      const place = event.place ?? span?.place ?? null;
      if (!span) spans.set(voucherId, { type: event.type, place: place ?? placeFromTitle(event.title), first: day.date, last: day.date });
      else spans.set(voucherId, { ...span, place: place ?? span.place, first: day.date < span.first ? day.date : span.first, last: day.date > span.last ? day.date : span.last });
    }
  }

  const byDate = new Map<string, OngoingStay[]>();
  for (const [voucherId, span] of spans) {
    for (const date of datesBetween(span.first, span.last).slice(1, -1)) {
      byDate.set(date, [...(byDate.get(date) ?? []), { voucherId, type: span.type, place: span.place ?? '' }]);
    }
  }
  return byDate;
}
