import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { saveTravelSummary } from '../../../services/travel-db';

// Mesmo limite de `routes/travel-summary-routes.ts` (MAX_SUMMARY_LENGTH) — é o mesmo campo,
// gravado pela mesma coluna (`travel.summary`).
const MAX_SUMMARY_LENGTH = 4000;

// "Atualizar Contexto da Viagem" — cria/edita o resumo livre do campo "Contexto da Viagem" do
// front (perfil do cliente, tipo de viagem, preferências etc.), mesma escrita da rota `PUT
// /travel_agent/travel-summary` (`routes/travel-summary-routes.ts`), só que disparada pelo chat em
// vez do app. `tenant_id`/`travel_id`/`user_id` vêm do `requestContext`, mesmo contrato das outras
// tools deste agente.
export const updateTravelContextTool = createTool({
  id: 'atualizarContextoViagem',
  description:
    'Cria ou substitui o "Contexto da Viagem" cadastrado pelo consultor (perfil do cliente, tipo de viagem, preferências etc.) — ' +
    'complementa os vouchers, não é extraído deles. Substitui o texto inteiro (não é um append). Use quando o consultor pedir para ' +
    'anotar/atualizar essa informação, ou mandar limpar o campo (envie `summary: null` nesse caso). Nunca preencha esse campo por ' +
    'iniciativa própria com algo que o consultor não pediu explicitamente para registrar.',
  inputSchema: z.object({
    summary: z
      .string()
      .max(MAX_SUMMARY_LENGTH)
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
