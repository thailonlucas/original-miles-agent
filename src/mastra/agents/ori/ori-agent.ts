import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { RequestContext } from '@mastra/core/request-context';
import { getDailyScheduleEvent, getSuggestions, getTravelMemory, getTravelSchedule, getTravelSummary, getVoucherSummaries } from '../../services/travel-db';
import { dailyScheduleSchema } from '../daily-schedule/schema';
import { isKeptOnRebuild } from '../daily-schedule/schedule-merge';
import type { SchedulePeriod } from '../daily-schedule/schedule-merge';
import { buildOriInstructions } from './prompts/system-prompt';
import { oriResultSchema, type OriResponse, type OriResult } from './schema';
import { searchVoucherTool } from './tools/search-voucher-tool';
import { updateVoucherTool } from './tools/update-voucher-tool';
import { createVoucherTool } from './tools/create-voucher-tool';
import { deleteVoucherTool } from './tools/delete-voucher-tool';
import { getDailyScheduleTool } from './tools/get-daily-schedule-tool';
import { updateDailyScheduleEventTool } from './tools/update-daily-schedule-event-tool';
import { getTravelContextTool } from './tools/get-travel-context-tool';
import { getSuggestionsTool } from './tools/get-suggestions-tool';
import { detailEventTool } from './tools/detail-event-tool';
import { suggestActivitiesTool } from './tools/suggest-activities-tool';
import { decideSuggestionTool } from './tools/decide-suggestion-tool';
import { addSuggestionToScheduleTool } from './tools/add-suggestion-to-schedule-tool';
import { generateDailyScheduleTool } from './tools/generate-daily-schedule-tool';
import { addDailyScheduleEventTool } from './tools/add-daily-schedule-event-tool';
import { removeDailyScheduleEventTool } from './tools/remove-daily-schedule-event-tool';
import { keepDailyScheduleEventTool } from './tools/keep-daily-schedule-event-tool';
import { updateDayTitlesTool } from './tools/update-day-titles-tool';
import { createSuggestionTool } from './tools/create-suggestion-tool';
import { updateSuggestionTool } from './tools/update-suggestion-tool';
import { removeSuggestionTool } from './tools/remove-suggestion-tool';
import { rejectChatSuggestionTool } from './tools/reject-chat-suggestion-tool';
import { noteTravelMemoryTool } from './tools/note-travel-memory-tool';
import { correctTravelMemoryTool } from './tools/correct-travel-memory-tool';
import { noteUserPreferenceTool } from './tools/note-user-preference-tool';
import { forgetUserPreferenceTool } from './tools/forget-user-preference-tool';
import { internetSearchTool } from './tools/web-search-tool';
import { getTenantRules, getUserMemory } from '../../services/ori-memory-db';

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
  suggestActivitiesTool.id,
  decideSuggestionTool.id,
  addSuggestionToScheduleTool.id,
  generateDailyScheduleTool.id,
  addDailyScheduleEventTool.id,
  removeDailyScheduleEventTool.id,
  keepDailyScheduleEventTool.id,
  updateDayTitlesTool.id,
  createSuggestionTool.id,
  updateSuggestionTool.id,
  removeSuggestionTool.id,
  rejectChatSuggestionTool.id,
  noteTravelMemoryTool.id,
  correctTravelMemoryTool.id,
]);

