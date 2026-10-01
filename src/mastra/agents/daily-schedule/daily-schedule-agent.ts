import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import type { VoucherSummary } from '../../services/travel-db';
import {
  buildFromScratchInstructions,
  buildFromScratchUserMessage,
  buildVoucherOperationsInstructions,
  buildVoucherOperationsUserMessage,
} from './prompts/system-prompt';
import { toStoredDays } from './schedule-merge';
import { voucherOperationsResultSchema, voucherScheduleResultSchema, type DailyScheduleDay, type VoucherOperation } from './schema';
import { openVoucherTool } from './tools/open-voucher-tool';

// Só lê vouchers e propõe: os eventos do zero (`buildVoucherSchedule`) ou as operações pra encaixar
// um voucher (`buildVoucherOperations`). Aplicar, marcar voucher excluído e calcular o range da viagem
// é trabalho do código (`schedule-merge.ts`, `rebuild-daily-schedule.ts`), não da LLM.
export const dailyScheduleAgent = new Agent({
  id: 'daily-schedule',
  name: 'Daily Schedule',
  description: 'Gera os eventos do dia a dia de uma viagem (manhã/tarde/noite) a partir dos vouchers já extraídos.',
  instructions: 'Aguardando a lista de vouchers da viagem.',
  model: 'openai/gpt-5.6-terra',
  tools: { openVoucher: openVoucherTool },
  defaultOptions: {
    // Cada voucher relevante pode custar 1 chamada de "openVoucher", e ainda sobra passo pra
    // escrever a saída — com o default do Mastra, viagens com >~10 vouchers ficavam incompletas.
    maxSteps: 40,
    structuredOutput: { schema: voucherScheduleResultSchema },
  },
});

// Ids que o agente de fato abriu, lidos das tool calls — não pedidos à LLM (que poderia listar um
// id que não abriu).
function openedVoucherIds(toolCalls: { payload: { toolName: string; args?: unknown } }[]): string[] {
  const ids = toolCalls
    .filter((call) => call.payload.toolName === openVoucherTool.id)
    .map((call) => (call.payload.args as { voucherId?: unknown } | undefined)?.voucherId)
    .filter((id): id is string => typeof id === 'string');
  return [...new Set(ids)];
}

// `keptDays`: os cards que o refazer mantém (não vieram de voucher) — só contexto, pra LLM não criar
// de novo um compromisso que um deles já cobre.
export async function buildVoucherSchedule(
  vouchers: VoucherSummary[],
  keptDays: DailyScheduleDay[],
  tenantId: string,
  summary: string | null,
  cardPreferences: string[],
): Promise<{ days: DailyScheduleDay[]; openedVoucherIds: string[] }> {
  const { object, toolCalls } = await dailyScheduleAgent.generate(buildFromScratchUserMessage(vouchers, keptDays, summary), {
    instructions: buildFromScratchInstructions(cardPreferences),
    requestContext: new RequestContext([['tenant_id', tenantId]]),
  });
  return { days: toStoredDays(object.days), openedVoucherIds: openedVoucherIds(toolCalls) };
}

// Voucher criado ou atualizado: operações sobre o dia a dia atual (enriquecer um card ou criar um),
// nunca dias inteiros. `structuredOutput` por chamada porque o default do agente é o formato do zero.
export async function buildVoucherOperations(
  voucherId: string,
  currentDays: DailyScheduleDay[],
  vouchers: VoucherSummary[],
  tenantId: string,
  summary: string | null,
  cardPreferences: string[],
): Promise<{ operations: VoucherOperation[]; dayTitles: { date: string; title: string }[] }> {
  const { object } = await dailyScheduleAgent.generate(buildVoucherOperationsUserMessage(currentDays, vouchers, voucherId, summary), {
    instructions: buildVoucherOperationsInstructions(cardPreferences),
    requestContext: new RequestContext([['tenant_id', tenantId]]),
    structuredOutput: { schema: voucherOperationsResultSchema },
  });
  return { operations: object.operations, dayTitles: object.day_titles };
}
