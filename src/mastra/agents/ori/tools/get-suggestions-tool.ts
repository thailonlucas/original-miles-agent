import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getSuggestions } from '../../../services/travel-db';

// "Buscar Sugestões" — histórico de sugestões desta viagem. A lista vem enxuta (sem o `content` de
// cada uma) pra não encher o contexto nem a memória da thread; o detalhe completo de UMA sugestão
// vem pedindo pelo `suggestionId`.
export const getSuggestionsTool = createTool({
  id: 'buscarSugestoes',
  description:
    'Lista as sugestões de atividades já geradas para esta viagem (id, dia, período, título, status, motivo), com filtro opcional ' +
    'por status: "pending" (aguardando decisão), "approved", "rejected" ou "all". Sem "status", devolve só pending+approved — ' +
    'mencione rejeitadas só se o consultor pedir explicitamente. Passe "suggestionId" pra ver os detalhes completos de uma ' +
    'sugestão. Aprovar (com "decidirSugestao") insere o evento de verdade no dia a dia.',
  inputSchema: z.object({
    status: z
      .enum(['pending', 'approved', 'rejected', 'all'])
      .optional()
      .describe('Filtra as sugestões por status. Sem esse campo, exclui as rejeitadas (mostra só pending+approved).'),
    suggestionId: z.string().optional().describe('Id de uma sugestão — devolve só ela, com todos os detalhes.'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ status, suggestionId }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    if (!tenantId || !travelId) {
      throw new Error('buscarSugestoes: requestContext "tenant_id"/"travel_id" são obrigatórios.');
    }

    const all = await getSuggestions(tenantId, travelId);

    if (suggestionId) {
      return all.find((s) => s.id === suggestionId) ?? { error: `sugestão ${suggestionId} não encontrada.` };
    }

    // Sem `status` explícito, esconde as rejeitadas — só aparecem se alguém pedir "rejected"/"all".
    const filtered = !status ? all.filter((s) => s.status !== 'rejected') : status === 'all' ? all : all.filter((s) => s.status === status);
    // Mais recente primeiro, mesmo critério de `routes/schedule-suggestion-decision-routes.ts`.
    filtered.sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt));
    return {
      suggestions: filtered.map((s) => ({
        id: s.id,
        date: s.date,
        period: s.period,
        title: s.event.title,
        type: s.event.type,
        status: s.status,
        reason: s.reason,
        feedback: s.feedback,
      })),
    };
  },
});
