import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { RequestContext } from '@mastra/core/request-context';
import { getVoucherSummaries } from '../../services/travel-db';
import { buildOriInstructions } from './prompts/system-prompt';
import { oriResultSchema, type OriResult } from './schema';
import { searchVoucherTool } from './tools/search-voucher-tool';
import { updateVoucherTool } from './tools/update-voucher-tool';
import { createVoucherTool } from './tools/create-voucher-tool';
import { deleteVoucherTool } from './tools/delete-voucher-tool';

// Memória de conversa por sessão (thread) — sem ela, a confirmação pedida antes de criar um
// voucher ("quer que eu adicione isso?", ver `tools/create-voucher-tool.ts`) não funcionaria: a
// resposta de confirmação do consultor vem numa chamada HTTP separada, e só o histórico da mesma
// thread permite o agente lembrar o que ele mesmo perguntou. Sem `storage` explícito aqui: usa o
// storage padrão já configurado na instância do Mastra (`mastra-instance.ts`).
const oriMemory = new Memory({
  options: {
    lastMessages: 20,
  },
});

// Instructions reais (com a lista de vouchers da viagem) são montadas por chamada, ver
// `askOri` abaixo — mesmo padrão de `agents/daily-schedule/daily-schedule-agent.ts`.
export const oriAgent = new Agent({
  id: 'ori',
  name: 'Ori',
  description:
    'Agente da Original Miles usado pelos funcionários (consultores de viagem) para tirar dúvidas e montar o roteiro de uma viagem ' +
    'a partir dos vouchers extraídos, e para gerenciar esses vouchers (buscar, criar, atualizar, excluir) pelo chat.',
  instructions: 'Aguardando os vouchers da viagem.',
  model: 'openai/gpt-5.6-terra',
  tools: {
    buscarDocumento: searchVoucherTool,
    atualizarDocumento: updateVoucherTool,
    criarDocumento: createVoucherTool,
    deletarDocumento: deleteVoucherTool,
  },
  memory: oriMemory,
  defaultOptions: {
    // Mesmo raciocínio de `dailyScheduleAgent`: cada voucher aberto/criado/atualizado custa 1
    // passo de tool call, e ainda sobra pelo menos 1 passo pra escrever a saída estruturada.
    maxSteps: 40,
    structuredOutput: {
      schema: oriResultSchema,
    },
  },
});

// Ponto de entrada usado pela rota `routes/ori-routes.ts`. `sessionId` isola a thread de memória
// por conversa; `travelId` entra no id da thread (não só no `resource`) para uma reutilização
// acidental do mesmo `session_id` em outra viagem nunca colidir com uma thread já existente de
// outro dono (thread não pode trocar de "owner"/resource depois de criada).
export async function askOri(tenantId: string, travelId: string, userId: string, sessionId: string, prompt: string): Promise<OriResult> {
  const vouchers = await getVoucherSummaries(tenantId, travelId);

  const { object } = await oriAgent.generate(prompt, {
    instructions: buildOriInstructions(vouchers),
    memory: {
      thread: `${travelId}:${sessionId}`,
      resource: tenantId,
    },
    requestContext: new RequestContext([
      ['tenant_id', tenantId],
      ['travel_id', travelId],
      ['user_id', userId],
    ]),
  });
  return object;
}
