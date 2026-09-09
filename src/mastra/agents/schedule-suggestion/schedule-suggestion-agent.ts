import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import type { StoredSuggestion, VoucherSummary } from '../../services/travel-db';
import type { DailyScheduleDay } from '../daily-schedule/schema';
import { openVoucherTool } from '../daily-schedule/tools/open-voucher-tool';
import { buildSuggestionInstructions, buildSuggestionUserMessage } from './prompts/system-prompt';
import { scheduleSuggestionResultSchema, type ScheduleSuggestionResult } from './schema';

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
      requestContext: new RequestContext([['tenant_id', tenantId]]),
    },
  );
  return object;
}
