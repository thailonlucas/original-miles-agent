import { registerApiRoute, type ContextWithMastra } from '@mastra/core/server';
import { z } from 'zod';
import {
  getTenantIdByEmail,
  getTenantIdByTravelId,
  getTravelMemory,
  MAX_TRAVEL_MEMORY_TEXT,
  removeTravelMemoryItem,
  updateTravelMemoryItem,
} from '../services/travel-db';
import { extractBearerToken, verifySupabaseAccessToken, UnauthorizedError } from '../services/supabase-auth';
import { parseOrBadRequest } from './validate';

// Memória da viagem (`travel.ori_memory`, ver `services/travel-db.ts`): o que os consultores contaram
// ao Ori sobre o cliente/a viagem, com quem contou e quando. Qualquer consultor do tenant vê, corrige
// e apaga — a memória é da viagem, não de quem conversou. Mesmo contrato de autenticação das outras
// rotas de travel_agent/*.
interface Caller {
  tenantId: string;
  userId: string;
  email: string;
}

// Autentica e confere que a viagem (se já existir) é do tenant — devolve a resposta de erro pronta ou quem chamou.
async function authorize(c: ContextWithMastra, travelId: string | undefined): Promise<Caller | Response> {
  let caller: Caller;
  try {
    const user = await verifySupabaseAccessToken(extractBearerToken(c.req.header('Authorization')));
    const tenantId = await getTenantIdByEmail(user.email);
    if (!tenantId) throw new UnauthorizedError(`Nenhum tenant encontrado para o e-mail "${user.email}" (tabela team).`);
    caller = { tenantId, userId: user.id, email: user.email };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return c.json({ error: 'unauthorized', message: error.message }, 401);
    }
    throw error;
  }
  if (!travelId) {
    return c.json({ error: 'bad_request', message: '"travel_id" é obrigatório.' }, 400);
  }
  const travelTenantId = await getTenantIdByTravelId(travelId);
  if (travelTenantId && travelTenantId !== caller.tenantId) {
    return c.json({ error: 'not_found', message: `Viagem ${travelId} não encontrada.` }, 404);
  }
  return caller;
}

export const travelMemoryGetRoute = registerApiRoute('/travel_agent/travel-memory', {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'O que o Ori sabe sobre uma viagem, contado pelos consultores no chat',
    description:
      'Query: `travel_id`. Devolve `{ travel_id, items }`. Cada item: `id`, `text`, quem anotou (`created_by`, ' +
      '`created_by_email`), quando (`created_at`) e em qual conversa (`session_id`); se foi corrigido, `updated_by`, ' +
      '`updated_by_email`, `updated_session_id`, `updated_at`. Separado do Contexto da Viagem (`/travel_agent/travel-summary`), ' +
      'que é escrito só pelo consultor.',
    tags: ['Travel Summary'],
  },
  handler: async (c) => {
    const travelId = c.req.query('travel_id');
    const caller = await authorize(c, travelId);
    if (caller instanceof Response) return caller;
    const items = await getTravelMemory(caller.tenantId, travelId!);
    return c.json({ travel_id: travelId, items }, 200);
  },
});

const updateBodySchema = z.object({
  travel_id: z.string().min(1),
  text: z.string().trim().min(1).max(MAX_TRAVEL_MEMORY_TEXT),
});

export const travelMemoryUpdateRoute = registerApiRoute('/travel_agent/travel-memory/:itemId', {
  method: 'PATCH',
  requiresAuth: false,
  openapi: {
    summary: 'Corrige uma anotação da memória da viagem',
    description: 'Body: `{ travel_id, text }`. Mantém quem anotou originalmente e registra quem corrigiu e quando.',
    tags: ['Travel Summary'],
  },
  handler: async (c) => {
    const body = parseOrBadRequest(updateBodySchema, await c.req.json().catch(() => null), c);
    if (body instanceof Response) return body;
    const caller = await authorize(c, body.travel_id);
    if (caller instanceof Response) return caller;
    const author = { userId: caller.userId, email: caller.email, sessionId: null };
    const result = await updateTravelMemoryItem(caller.tenantId, body.travel_id, author, c.req.param('itemId'), body.text);
    return result ? c.json(result.item, 200) : c.json({ error: 'not_found', message: 'Anotação não encontrada.' }, 404);
  },
});

export const travelMemoryDeleteRoute = registerApiRoute('/travel_agent/travel-memory/:itemId', {
  method: 'DELETE',
  requiresAuth: false,
  openapi: {
    summary: 'Apaga uma anotação da memória da viagem',
    description: 'Query: `travel_id`. O Ori deixa de usar essa informação a partir da próxima mensagem.',
    tags: ['Travel Summary'],
  },
  handler: async (c) => {
    const travelId = c.req.query('travel_id');
    const caller = await authorize(c, travelId);
    if (caller instanceof Response) return caller;
    const removed = await removeTravelMemoryItem(caller.tenantId, travelId!, caller.userId, c.req.param('itemId'));
    return removed ? c.json({ deleted: true }, 200) : c.json({ error: 'not_found', message: 'Anotação não encontrada.' }, 404);
  },
});
