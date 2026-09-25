import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import type { VoucherSummary } from '../../services/travel-db';
import {
  buildForVoucherInstructions,
  buildForVoucherUserMessage,
  buildFromScratchInstructions,
  buildFromScratchUserMessage,
} from './prompts/system-prompt';
import { toStoredDays } from './schedule-merge';
import { voucherScheduleResultSchema, type DailyScheduleDay } from './schema';
import { openVoucherTool } from './tools/open-voucher-tool';

// Só gera eventos de voucher. Juntar com sugestões aprovadas/eventos manuais, remover eventos de um
// voucher excluído e calcular o range da viagem é trabalho do código (`schedule-merge.ts`,
// `rebuild-daily-schedule.ts`), não da LLM.
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

export async function buildVoucherSchedule(
  vouchers: VoucherSummary[],
  tenantId: string,
  summary: string | null,
): Promise<{ days: DailyScheduleDay[]; openedVoucherIds: string[] }> {
  const { object, toolCalls } = await dailyScheduleAgent.generate(buildFromScratchUserMessage(vouchers, summary), {
    instructions: buildFromScratchInstructions(),
    requestContext: new RequestContext([['tenant_id', tenantId]]),
  });
  return { days: toStoredDays(object.days), openedVoucherIds: openedVoucherIds(toolCalls) };
}

// `currentDays` já vem SEM os eventos deste voucher — é só contexto pro agente não repetir o que
// existe e acertar o título dos dias que ele tocar.
export async function buildVoucherEvents(
  voucherId: string,
  currentDays: DailyScheduleDay[],
  vouchers: VoucherSummary[],
  tenantId: string,
  summary: string | null,
): Promise<DailyScheduleDay[]> {
  const { object } = await dailyScheduleAgent.generate(buildForVoucherUserMessage(currentDays, vouchers, voucherId, summary), {
    instructions: buildForVoucherInstructions(),
    requestContext: new RequestContext([['tenant_id', tenantId]]),
  });
  return toStoredDays(object.days, voucherId);
}
