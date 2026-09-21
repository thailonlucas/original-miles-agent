import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getSuggestions } from '../../../services/travel-db';

// "Buscar Sugestões" — abre o histórico de sugestões já geradas pelo agente `schedule-suggestion`
// pra esta viagem (pendentes, aprovadas e rejeitadas), com filtro opcional por status. Mesmo
// contrato de `get-daily-schedule-tool.ts`: `tenant_id`/`travel_id` vêm do `requestContext`, nunca
// de argumento que o model preenche.
export const getSuggestionsTool = createTool({
  id: 'buscarSugestoes',
  description:
    'Lista as sugestões de atividades já geradas para esta viagem (pelo agente de sugestões), com filtro opcional por status: ' +
    '"pending" (aguardando decisão do consultor/cliente), "approved" (aprovadas), "rejected" (rejeitadas) ou "all" (todas — default). ' +
    'Use para responder perguntas como "quais sugestões já geramos?", "o que já foi aprovado?" ou "o que o cliente rejeitou?". ' +
    'Aprovar uma sugestão aqui NÃO insere um evento no roteiro (daily_schedule) — é só um registro de intenção.',
  inputSchema: z.object({
    status: z
      .enum(['pending', 'approved', 'rejected', 'all'])
      .optional()
      .describe('Filtra as sugestões por status. Default: "all" (devolve todas, de qualquer status).'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ status }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    if (!tenantId || !travelId) {
      throw new Error('buscarSugestoes: requestContext "tenant_id"/"travel_id" são obrigatórios.');
    }

    const all = await getSuggestions(tenantId, travelId);
    const filtered = !status || status === 'all' ? all : all.filter((s) => s.status === status);
    // Mais recente primeiro, mesmo critério de `routes/schedule-suggestion-decision-routes.ts`.
    filtered.sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt));
    return { suggestions: filtered };
  },
});
