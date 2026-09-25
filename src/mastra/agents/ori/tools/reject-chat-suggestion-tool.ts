import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { schedulePeriodSchema } from '../../schedule-suggestion/schema';
import { EVENT_TITLE_FORMAT, EVENT_TYPE_FORMAT } from '../../daily-schedule/event-format';
import { createDecidedSuggestion } from '../../../services/travel-db';

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// "Rejeitar Sugestão do Chat" — grava como REJEITADA, com o motivo, uma ideia que o Ori propôs na
// conversa e o consultor recusou. Sem isso a recusa se perdia: nem o Ori nem o gerador de sugestões
// sabiam que aquilo já tinha sido oferecido e rejeitado. Mesma função (`createDecidedSuggestion`) de
// "adicionarSugestaoAoDiaADia" (o caminho da ideia aprovada).
//
// Sem `requireApproval`: não grava nada no dia a dia, só registra o que o consultor acabou de dizer —
// mesma lógica de anotar o Contexto da Viagem.
export const rejectChatSuggestionTool = createTool({
  id: 'rejeitarSugestaoDoChat',
  description:
    'Registra como rejeitada uma ideia de atividade que você propôs no chat e o consultor recusou, com o motivo que ele deu (ex: ' +
    '"muito caro", "o cliente não curte museu"). Chame na hora em que ele recusar, sem perguntar — assim essa ideia (e o motivo) não ' +
    'volta a ser sugerida. Pra uma sugestão pendente do kanban (que tem id), use "decidirSugestao".',
  inputSchema: z.object({
    date: z.string().regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD').describe('Dia pra qual a ideia foi proposta.'),
    period: schedulePeriodSchema.describe('Período pra qual a ideia foi proposta.'),
    title: z.string().describe(EVENT_TITLE_FORMAT),
    content: z.string().describe('O texto da ideia como foi proposta no chat.'),
    type: z.string().describe(EVENT_TYPE_FORMAT),
    feedback: z.string().describe('Motivo da recusa, com as palavras do consultor. Se ele não disse o motivo, "sem motivo informado".'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ date, period, title, content, type, feedback }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('rejeitarSugestaoDoChat: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    await createDecidedSuggestion(
      tenantId,
      travelId,
      userId,
      { date, period, event: { title, content, type, observation: null }, reason: null },
      'rejected',
      feedback.trim(),
    );
    return { recorded: true, title };
  },
});
