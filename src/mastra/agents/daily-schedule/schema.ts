import { z } from 'zod';
import { EVENT_CONTENT_FORMAT, EVENT_TITLE_FORMAT, EVENT_TYPE_FORMAT } from './event-format';

// De onde veio um evento do dia a dia. É o que permite o código (e não a LLM) decidir o que fica
// e o que sai quando um voucher muda: eventos de voucher são regerados/removidos pelo `voucher_id`;
// todo o resto (sugestão aprovada, evento criado no chat pelo Ori, evento criado à mão pelo app)
// nunca é tocado por uma reconstrução a partir de vouchers.
export const dailyScheduleEventSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('voucher'), voucher_id: z.string() }),
  z.object({ type: z.literal('suggestion'), suggestion_id: z.string() }),
  z.object({ type: z.literal('chat') }),
  z.object({ type: z.literal('manual') }),
]);

const eventFields = {
  title: z.string().describe(EVENT_TITLE_FORMAT),
  content: z.string().describe(`${EVENT_CONTENT_FORMAT} Use SOMENTE dados dos vouchers abertos.`),
  type: z.string().describe(`${EVENT_TYPE_FORMAT} É o voucher_type_slug do voucher de origem.`),
  observation: z
    .string()
    .nullable()
    .describe(
      'Preencha SOMENTE quando outro voucher também tocar este mesmo evento e complementar ou contradizer esta informação (cite de qual voucher vem cada dado). null quando só houver uma fonte para este evento.',
    ),
};

// Evento como fica gravado em `travel.daily_schedule`. `source` é opcional só pra ler linhas
// antigas, gravadas antes da proveniência existir (ver `schedule-merge.ts` → `eventOrigin`).
// `suggested` é legado do mesmo jeito: linhas antigas de sugestão aprovada vinham marcadas assim.
export const dailyScheduleEventSchema = z.object({
  ...eventFields,
  // Onde o evento acontece ("Urban Hive Milano, Milão"). Só eventos de voucher têm (a LLM preenche);
  // é o que diz, nos dias entre o início e o fim de uma hospedagem/aluguel, onde o cliente está
  // (`ongoingStays`, `schedule-merge.ts`). Opcional: linhas antigas e eventos do chat não têm.
  place: z.string().nullable().optional(),
  source: dailyScheduleEventSourceSchema.optional(),
  suggested: z.boolean().optional(),
});

export const dailyScheduleDaySchema = z.object({
  date: z.string().describe('YYYY-MM-DD'),
  title: z.string().describe('Frase curta resumindo o evento mais relevante deste dia.'),
  events: z.object({
    morning: z.array(dailyScheduleEventSchema).describe('Eventos entre 00:00 e 11:59.'),
    afternoon: z.array(dailyScheduleEventSchema).describe('Eventos entre 12:00 e 17:59.'),
    night: z.array(dailyScheduleEventSchema).describe('Eventos entre 18:00 e 23:59.'),
  }),
});

// Array ESPARSO — só dias com pelo menos um evento. `travel_start_at`/`travel_end_at` guardam o
// range da viagem; quem lê trata dia fora do array como dia sem evento.
export const dailyScheduleSchema = z.array(dailyScheduleDaySchema);

// O que a LLM devolve (`daily-schedule-agent.ts`): só eventos de voucher, cada um dizendo de qual
// voucher veio. A LLM nunca vê nem devolve `source`/`suggested` — o código converte `voucher_id`
// em `source` e junta com o resto do dia a dia (`schedule-merge.ts`).
const voucherEventSchema = z.object({
  ...eventFields,
  place: z
    .string()
    .nullable()
    .describe(
      'Onde o evento acontece: nome do lugar e cidade, como está no voucher (ex: "Urban Hive Milano, Milão", "Movida Aeroporto BPS, Porto Seguro"). É o que aparece nos dias entre o início e o fim de uma hospedagem ou aluguel. null se o voucher não disser.',
    ),
  voucher_id: z.string().describe('id do voucher (da lista de vouchers) de onde este evento veio.'),
});

const voucherDaySchema = z.object({
  date: z.string().describe('YYYY-MM-DD'),
  title: z.string().describe('Frase curta resumindo o evento mais relevante deste dia.'),
  events: z.object({
    morning: z.array(voucherEventSchema).describe('Eventos entre 00:00 e 11:59.'),
    afternoon: z.array(voucherEventSchema).describe('Eventos entre 12:00 e 17:59.'),
    night: z.array(voucherEventSchema).describe('Eventos entre 18:00 e 23:59.'),
  }),
});

export const voucherScheduleResultSchema = z.object({
  days: z.array(voucherDaySchema).describe('Só os dias que têm pelo menos um evento, em ordem cronológica.'),
});

export type DailyScheduleEventSource = z.infer<typeof dailyScheduleEventSourceSchema>;
export type DailyScheduleEvent = z.infer<typeof dailyScheduleEventSchema>;
export type DailyScheduleDay = z.infer<typeof dailyScheduleDaySchema>;
export type DailySchedule = z.infer<typeof dailyScheduleSchema>;
export type VoucherScheduleDay = z.infer<typeof voucherDaySchema>;
