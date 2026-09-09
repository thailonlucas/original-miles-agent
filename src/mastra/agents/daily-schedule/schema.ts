import { z } from 'zod';

export const dailyScheduleEventSchema = z.object({
  title: z.string().describe("Título curto do evento (ex: 'Voo LA 3318 GRU -> FOR')."),
  content: z
    .string()
    .describe(
      'Markdown com tudo relacionado a este evento neste horário: horários, localizador, endereço, contatos relevantes. Usar SOMENTE dados dos vouchers fornecidos — nunca inventar informação ausente.',
    ),
  type: z
    .string()
    .describe(
      'voucher_type_slug de origem deste evento (ex: flight, accommodation, transfer, restaurant_reservation, car_rental, ferry_boat, experience, other).',
    ),
  observation: z
    .string()
    .nullable()
    .describe(
      'Preencha SOMENTE quando outro voucher também tocar este mesmo evento e complementar ou contradizer esta informação (cite de qual voucher vem cada dado). null quando só houver uma fonte para este evento.',
    ),
  // Legado: `POST /travel_agent/schedule-suggestion/decision` chegou a inserir o evento aprovado
  // direto aqui com `suggested: true` (ver `apply-suggestion-decision.ts`) — isso foi removido
  // porque misturava "o cliente gostou da sugestão" com "isso é um evento confirmado do roteiro"
  // sem nenhum voucher por trás. Uma sugestão aprovada agora só fica em `travel.suggestions` (ver
  // `services/travel-db.ts` -> `getSuggestions`), nunca em `daily_schedule`. O campo continua aqui
  // só pra não quebrar `dailyScheduleSchema.parse` de linhas antigas que já têm `suggested: true`
  // gravado — nunca defina como true por conta própria daqui pra frente.
  suggested: z
    .boolean()
    .optional()
    .describe(
      'Legado — não defina como true. Eventos do roteiro vêm só de vouchers; uma sugestão aprovada não vira evento aqui (ver `travel.suggestions`).',
    ),
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

// Array ESPARSO — só dias com pelo menos um evento (ver AGENTS.md: dias vazios não são mais
// armazenados, `travel_start_at`/`travel_end_at` bastam pra saber quais dias existem sem evento).
export const dailyScheduleSchema = z.array(dailyScheduleDaySchema);

// Saída de toda chamada ao agente (rebuild completo ou update incremental): o array de dias com
// evento + o range da viagem, que pode se expandir a cada novo voucher (ex: um voo mais cedo do
// que qualquer coisa já vista empurra `travel_start_at` pra trás).
export const dailyScheduleUpdateSchema = z.object({
  schedule: dailyScheduleSchema,
  travel_start_at: z.string().nullable().describe('YYYY-MM-DD — primeiro dia da viagem, ou null se não houver nenhuma data conhecida ainda.'),
  travel_end_at: z.string().nullable().describe('YYYY-MM-DD — último dia da viagem, ou null se não houver nenhuma data conhecida ainda.'),
});

// Saída do endpoint `POST /travel_agent/daily-schedule` (geração do zero, ver
// `generate-daily-schedule.ts`) — diferente de `dailyScheduleUpdateSchema` porque esse endpoint
// devolve um envelope de chat (response + docs analisados), não o roteiro estruturado direto. O
// roteiro em si vem serializado como JSON dentro de `response` (mesmo formato de
// `dailyScheduleSchema`, mas DENSO: um item por dia entre o primeiro e o último da viagem, mesmo
// sem evento — ver `prompts/system-prompt.ts` → `buildGenerateInstructions`).
export const dailyScheduleGenerateResultSchema = z.object({
  response: z
    .string()
    .describe(
      'Resposta gerada: o array de dias do roteiro (um item por dia entre o primeiro e o último dia do itinerário), serializado como texto JSON.',
    ),
  analysed_doc_ids: z.array(z.string()).describe('Lista com os ids dos documentos (vouchers) analisados (abertos pela tool) para montar o roteiro.'),
});

export type DailyScheduleEvent = z.infer<typeof dailyScheduleEventSchema>;
export type DailyScheduleDay = z.infer<typeof dailyScheduleDaySchema>;
export type DailySchedule = z.infer<typeof dailyScheduleSchema>;
export type DailyScheduleUpdate = z.infer<typeof dailyScheduleUpdateSchema>;
export type DailyScheduleGenerateResult = z.infer<typeof dailyScheduleGenerateResultSchema>;
