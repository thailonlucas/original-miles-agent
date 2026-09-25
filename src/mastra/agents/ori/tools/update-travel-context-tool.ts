import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { MAX_TRAVEL_SUMMARY_LENGTH, saveTravelSummary } from '../../../services/travel-db';

// "Atualizar Contexto da Viagem" — cria/edita o resumo livre do campo "Contexto da Viagem" do
// front (perfil do cliente, tipo de viagem, preferências etc.), mesma escrita da rota `PUT
// /travel_agent/travel-summary` (`routes/travel-summary-routes.ts`), só que disparada pelo chat em
// vez do app. `tenant_id`/`travel_id`/`user_id` vêm do `requestContext`, mesmo contrato das outras
// tools deste agente. Anotar informação nova é "anotarContextoViagem" (automático, só acrescenta);
// esta substitui o texto inteiro, por isso `requireApproval: true`.
export const updateTravelContextTool = createTool({
  id: 'atualizarContextoViagem',
  requireApproval: true,
  description:
    'Reescreve o Contexto da Viagem INTEIRO (substitui o texto atual). Use só pra corrigir uma informação que ficou errada ou ' +
    'reorganizar/consolidar o texto (ex: quando ficar longo ou tiver informações que se contradizem), mantendo tudo que continua ' +
    'válido. Pra guardar uma informação nova, use "anotarContextoViagem". Envie `summary: null` só se o consultor pedir pra limpar ' +
    'o campo. A chamada pausa esperando confirmação do consultor antes de gravar.',
  inputSchema: z.object({
    summary: z
      .string()
      .max(MAX_TRAVEL_SUMMARY_LENGTH)
      .nullable()
      .describe('Novo texto do "Contexto da Viagem" (substitui o anterior inteiro), ou `null`/string vazia para limpar o campo.'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ summary }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('atualizarContextoViagem: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    const normalized = summary?.trim() || null;
    await saveTravelSummary(tenantId, travelId, normalized, userId);
    return { summary: normalized };
  },
});
