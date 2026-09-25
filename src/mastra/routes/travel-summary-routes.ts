import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { getTenantIdByEmail, getTenantIdByTravelId, getTravelSummary, MAX_TRAVEL_SUMMARY_LENGTH, saveTravelSummary } from '../services/travel-db';
import { extractBearerToken, verifySupabaseAccessToken, UnauthorizedError } from '../services/supabase-auth';
import { parseOrBadRequest } from './validate';

// Mesmo contrato de autenticação das outras rotas de travel_agent/* (ver `voucher-routes.ts`).
async function resolveTenantId(authorizationHeader: string | undefined | null): Promise<{ tenantId: string; userId: string }> {
  const token = extractBearerToken(authorizationHeader);
  const user = await verifySupabaseAccessToken(token);
  const tenantId = await getTenantIdByEmail(user.email);
  if (!tenantId) {
    throw new UnauthorizedError(`Nenhum tenant encontrado para o e-mail "${user.email}" (tabela team).`);
  }
  return { tenantId, userId: user.id };
}


const updateBodySchema = z.object({
  travel_id: z.string().min(1),
  // `null`/string vazia limpam o resumo cadastrado.
  summary: z.string().max(MAX_TRAVEL_SUMMARY_LENGTH).nullable(),
});

export const travelSummaryGetRoute = registerApiRoute('/travel_agent/travel-summary', {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Busca o resumo cadastrado de uma viagem',
    description:
      'Recebe `travel_id` via query string. Devolve `{ travel_id, summary }` — `summary` é `null` se a viagem ainda não tiver ' +
      'nenhum resumo cadastrado (ou se a viagem ainda não existir em `travel`).',
    tags: ['Travel Summary'],
  },
  handler: async (c) => {
    let tenantId: string;
    try {
      ({ tenantId } = await resolveTenantId(c.req.header('Authorization')));
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return c.json({ error: 'unauthorized', message: error.message }, 401);
      }
      throw error;
    }

    const travelId = c.req.query('travel_id');
    if (!travelId) {
      return c.json({ error: 'bad_request', message: '"travel_id" é obrigatório.' }, 400);
    }

    // Mesmo cuidado de escopo por tenant das outras rotas de travel_agent/* — `travel_id` sozinho
    // não garante isolamento (ver `schedule-suggestion-routes.ts`).
    const travelTenantId = await getTenantIdByTravelId(travelId);
    if (travelTenantId && travelTenantId !== tenantId) {
      return c.json({ error: 'not_found', message: `Viagem ${travelId} não encontrada.` }, 404);
    }

    const summary = await getTravelSummary(tenantId, travelId);
    return c.json({ travel_id: travelId, summary }, 200);
  },
});

export const travelSummaryUpdateRoute = registerApiRoute('/travel_agent/travel-summary', {
  method: 'PUT',
  requiresAuth: false,
  openapi: {
    summary: 'Cria/atualiza o resumo de uma viagem',
    description:
      'Recebe `travel_id` e `summary` (texto livre — perfil do cliente, tipo de viagem, preferências etc., ou `null`/string ' +
      'vazia pra limpar). Cria a linha em `travel` se ainda não existir. Este resumo é usado como contexto extra pelos agentes ' +
      '`daily-schedule` (montagem do roteiro) e `schedule-suggestion` (sugestão pontual de atividades) — não substitui vouchers, ' +
      'só complementa.',
    tags: ['Travel Summary'],
  },
  handler: async (c) => {
    let tenantId: string;
    let userId: string;
    try {
      ({ tenantId, userId } = await resolveTenantId(c.req.header('Authorization')));
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return c.json({ error: 'unauthorized', message: error.message }, 401);
      }
      throw error;
    }

    const rawBody = await c.req.json().catch(() => null);
    const body = parseOrBadRequest(updateBodySchema, rawBody, c);
    if (body instanceof Response) return body;

    const travelTenantId = await getTenantIdByTravelId(body.travel_id);
    if (travelTenantId && travelTenantId !== tenantId) {
      return c.json({ error: 'not_found', message: `Viagem ${body.travel_id} não encontrada.` }, 404);
    }

    const summary = body.summary?.trim() || null;
    await saveTravelSummary(tenantId, body.travel_id, summary, userId);
    return c.json({ travel_id: body.travel_id, summary }, 200);
  },
});
