import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import type { StoredSuggestion, VoucherSummary } from '../../services/travel-db';
import type { DailyScheduleDay } from '../daily-schedule/schema';
import { openVoucherTool } from '../daily-schedule/tools/open-voucher-tool';
import { buildSuggestionInstructions, buildSuggestionUserMessage, type SuggestionRepairRequest } from './prompts/system-prompt';
import {
  buildScheduleSuggestionPeriodSchema,
  buildScheduleSuggestionResultSchema,
  scheduleSuggestionResultSchema,
  type ScheduleSuggestionEvent,
  type ScheduleSuggestionPeriod,
  type ScheduleSuggestionResult,
  type SchedulePeriod,
} from './schema';

// Reaproveita a tool `openVoucher` do daily-schedule (mesmo contrato: `tenant_id` via
// requestContext, nunca passado pelo model) — este agente também precisa abrir vouchers pra
// descobrir a localização da viagem naquele dia antes de sugerir qualquer atividade.
export const scheduleSuggestionAgent = new Agent({
  id: 'schedule-suggestion',
  name: 'Schedule Suggestion',
  description:
    'Sugere atividades para um dia específico do roteiro de uma viagem — complementares a eventos já confirmados, ou opções pra um período livre — com base nos vouchers já extraídos e no daily_schedule atual.',
  instructions: 'Aguardando o dia e o contexto da viagem.',
  model: 'openai/gpt-5.6-terra',
  tools: { openVoucher: openVoucherTool },
  defaultOptions: {
    maxSteps: 40,
    structuredOutput: {
      schema: scheduleSuggestionResultSchema,
    },
  },
});

export async function suggestActivitiesForDay(
  day: string,
  existingDay: DailyScheduleDay | null,
  fullSchedule: DailyScheduleDay[],
  vouchers: VoucherSummary[],
  decisionHistory: StoredSuggestion[],
  tenantId: string,
  prompt: string | null = null,
  quantity = 3,
  summary: string | null = null,
): Promise<ScheduleSuggestionResult> {
  const { object } = await scheduleSuggestionAgent.generate(
    buildSuggestionUserMessage(day, existingDay, fullSchedule, vouchers, decisionHistory, prompt, quantity, summary),
    {
      instructions: buildSuggestionInstructions(quantity, prompt, summary),
      // Sobrescreve o `structuredOutput` fixo do `defaultOptions` (quantity=3) com um schema
      // construído pra este `quantity` — ver comentário em `schema.ts` sobre por que a descrição
      // do campo "suggestions" (não só a instrução em texto livre) precisa carregar o número real.
      structuredOutput: { schema: buildScheduleSuggestionResultSchema(quantity) },
      requestContext: new RequestContext([['tenant_id', tenantId]]),
    },
  );
  return object;
}

// Chamada de correção pontual, disparada por `suggest-day-activities.ts` quando o
// `schedule-suggestion-validator` rejeita/sinaliza alguma sugestão de UM período. Reusa o mesmo
// agente/tools (`openVoucher`) e o mesmo contexto do dia, mas restringe a saída a um único período
// (`buildScheduleSuggestionPeriodSchema`, não o dia inteiro) e embute no prompt do usuário quais
// sugestões manter e quais substituir (ver `formatRepairSection` em `prompts/system-prompt.ts`).
export async function regeneratePeriodSuggestions(
  period: SchedulePeriod,
  day: string,
  existingDay: DailyScheduleDay | null,
  fullSchedule: DailyScheduleDay[],
  vouchers: VoucherSummary[],
  decisionHistory: StoredSuggestion[],
  tenantId: string,
  prompt: string | null,
  summary: string | null,
  keep: ScheduleSuggestionEvent[],
  replace: { suggestion: ScheduleSuggestionEvent; reason: string }[],
): Promise<ScheduleSuggestionEvent[]> {
  if (replace.length === 0) return [];

  const repair: SuggestionRepairRequest = { period, keep, replace };
  // "quantity" aqui é só o número de substitutas pedidas (não o `quantity` original da chamada) —
  // é o que define o "exatamente N sugestões" na descrição do schema pro período (ver `schema.ts`).
  const { object } = await scheduleSuggestionAgent.generate(
    buildSuggestionUserMessage(day, existingDay, fullSchedule, vouchers, decisionHistory, prompt, replace.length, summary, repair),
    {
      instructions: buildSuggestionInstructions(replace.length, prompt, summary),
      structuredOutput: { schema: buildScheduleSuggestionPeriodSchema(replace.length) },
      requestContext: new RequestContext([['tenant_id', tenantId]]),
    },
  );
  const result = object as ScheduleSuggestionPeriod;
  return result.suggestions;
}
