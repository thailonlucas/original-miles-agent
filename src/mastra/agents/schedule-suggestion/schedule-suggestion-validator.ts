import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import type { StoredSuggestion, VoucherSummary } from '../../services/travel-db';
import type { DailyScheduleDay } from '../daily-schedule/schema';
import { buildValidationInstructions, buildValidationUserMessage } from './prompts/validation-prompt';
import { scheduleSuggestionValidationSchema, type ScheduleSuggestionResult, type ScheduleSuggestionValidation } from './schema';

// Post-processor do `schedule-suggestion-agent`: não gera sugestões, só audita as que já foram
// geradas (ver `prompts/validation-prompt.ts` pras regras checadas) antes de irem pro cliente. Sem
// tools — recebe o mesmo contexto (vouchers, histórico, resumo) já pronto no prompt, não precisa
// abrir voucher de novo. Modelo mais leve que o gerador porque a tarefa é comparação/classificação,
// não exploração.
export const scheduleSuggestionValidatorAgent = new Agent({
  id: 'schedule-suggestion-validator',
  name: 'Schedule Suggestion Validator',
  description:
    'Audita as sugestões geradas pelo Schedule Suggestion antes de irem ao cliente, comparando com as regras de negócio (repetição de histórico, restrições do pedido, nível/estilo, sobreposição com eventos confirmados etc.).',
  instructions: buildValidationInstructions(),
  model: 'openai/gpt-4.1-mini',
  defaultOptions: {
    structuredOutput: {
      schema: scheduleSuggestionValidationSchema,
    },
  },
});

export async function validateSuggestions(
  day: string,
  existingDay: DailyScheduleDay | null,
  fullSchedule: DailyScheduleDay[],
  vouchers: VoucherSummary[],
  decisionHistory: StoredSuggestion[],
  tenantId: string,
  prompt: string | null,
  summary: string | null,
  generated: ScheduleSuggestionResult,
): Promise<ScheduleSuggestionValidation> {
  const { object } = await scheduleSuggestionValidatorAgent.generate(
    buildValidationUserMessage(day, existingDay, fullSchedule, vouchers, decisionHistory, prompt, summary, generated),
    { requestContext: new RequestContext([['tenant_id', tenantId]]) },
  );
  return object;
}
