import { z } from 'zod';

// Mesmo formato de um evento do daily_schedule (ver `agents/daily-schedule/schema.ts` ->
// `dailyScheduleEventSchema`) + "reason", que existe só pra ajudar o usuário a decidir se aprova a
// sugestão — ao aprovar, `title`/`content`/`type`/`observation` são gravados exatamente como um
// evento novo no dia (a UI descarta "reason" nesse momento).
export const scheduleSuggestionEventSchema = z.object({
  title: z.string().describe("Título curto da atividade sugerida (ex: 'Museu do Louvre')."),
  content: z
    .string()
    .describe(
      'Markdown com os detalhes da atividade sugerida (o que é, região/endereço aproximado, duração estimada). Mesmo padrão de conteúdo ' +
        'de um evento normal do roteiro — ao ser aprovada, esta sugestão é gravada exatamente como um evento novo do dia.',
    ),
  type: z
    .string()
    .describe(
      'Categoria da sugestão, mesma convenção do `type` usado nos eventos do daily_schedule (ex: experience, restaurant_reservation, other).',
    ),
  observation: z
    .string()
    .nullable()
    .describe('Mesmo campo usado nos eventos do roteiro — normalmente null pra uma sugestão nova, a menos que ela conflite com algo já confirmado.'),
  reason: z
    .string()
    .describe(
      'Por que esta sugestão faz sentido para este dia/período: proximidade geográfica com um evento já confirmado, sequência lógica de ' +
        'horário, período livre etc. Não é gravado no roteiro final — é só contexto para o usuário decidir se aprova.',
    ),
});

// A descrição de "suggestions" carrega a `quantity` de verdade pedida nesta chamada — o schema é
// enviado ao model como JSON Schema (via `structuredOutput`) e pesa mais que só a instrução em
// texto livre. Com uma descrição estática ("normalmente 3"), o model tendia a ignorar `quantity`
// e sempre devolver ~3 sugestões por período livre, mesmo quando o cliente pedia mais/menos (ver
// `quantity` em `routes/schedule-suggestion-routes.ts`). Por isso o schema é construído por
// chamada em `suggestActivitiesForDay` (mesmo padrão de `structuredOutput` por chamada de
// `daily-schedule-agent.ts`), em vez de fixo no `defaultOptions` do agente.
function buildScheduleSuggestionPeriodSchema(quantity: number) {
  return z.object({
    has_existing_events: z.boolean().describe('true se este período (manhã/tarde/noite) já tem pelo menos um evento confirmado no roteiro atual.'),
    suggestions: z
      .array(scheduleSuggestionEventSchema)
      .describe(
        'Sugestões para este período: complementares (poucas, só o que agregar de verdade) se já houver evento confirmado, ou ' +
          `exatamente ${quantity} ${quantity === 1 ? 'opção' : 'opções'} se o período estiver livre.`,
      ),
  });
}

export function buildScheduleSuggestionResultSchema(quantity: number) {
  const periodSchema = buildScheduleSuggestionPeriodSchema(quantity);
  return z.object({
    date: z.string().describe('YYYY-MM-DD — dia consultado.'),
    morning: periodSchema.describe('Sugestões para o período entre 00:00 e 11:59.'),
    afternoon: periodSchema.describe('Sugestões para o período entre 12:00 e 17:59.'),
    night: periodSchema.describe('Sugestões para o período entre 18:00 e 23:59.'),
  });
}

// Schemas "padrão" (quantity=3) — só pra inferência de tipo (`ScheduleSuggestionResult`/
// `ScheduleSuggestionPeriod`) e pro `defaultOptions` do agente (ver `schedule-suggestion-agent.ts`);
// toda chamada real via `suggestActivitiesForDay` sobrescreve com
// `buildScheduleSuggestionResultSchema(quantity)`.
export const scheduleSuggestionPeriodSchema = buildScheduleSuggestionPeriodSchema(3);
export const scheduleSuggestionResultSchema = buildScheduleSuggestionResultSchema(3);

// Período do dia de uma sugestão — mesmas três chaves de `scheduleSuggestionResultSchema`/
// `dailyScheduleDaySchema.events`. Usado pelo endpoint de aprovação/rejeição (ver
// `routes/schedule-suggestion-decision-routes.ts`) pra saber em qual array de `events` a sugestão
// aprovada entra.
export const schedulePeriodSchema = z.enum(['morning', 'afternoon', 'night']);

export type ScheduleSuggestionEvent = z.infer<typeof scheduleSuggestionEventSchema>;
export type ScheduleSuggestionPeriod = z.infer<typeof scheduleSuggestionPeriodSchema>;
export type ScheduleSuggestionResult = z.infer<typeof scheduleSuggestionResultSchema>;
export type SchedulePeriod = z.infer<typeof schedulePeriodSchema>;
