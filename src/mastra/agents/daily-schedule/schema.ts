import { z } from 'zod';
import { EVENT_CONTENT_FORMAT, EVENT_SOURCE_VOUCHER, EVENT_TITLE_FORMAT, EVENT_TYPE_FORMAT } from './event-format';

// De onde veio (quem criou) um evento do dia a dia. Voucher novo/atualizado nunca recria nem
// substitui um card — só enriquece o que já existe ou cria um card novo (ver AGENTS.md desta pasta);
// só "refazer o dia a dia" (`generateDailySchedule`) começa do zero.
export const dailyScheduleEventSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('voucher'), voucher_id: z.string() }),
  z.object({ type: z.literal('suggestion'), suggestion_id: z.string() }),
  z.object({ type: z.literal('chat') }),
  z.object({ type: z.literal('manual') }),
]);

const eventFields = {
  title: z.string().describe(EVENT_TITLE_FORMAT),
  content: z.string().describe(EVENT_CONTENT_FORMAT),
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
  // Vouchers que enriqueceram este card depois de criado (ex: a reserva de um restaurante que já era
  // sugestão aprovada). O voucher de `source` não entra aqui. Só no formato gravado.
  linked_voucher_ids: z.array(z.string()).optional(),
  // Vouchers deste card (de `source` ou de `linked_voucher_ids`) que foram excluídos. O card não sai
  // sozinho: fica marcado até o consultor decidir remover ou manter (`keepDailyScheduleEvent`).
  removed_vouchers: z.array(z.object({ voucher_id: z.string(), removed_at: z.string() })).optional(),
});

export const dailyScheduleDaySchema = z.object({
  date: z.string().describe('YYYY-MM-DD'),
  title: z.string().describe('Frase curta resumindo o evento mais relevante deste dia.'),
  // `true` quando o consultor editou o título do dia à mão (`updateDailyScheduleDayTitle`, kanban do
  // front) — daí em diante nenhuma junção/reconstrução troca esse título (`schedule-merge.ts`). Só no
  // formato gravado; a LLM nunca vê nem devolve.
  title_edited: z.boolean().optional(),
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
  content: z.string().describe(`${EVENT_CONTENT_FORMAT} ${EVENT_SOURCE_VOUCHER}`),
  place: z
    .string()
    .nullable()
    .describe(
      'Onde o evento acontece: nome do lugar e cidade, como está no voucher (ex: "Urban Hive Milano, Milão", "Movida Aeroporto BPS, Porto Seguro"). É o que aparece nos dias entre o início e o fim de uma hospedagem ou aluguel. null se o voucher não disser.',
    ),
  voucher_id: z.string().describe('id do voucher (da lista de vouchers) de onde este evento veio.'),
});

// Data que a LLM devolve: formato YYYY-MM-DD e um dia que existe no calendário (nada de "2026-02-30"
// ou "2026-10-05T10:00"). Só na saída da LLM — no formato gravado uma data ruim numa linha antiga faria
// `readScheduleDays` tratar o dia a dia inteiro como vazio.
const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const llmDateSchema = z
  .string()
  .regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD')
  .refine((date) => {
    const parsed = new Date(`${date}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  }, 'data inexistente no calendário')
  .describe('YYYY-MM-DD');

const voucherDaySchema = z.object({
  date: llmDateSchema,
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

// Modo "encaixar" (voucher criado ou atualizado, `buildVoucherOperations`): a LLM não devolve dias,
// devolve operações sobre o dia a dia atual. Objeto plano, campos null quando não se aplicam — o
// código valida cada referência (`applyVoucherOperations`, `schedule-merge.ts`).
const voucherOperationSchema = z.object({
  action: z
    .enum(['enrich', 'create'])
    .describe('"enrich": completa um card que já existe (o mesmo compromisso). "create": card novo, quando não existe card desse compromisso.'),
  date: llmDateSchema.describe('enrich: data do card existente. create: data do card novo.'),
  period: z.enum(['morning', 'afternoon', 'night']).describe('enrich: período do card existente. create: período do card novo.'),
  index: z
    .number()
    .int()
    .min(0)
    .nullable()
    .describe('enrich: index do card existente no período. create: posição em que o card novo entra no período (0 = primeiro), pela ordem cronológica; null = no fim.'),
  title: z
    .string()
    .nullable()
    .describe(`create: ${EVENT_TITLE_FORMAT} enrich: o título do card com a correção, SÓ se ele tiver um dado que o voucher contradiz (ex: horário no título); senão null (mantém).`),
  content: z
    .string()
    .nullable()
    .describe(
      `create: ${EVENT_CONTENT_FORMAT} ${EVENT_SOURCE_VOUCHER} enrich: o texto do card atualizado, partindo do texto ATUAL dele: mantenha tudo que o consultor escreveu, troque só o que o voucher comprova diferente ou que estava pendente ("a confirmar" → "16h") e acrescente o que o voucher traz de novo, no mesmo formato. Substitui o texto do card. null se nada muda.`,
    ),
  type: z.string().nullable().describe(`create: ${EVENT_TYPE_FORMAT} É o voucher_type_slug do voucher. enrich: null.`),
  place: z.string().nullable().describe('Onde acontece (lugar e cidade), como está no voucher. enrich: só se o card não tiver "place" ou o voucher disser outro lugar. null se não muda.'),
  observation: z
    .string()
    .nullable()
    .describe(
      'O que o voucher mudou num dado que o consultor tinha escrito, com o valor antigo (ex: "Horário atualizado pelo voucher Nobu: 20h → 13h"), ou um ponto de atenção (card parecido em outra data). Não registre o que só estava pendente ("a confirmar" → 16h) nem o que é novo. Cite o voucher. O código acrescenta à observação que o card já tem. null se não houver.',
    ),
});

export const voucherOperationsResultSchema = z.object({
  operations: z.array(voucherOperationSchema).describe('Uma operação por compromisso do voucher. Vazio se o voucher não gerar evento.'),
});

export type DailyScheduleEventSource = z.infer<typeof dailyScheduleEventSourceSchema>;
export type DailyScheduleEvent = z.infer<typeof dailyScheduleEventSchema>;
export type DailyScheduleDay = z.infer<typeof dailyScheduleDaySchema>;
export type DailySchedule = z.infer<typeof dailyScheduleSchema>;
export type VoucherScheduleDay = z.infer<typeof voucherDaySchema>;
export type VoucherOperation = z.infer<typeof voucherOperationSchema>;