// Instructions reais (com a lista de vouchers da viagem) são montadas por chamada, ver
// `askOri` abaixo — mesmo padrão de `agents/daily-schedule/daily-schedule-agent.ts`.
export const oriAgent = new Agent({
  id: 'ori',
  name: 'Ori',
  description:
    'Agente da Original Miles usado pelos consultores de viagem: tira dúvidas sobre a viagem, gera e ajusta o dia a dia (roteiro) a ' +
    'partir dos vouchers, gerencia vouchers e sugestões de atividades pelo chat, alinhado ao perfil e às preferências do cliente.',
  instructions: 'Aguardando os vouchers da viagem.',
  model: 'openai/gpt-5.6-terra',
  tools: {
    buscarDocumento: searchVoucherTool,
    atualizarDocumento: updateVoucherTool,
    criarDocumento: createVoucherTool,
    deletarDocumento: deleteVoucherTool,
    buscarDiaADia: getDailyScheduleTool,
    gerarDiaADia: generateDailyScheduleTool,
    adicionarEventoDiaADia: addDailyScheduleEventTool,
    atualizarEventoDiaADia: updateDailyScheduleEventTool,
    removerEventoDiaADia: removeDailyScheduleEventTool,
    manterEventoSemVoucher: keepDailyScheduleEventTool,
    atualizarTituloDoDia: updateDayTitlesTool,
    buscarContextoViagem: getTravelContextTool,
    anotarSobreViagem: noteTravelMemoryTool,
    corrigirAnotacaoViagem: correctTravelMemoryTool,
    buscarSugestoes: getSuggestionsTool,
    detalharEvento: detailEventTool,
    sugerirAtividades: suggestActivitiesTool,
    criarSugestao: createSuggestionTool,
    atualizarSugestao: updateSuggestionTool,
    removerSugestao: removeSuggestionTool,
    rejeitarSugestaoDoChat: rejectChatSuggestionTool,
    decidirSugestao: decideSuggestionTool,
    adicionarSugestaoAoDiaADia: addSuggestionToScheduleTool,
    anotarPreferenciaConsultor: noteUserPreferenceTool,
    esquecerPreferencia: forgetUserPreferenceTool,
    pesquisarNaInternet: internetSearchTool,
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

const PERIOD_LABELS: Record<string, string> = { morning: 'manhã', afternoon: 'tarde', night: 'noite' };

function describeSlot(date: unknown, period: unknown): string {
  return `${date}, ${PERIOD_LABELS[String(period)] ?? period}`;
}

// Pergunta de confirmação da tool call pausada (`requireApproval: true`), montada em código a partir
// dos `args` que o model decidiu passar — a geração está pausada, a LLM ainda não escreveu nada.
// Sempre diz O QUÊ vai ser feito (a sugestão pelo nome, o dia e o período), nunca só "esta
// sugestão", pro consultor não aprovar no escuro.
// Texto do cartão de aprovação da pesquisa na internet. É a última coisa que o consultor lê antes de
// decidir, então diz em poucas linhas: o que vai sair daqui (só o termo), o que volta (resumo com
// fontes) e o que ele precisa fazer (conferir antes de repassar).
function webSearchApprovalQuestion(query: string): string {
  return [
    `Posso pesquisar na internet: "${query}"?`,
    '',
    '• Só esse termo vai para o buscador — nada do cliente.',
    '• Eu trago um resumo com o link de cada informação.',
    '• A internet pode estar desatualizada ou errada: confira nas fontes antes de repassar ao cliente. A checagem fica com você.',
    '• Nada é alterado na viagem.',
  ].join('\n');
}

// Cartão de "refazer o dia a dia": os cards de voucher são refeitos (edições neles se perdem) e o
// resto fica — o cartão diz os números desta viagem, não um aviso genérico.
async function describeScheduleRebuild(tenantId: string, travelId: string): Promise<string> {
  const schedule = await getTravelSchedule(tenantId, travelId);
  const parsed = dailyScheduleSchema.safeParse(schedule.dailySchedule);
  const days = parsed.success ? parsed.data : [];
  const events = days.flatMap((d) => [...d.events.morning, ...d.events.afternoon, ...d.events.night]);
  const rebuilt = events.filter((e) => !isKeptOnRebuild(e)).length;
  const kept = events.length - rebuilt;
  const editedTitles = days.filter((d) => d.title_edited).length;

  const stays = [
    kept ? `${kept} card(s) de sugestões aprovadas, do chat ou adicionados à mão` : null,
    editedTitles ? `${editedTitles} título(s) de dia editado(s)` : null,
  ].filter(Boolean);
  return [
    'Confirma que quer refazer do zero os cards que vêm dos vouchers?',
    '',
    `• ${rebuilt} card(s) de voucher são refeitos a partir dos vouchers: edições feitas neles (texto, dia, ordem) se perdem.`,
    ...(stays.length ? [`• Ficam como estão: ${stays.join(' e ')}.`] : []),
  ].join('\n');
}

async function describePendingApproval(tenantId: string, travelId: string, toolName: string, args: Record<string, unknown>): Promise<string> {
  if (toolName === decideSuggestionTool.id) {
    const suggestion = (await getSuggestions(tenantId, travelId)).find((s) => s.id === args.suggestionId);
    const what = suggestion ? `"${suggestion.event.title}" (${describeSlot(suggestion.date, suggestion.period)})` : 'esta sugestão';
    return args.decision === 'rejected'
      ? `Confirma que quer rejeitar a sugestão ${what}?`
      : `Confirma que quer aprovar a sugestão ${what}? Ela vai entrar no dia a dia mesmo sem um voucher para essa atividade.`;
  }
  if (toolName === createSuggestionTool.id) {
    return `Confirma que quer registrar a sugestão "${args.title}" (${describeSlot(args.date, args.period)}) como pendente?`;
  }
  if (toolName === updateSuggestionTool.id || toolName === removeSuggestionTool.id) {
    const suggestion = (await getSuggestions(tenantId, travelId)).find((s) => s.id === args.suggestionId);
    const what = suggestion ? `"${suggestion.event.title}" (${describeSlot(suggestion.date, suggestion.period)})` : "esta sugestão";
    if (toolName === removeSuggestionTool.id) {
      const alsoSchedule = suggestion?.status === "approved" ? " Ela já está no dia a dia e vai sair de lá também." : "";
      return `Confirma que quer apagar a sugestão ${what}?${alsoSchedule}`;
    }
    const moveTo = args.date || args.period ? ` para ${describeSlot(args.date ?? suggestion?.date, args.period ?? suggestion?.period)}` : "";
    return `Confirma que quer alterar a sugestão ${what}${moveTo}?`;
  }
  if (toolName === addSuggestionToScheduleTool.id) {
    return `Confirma que quer adicionar "${args.title}" ao dia a dia (${describeSlot(args.date, args.period)})? Não há voucher confirmando essa atividade.`;
  }
  if (toolName === addDailyScheduleEventTool.id) {
    return `Confirma que quer adicionar "${args.title}" ao dia a dia (${describeSlot(args.date, args.period)})?`;
  }
  if (toolName === updateDayTitlesTool.id) {
    const days = Array.isArray(args.days) ? (args.days as { date?: unknown; title?: unknown }[]) : [];
    const lines = days.map((d) => `• ${d.date}: ${d.title}`);
    return [`Confirma os novos títulos ${days.length === 1 ? 'do dia' : 'dos dias'}?`, '', ...lines].join('\n');
  }
  if (toolName === keepDailyScheduleEventTool.id) {
    const event =
      typeof args.date === 'string' && typeof args.index === 'number'
        ? await getDailyScheduleEvent(tenantId, travelId, args.date, args.period as SchedulePeriod, args.index)
        : null;
    const what = event ? `"${event.title}" (${describeSlot(args.date, args.period)})` : `o evento de ${describeSlot(args.date, args.period)}`;
    return `Confirma que quer manter ${what} no dia a dia, mesmo sem o voucher? Ele passa a ser um evento manual.`;
  }
  if (toolName === updateDailyScheduleEventTool.id || toolName === removeDailyScheduleEventTool.id) {
    const event =
      typeof args.date === 'string' && typeof args.index === 'number'
        ? await getDailyScheduleEvent(tenantId, travelId, args.date, args.period as SchedulePeriod, args.index)
        : null;
    const what = event ? `"${event.title}" (${describeSlot(args.date, args.period)})` : `o evento de ${describeSlot(args.date, args.period)}`;
    if (toolName === removeDailyScheduleEventTool.id) return `Confirma que quer remover ${what} do dia a dia?`;
    const moveTo = args.newDate || args.newPeriod ? ` para ${describeSlot(args.newDate ?? args.date, args.newPeriod ?? args.period)}` : '';
    const position = typeof args.newIndex === 'number' ? `, como ${args.newIndex + 1}º evento do período` : '';
    return `Confirma que quer alterar ${what}${moveTo}${position}?`;
  }
  if (toolName === internetSearchTool.id) {
    return webSearchApprovalQuestion(String(args.query ?? ''));
  }
  if (toolName === generateDailyScheduleTool.id) {
    return describeScheduleRebuild(tenantId, travelId);
  }
  return `Confirma que quer executar "${toolName}"?`;
}

// Ponto de chegada comum de `askOri` e `decideOriToolCall` abaixo: tanto uma geração nova quanto
// uma retomada (aprovada ou recusada) podem terminar de duas formas — concluída (o model produziu
// a saída estruturada normal) ou pausada de novo (`finishReason: 'suspended'`, se o model chamou
// outra tool protegida em seguida). Os dois casos viram o mesmo envelope `OriResponse` pro front
// tratar de um jeito só.
async function finalizeOriOutput(
  tenantId: string,
  travelId: string,
  output: {
    object?: OriResult;
    text?: string;
    finishReason?: string;
    suspendPayload?: { runId?: string; toolCallId: string; toolName: string; args: Record<string, unknown> };
    runId?: string;
    toolCalls: { payload: { toolName: string } }[];
  },
): Promise<OriResponse> {
  if (output.finishReason === 'suspended' && output.suspendPayload) {
    const { toolCallId, toolName, args } = output.suspendPayload;
    const question = await describePendingApproval(tenantId, travelId, toolName, args);
    // O que o agente escreveu antes de chamar a tool (ex: "Perfeito, vou incluir o casamento...").
    // Ignora se vier vazio ou for JSON — a geração pausou antes da saída estruturada final.
    const agentText = output.text?.trim() ?? '';
    return {
      response: agentText && !agentText.startsWith('{') ? agentText : question,
      analysed_doc_ids: [],
      updated_data: false,
      pending_approval: { run_id: output.runId ?? '', tool_call_id: toolCallId, tool_name: toolName, args, question },
    };
  }

  // `updated_data`: calculado aqui, não pela LLM — ver `WRITE_TOOL_IDS` acima. `true` só diz que
  // ALGUMA tool de escrita rodou nesta resposta (o front sabe que está desatualizado), não o quê
  // mudou especificamente; quem decidir usar esse sinal pra atualizar a tela precisa rebuscar o
  // dado (voucher/dia a dia/contexto/sugestões) por fora, não inferir a partir daqui.
  const updatedData = output.toolCalls.some((call) => WRITE_TOOL_IDS.has(call.payload.toolName));
  return { ...output.object!, updated_data: updatedData };
}

// Ponto de entrada usado pela rota `routes/ori-routes.ts`. `sessionId` isola a thread de memória
// por conversa; `travelId` entra no id da thread (não só no `resource`) para uma reutilização
// acidental do mesmo `session_id` em outra viagem nunca colidir com uma thread já existente de
// outro dono (thread não pode trocar de "owner"/resource depois de criada).
// `userEmail` só serve de rastreabilidade: vai com `user_id` em cada anotação da memória da viagem.
export async function askOri(
  tenantId: string,
  travelId: string,
  userId: string,
  userEmail: string,
  sessionId: string,
  prompt: string,
): Promise<OriResponse> {
  const [vouchers, tripContext, travelMemory, schedule, tenantRules, userItems] = await Promise.all([
    getVoucherSummaries(tenantId, travelId),
    getTravelSummary(tenantId, travelId),
    getTravelMemory(tenantId, travelId),
    getTravelSchedule(tenantId, travelId),
    // Memória é complemento: uma falha ao ler (ex: tabela ainda não criada) não pode derrubar a
    // conversa — o Ori responde sem ela.
    getTenantRules(tenantId).catch((error) => {
      console.error(`[memória do Ori] falha ao ler regras do tenant ${tenantId}`, error);
      return [];
    }),
    getUserMemory(tenantId, userId).catch((error) => {
      console.error(`[memória do Ori] falha ao ler memória do usuário ${userId}`, error);
      return [];
    }),
  ]);
  const parsedSchedule = dailyScheduleSchema.safeParse(schedule.dailySchedule);

  const output = await oriAgent.generate(prompt, {
    instructions: buildOriInstructions(vouchers, { tripContext, travelMemory, userId }, parsedSchedule.success ? parsedSchedule.data : [], {
      tenantRules,
      userItems,
    }),
    memory: {
      thread: `${travelId}:${sessionId}`,
      resource: tenantId,
    },
    requestContext: new RequestContext([
      ['tenant_id', tenantId],
      ['travel_id', travelId],
      ['user_id', userId],
      // Autoria das anotações da memória da viagem (`anotarSobreViagem`/`corrigirAnotacaoViagem`).
      ['user_email', userEmail],
      // Evidência das preferências (`anotarPreferenciaConsultor`) e conversa de origem das anotações da viagem.
      ['session_id', sessionId],
    ]),
  });

  return finalizeOriOutput(tenantId, travelId, output);
}

// Resolve uma pausa de aprovação (`pending_approval` devolvido por `askOri`) — chamado pela rota
// `POST /travel_agent/ori/approval` (`routes/ori-routes.ts`). `approved: false` cancela a tool call
// (o model recebe o `reason` no lugar do resultado da tool) em vez de executá-la. `tenantId`/
// `travelId` só servem pra descrever uma próxima pausa encadeada, se houver.
export async function decideOriToolCall(
  tenantId: string,
  travelId: string,
  runId: string,
  toolCallId: string,
  approved: boolean,
  reason?: string,
): Promise<OriResponse> {
  // Sem um motivo explícito, o default do Mastra ("Tool call was not approved by the user") deixava
  // o model tentar a mesma tool de novo — e o consultor via o pedido de permissão repetido.
  const declineReason = reason?.trim()
    ? `O consultor recusou esta ação: ${reason.trim()}. Não chame esta tool de novo; responda levando isso em conta.`
    : 'O consultor recusou esta ação. Não chame esta tool de novo; confirme com ele o que prefere fazer.';

  const output = approved
    ? await oriAgent.approveToolCallGenerate<OriResult>({ runId, toolCallId, structuredOutput: { schema: oriResultSchema } })
    : await oriAgent.declineToolCallGenerate<OriResult>({ runId, toolCallId, reason: declineReason, structuredOutput: { schema: oriResultSchema } });

  return finalizeOriOutput(tenantId, travelId, output);
}

// Apaga a thread de memória da sessão (mesmo id montado em `askOri`) quando o consultor exclui a
// conversa do histórico — sem isso, o `session_id` apagado ainda carregaria o contexto antigo.
// `getMemory()` em vez de `oriMemory` direto: é a instância com o storage que o Mastra injeta.
export async function deleteOriSessionMemory(travelId: string, sessionId: string): Promise<void> {
  const memory = await oriAgent.getMemory();
  await memory?.deleteThread(`${travelId}:${sessionId}`);
}
