import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { MAX_TRAVEL_MEMORY_TEXT, removeTravelMemoryItem, updateTravelMemoryItem } from '../../../services/travel-db';

// "Corrigir Anotação da Viagem" — corrige ou remove UM item da memória da viagem, pelo id. Nunca
// reescreve a lista inteira (antes, `atualizarContextoViagem` reescrevia o texto todo pra
// "consolidar" e acabava apagando informação). Sem confirmação, como `esquecerPreferencia`: só roda
// quando o consultor diz que algo mudou ou está errado. A correção guarda quem corrigiu e quando, sem
// perder quem anotou originalmente.
export const correctTravelMemoryTool = createTool({
  id: 'corrigirAnotacaoViagem',
  description:
    'Corrige ou remove UMA anotação da memória desta viagem, pelo id (entre colchetes na seção "O que a equipe já contou sobre esta ' +
    'viagem"). Use só quando o consultor disser que uma informação anotada mudou ou está errada (ex: "na verdade são 3 pessoas", ' +
    '"ela voltou a comer carne") ou pedir pra esquecer. `text` com o texto novo corrige; `text: null` remove. Nunca use pra ' +
    'reorganizar, resumir ou juntar anotações que continuam valendo. Não mexe no Contexto da Viagem, que é do consultor.',
  inputSchema: z.object({
    id: z.string().min(1).describe('Id da anotação.'),
    text: z
      .string()
      .min(1)
      .max(MAX_TRAVEL_MEMORY_TEXT)
      .nullable()
      .describe('Texto corrigido, em terceira pessoa, ou `null` pra remover a anotação.'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ id, text }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('corrigirAnotacaoViagem: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    if (text === null) {
      const removed = await removeTravelMemoryItem(tenantId, travelId, userId, id);
      return removed ? { removed: true, text: removed.text } : { error: `Anotação ${id} não encontrada.` };
    }
    const author = {
      userId,
      email: requestContext.get<string, string | undefined>('user_email') ?? null,
      sessionId: requestContext.get<string, string | undefined>('session_id') ?? null,
    };
    const result = await updateTravelMemoryItem(tenantId, travelId, author, id, text);
    return result ? { updated: true, before: result.previous.text, after: result.item.text } : { error: `Anotação ${id} não encontrada.` };
  },
});
