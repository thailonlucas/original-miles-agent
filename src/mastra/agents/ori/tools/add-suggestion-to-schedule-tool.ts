import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { PREVIEW_BEFORE_WRITE } from './preview-rule';
import { schedulePeriodSchema } from '../../schedule-suggestion/schema';
import { EVENT_CONTENT_FORMAT, EVENT_TITLE_FORMAT, EVENT_TYPE_FORMAT } from '../../daily-schedule/event-format';
import { createDecidedSuggestion } from '../../../services/travel-db';

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// "Adicionar Sugestão ao Dia a Dia" — pro fluxo conversacional de sugestão: uma ideia que o Ori e o
// consultor (ou o cliente, via consultor) refinaram junto no chat até chegar num formato bom, sem
// nunca ter passado por "sugerirAtividades" (não é uma sugestão pendente da lista de
// "buscarSugestoes"). Grava essa ideia já como sugestão "approved" (fica no histórico, junto com
// as outras) E insere o evento dela no dia a dia — as duas coisas de uma vez
// (`createDecidedSuggestion`, `services/travel-db.ts`). Ideia recusada no chat vai por
// "rejeitarSugestaoDoChat", que usa a mesma função.
//
// `requireApproval: true` — mesma razão de `decidirSugestao`: pausa a execução de verdade antes de
// gravar, em vez de depender de o model lembrar de perguntar antes de chamar.
export const addSuggestionToScheduleTool = createTool({
  id: 'adicionarSugestaoAoDiaADia',
  requireApproval: true,
  description:
    'Registra uma ideia de atividade DIRETO como aprovada e já insere o evento correspondente no dia a dia (`daily_schedule`) — sem ' +
    'nenhum voucher/reserva por trás. Use só depois de propor a ideia em texto na conversa (nunca chame direto ao ser pedida uma ' +
    'sugestão) e refinar com o consultor até ela concordar que está boa. ' +
    PREVIEW_BEFORE_WRITE,
  inputSchema: z.object({
    date: z.string().regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD').describe('Dia em que a atividade vai acontecer.'),
    period: schedulePeriodSchema.describe('Período do dia: "morning", "afternoon" ou "night".'),
    title: z.string().describe(EVENT_TITLE_FORMAT),
    content: z.string().describe(`${EVENT_CONTENT_FORMAT} Endereço/região e duração podem ser aproximados, é uma sugestão.`),
    type: z.string().describe(EVENT_TYPE_FORMAT),
    observation: z
      .string()
      .nullable()
      .optional()
      .describe('Preencha só se a atividade conflitar/complementar algo já confirmado neste dia/período. Normalmente omitido.'),
    feedback: z
      .string()
      .max(1000)
      .optional()
      .describe('Motivo objetivo de por que essa ideia foi a escolhida (ex: "cliente pediu algo romântico e econômico") — ajuda a calibrar futuras sugestões.'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ date, period, title, content, type, observation, feedback }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('adicionarSugestaoAoDiaADia: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    const event = await createDecidedSuggestion(
      tenantId,
      travelId,
      userId,
      { date, period, event: { title, content, type, observation: observation ?? null }, reason: null },
      'approved',
      feedback?.trim() || null,
    );
    return { event };
  },
});
