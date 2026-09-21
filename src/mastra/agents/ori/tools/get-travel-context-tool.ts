import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getTravelSummary } from '../../../services/travel-db';

// "Buscar Contexto da Viagem" — abre o resumo livre cadastrado pelo consultor no campo "Contexto
// da Viagem" do front (perfil do cliente, tipo de viagem, preferências etc. — ver
// `routes/travel-summary-routes.ts`, `GET /travel_agent/travel-summary`). Mesmo contrato das outras
// tools deste agente: `tenant_id`/`travel_id` vêm do `requestContext`, nunca de argumento que o
// model preenche.
export const getTravelContextTool = createTool({
  id: 'buscarContextoViagem',
  description:
    'Abre o "Contexto da Viagem" cadastrado pelo consultor: um resumo livre com perfil do cliente, tipo de viagem, preferências ' +
    'etc., que complementa (mas não substitui) os vouchers. Use para entender melhor o cliente/a viagem antes de responder, montar ' +
    'o roteiro ou sugerir algo. `summary` vem `null` quando a viagem ainda não tem nenhum contexto cadastrado.',
  inputSchema: z.object({}),
  outputSchema: z.unknown(),
  execute: async (_, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    if (!tenantId || !travelId) {
      throw new Error('buscarContextoViagem: requestContext "tenant_id"/"travel_id" são obrigatórios.');
    }

    const summary = await getTravelSummary(tenantId, travelId);
    return { summary };
  },
});
