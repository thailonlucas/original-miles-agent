import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { RequestContext } from '@mastra/core/request-context';
import { getVoucherSummaries, getTravelSummary } from '../../services/travel-db';
import { buildOriInstructions } from './prompts/system-prompt';
import { oriResultSchema, type OriResponse } from './schema';
import { searchVoucherTool } from './tools/search-voucher-tool';
import { updateVoucherTool } from './tools/update-voucher-tool';
import { createVoucherTool } from './tools/create-voucher-tool';
import { deleteVoucherTool } from './tools/delete-voucher-tool';
import { getDailyScheduleTool } from './tools/get-daily-schedule-tool';
import { updateDailyScheduleEventTool } from './tools/update-daily-schedule-event-tool';
import { getTravelContextTool } from './tools/get-travel-context-tool';
import { updateTravelContextTool } from './tools/update-travel-context-tool';
import { getSuggestionsTool } from './tools/get-suggestions-tool';
import { suggestActivitiesTool } from './tools/suggest-activities-tool';

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

// Ids das tools que escrevem/alteram dado (o resto é só leitura) — usado só por `askOri` abaixo
// pra calcular `updated_data` a partir de `toolCalls` do `generate()`, sem depender da LLM
// preencher esse campo (custaria tokens de saída à toa e seria menos confiável que checar o que
// de fato foi chamado). `sugerirAtividades` entra aqui porque grava sugestões novas (mesmo não
// sobrescrevendo nada existente) — o front também precisa saber que há dado novo pra mostrar.
const WRITE_TOOL_IDS = new Set<string>([
  createVoucherTool.id,
  updateVoucherTool.id,
  deleteVoucherTool.id,
  updateDailyScheduleEventTool.id,
  updateTravelContextTool.id,
  suggestActivitiesTool.id,
]);

// Instructions reais (com a lista de vouchers da viagem) são montadas por chamada, ver
// `askOri` abaixo — mesmo padrão de `agents/daily-schedule/daily-schedule-agent.ts`.
export const oriAgent = new Agent({
  id: 'ori',
  name: 'Ori',
  description:
    'Agente da Original Miles usado pelos funcionários (consultores de viagem) para tirar dúvidas e montar o dia a dia (roteiro) de ' +
    'uma viagem a partir dos vouchers extraídos, para gerenciar esses vouchers (buscar, criar, atualizar, excluir) pelo chat, e para ' +
    'gerar e consultar sugestões de atividades — ajudando o consultor a enriquecer o dia a dia com opções alinhadas ao perfil e às ' +
    'preferências do cliente.',
  instructions: 'Aguardando os vouchers da viagem.',
  model: 'openai/gpt-5.6-terra',
  tools: {
    buscarDocumento: searchVoucherTool,
    atualizarDocumento: updateVoucherTool,
    criarDocumento: createVoucherTool,
    deletarDocumento: deleteVoucherTool,
    buscarDiaADia: getDailyScheduleTool,
    atualizarEventoDiaADia: updateDailyScheduleEventTool,
    buscarContextoViagem: getTravelContextTool,
    atualizarContextoViagem: updateTravelContextTool,
    buscarSugestoes: getSuggestionsTool,
    sugerirAtividades: suggestActivitiesTool,
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
export async function askOri(tenantId: string, travelId: string, userId: string, sessionId: string, prompt: string): Promise<OriResponse> {
  const [vouchers, tripContext] = await Promise.all([getVoucherSummaries(tenantId, travelId), getTravelSummary(tenantId, travelId)]);

  const { object, toolCalls } = await oriAgent.generate(prompt, {
    instructions: buildOriInstructions(vouchers, tripContext),
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

  // `updated_data`: calculado aqui, não pela LLM — ver `WRITE_TOOL_IDS` acima. `true` só diz que
  // ALGUMA tool de escrita rodou nesta resposta (o front sabe que está desatualizado), não o quê
  // mudou especificamente; quem decidir usar esse sinal pra atualizar a tela precisa rebuscar o
  // dado (voucher/dia a dia/contexto/sugestões) por fora, não inferir a partir daqui.
  const updatedData = toolCalls.some((call) => WRITE_TOOL_IDS.has(call.payload.toolName));

  return { ...object, updated_data: updatedData };
}
