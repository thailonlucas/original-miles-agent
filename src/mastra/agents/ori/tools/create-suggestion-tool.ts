import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { PREVIEW_BEFORE_WRITE } from './preview-rule';
import { schedulePeriodSchema } from '../../schedule-suggestion/schema';
import { EVENT_CONTENT_FORMAT, EVENT_TITLE_FORMAT, EVENT_TYPE_FORMAT } from '../../daily-schedule/event-format';
import { createPendingSuggestion } from '../../../services/travel-db';

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// "Criar Sugestão" — registra UMA sugestão pendente combinada na conversa. Ela vai pro kanban de
// sugestões pra ser decidida depois (pelo consultor, ou pelo cliente via consultor) — NÃO entra no
// dia a dia. Mesma função (`createPendingSuggestion`) da rota `POST /travel_agent/schedule-suggestion/item`.
export const createSuggestionTool = createTool({
  id: 'criarSugestao',
  requireApproval: true,
  description:
    'Registra UMA sugestão de atividade como pendente — ela aparece no kanban de sugestões pra ser aprovada ou rejeitada depois, ' +
    'sem entrar no dia a dia ainda. Use quando o consultor quiser guardar uma ideia pra decidir depois (ex: "deixa isso como ' +
    'sugestão pro cliente"). Se ele já quer no dia a dia, use "adicionarSugestaoAoDiaADia". ' +
    PREVIEW_BEFORE_WRITE,
  inputSchema: z.object({
    date: z.string().regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD').describe('Dia da atividade.'),
    period: schedulePeriodSchema.describe('Período: "morning", "afternoon" ou "night".'),
    title: z.string().describe(EVENT_TITLE_FORMAT),
    content: z.string().describe(`${EVENT_CONTENT_FORMAT} Endereço/região e duração podem ser aproximados, é uma sugestão.`),
    type: z.string().describe(EVENT_TYPE_FORMAT),
    reason: z.string().optional().describe('Por que essa atividade faz sentido pro cliente nesse dia/período.'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ date, period, title, content, type, reason }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('criarSugestao: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    const suggestion = await createPendingSuggestion(tenantId, travelId, userId, {
      date,
      period,
      event: { title, content, type, observation: null },
      reason: reason?.trim() || null,
    });
    return { created: true, id: suggestion.id, date, period, title };
  },
});
