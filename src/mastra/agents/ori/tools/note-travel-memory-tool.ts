import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { addTravelMemoryItem, MAX_TRAVEL_MEMORY_TEXT } from '../../../services/travel-db';

// "Anotar sobre a Viagem" — guarda UMA informação que o consultor contou sobre o cliente/a viagem na
// memória da viagem (`travel.ori_memory`, ver `services/travel-db.ts`), compartilhada entre todos os
// consultores dela. Nunca escreve no "Contexto da Viagem" (`travel.summary`), que é só do consultor.
// Quem contou, quando e em qual conversa vêm do `requestContext`, nunca do model.
export const noteTravelMemoryTool = createTool({
  id: 'anotarSobreViagem',
  description:
    'Guarda na memória desta viagem UMA informação que o consultor contou sobre o cliente ou a viagem e que vai continuar valendo ' +
    '(perfil, gostos, restrições, ocasião, orçamento, quem viaja). Ex: "o cliente não come frutos do mar" → "Cliente não come frutos ' +
    'do mar". Chame na hora, sem perguntar e sem anunciar. NÃO anote: o que já está no Contexto da Viagem ou na memória da viagem, ' +
    'o que está nos vouchers ou no dia a dia, pedidos e tarefas da conversa ("gera o dia a dia", "muda o jantar"), suas próprias ' +
    'ideias, nem como o consultor gosta de trabalhar (isso é "anotarPreferenciaConsultor"). Uma informação que muda uma já anotada ' +
    'é "corrigirAnotacaoViagem", não uma anotação nova.',
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .max(MAX_TRAVEL_MEMORY_TEXT)
      .describe('A informação, curta e objetiva, em terceira pessoa (ex: "Casal em lua de mel; evita frutos do mar").'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ text }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('anotarSobreViagem: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }
    const author = {
      userId,
      email: requestContext.get<string, string | undefined>('user_email') ?? null,
      sessionId: requestContext.get<string, string | undefined>('session_id') ?? null,
    };

    const result = await addTravelMemoryItem(tenantId, travelId, author, text);
    if ('error' in result) return result;
    return result.duplicate ? { saved: false, reason: 'Já estava anotado.', id: result.item.id } : { saved: true, id: result.item.id };
  },
});
