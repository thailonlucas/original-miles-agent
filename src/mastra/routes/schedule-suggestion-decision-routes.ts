import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { applySuggestionDecision } from '../agents/schedule-suggestion/apply-suggestion-decision';
import { schedulePeriodSchema } from '../agents/schedule-suggestion/schema';
import { deleteSuggestion, getSuggestions, getTenantIdByEmail, getTenantIdByTravelId, moveSuggestion } from '../services/travel-db';
import { extractBearerToken, verifySupabaseAccessToken, UnauthorizedError } from '../services/supabase-auth';
import { logConversationError } from '../helpers/logger';
import { parseOrBadRequest } from './validate';

// Mesmo contrato de autenticação das outras rotas de travel_agent/* (ver `voucher-routes.ts`).
async function resolveTenantId(authorizationHeader: string | undefined | null): Promise<string> {
  const token = extractBearerToken(authorizationHeader);
  const user = await verifySupabaseAccessToken(token);
  const tenantId = await getTenantIdByEmail(user.email);
  if (!tenantId) {
    throw new UnauthorizedError(`Nenhum tenant encontrado para o e-mail "${user.email}" (tabela team).`);
  }
  return tenantId;
}

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const scheduleSuggestionDecisionListRoute = registerApiRoute('/travel_agent/schedule-suggestion/decision', {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Lista todas as sugestões já geradas de uma viagem (pendentes, aprovadas e rejeitadas)',
    description:
      'Recebe `travel_id` via query string. Devolve `{ decisions }` — TODA sugestão já gerada pelo agente `schedule-suggestion` pra ' +
      'essa viagem, independente de já ter sido decidida (inclui "status": "pending"), mais recente primeiro.',
    tags: ['Schedule Suggestion'],
  },
  handler: async (c) => {
    let tenantId: string;
    try {
      tenantId = await resolveTenantId(c.req.header('Authorization'));
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

    const travelTenantId = await getTenantIdByTravelId(travelId);
    if (travelTenantId && travelTenantId !== tenantId) {
      return c.json({ error: 'not_found', message: `Viagem ${travelId} não encontrada.` }, 404);
    }

    const decisions = await getSuggestions(tenantId, travelId);
    // Mais recente primeiro (por `createdAt`, já que uma pendente ainda não tem `decidedAt`) —
    // mais útil pro usuário revisar o que acabou de acontecer do que ordem de gravação.
    decisions.sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt));
    return c.json({ decisions }, 200);
  },
});

const decisionBodySchema = z.object({
  travel_id: z.string().min(1),
  id: z.string().min(1),
  status: z.enum(['approved', 'rejected']),
  // Motivo dado pela pessoa ao aprovar/rejeitar (ex: "muito caro", "adoramos vinícolas") — opcional,
  // mas é o sinal mais forte pro agente calibrar as próximas sugestões (ver regra 4.1 do prompt).
  feedback: z.string().max(1000).nullable().optional(),
});

export const scheduleSuggestionDecisionRoute = registerApiRoute('/travel_agent/schedule-suggestion/decision', {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Aprova ou rejeita uma sugestão já gerada do schedule-suggestion',
    description:
      'Recebe `travel_id`, `id` (da sugestão, devolvido por `POST /travel_agent/schedule-suggestion`) e `status` ' +
      '("approved"/"rejected"), mais `feedback` opcional. Só decide uma sugestão que ainda esteja "pending" — devolve 404 se o id ' +
      'não existir ou já tiver sido decidido. Aprovar NÃO insere o evento em `travel.daily_schedule` — uma sugestão aprovada só vira ' +
      'evento real do roteiro quando um voucher de verdade for extraído; até lá ela existe apenas como intenção registrada.',
    tags: ['Schedule Suggestion'],
  },
  handler: async (c) => {
    let tenantId: string;
    try {
      tenantId = await resolveTenantId(c.req.header('Authorization'));
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return c.json({ error: 'unauthorized', message: error.message }, 401);
      }
      throw error;
    }

    const rawBody = await c.req.json().catch(() => null);
    const body = parseOrBadRequest(decisionBodySchema, rawBody, c);
    if (body instanceof Response) return body;

    const travelTenantId = await getTenantIdByTravelId(body.travel_id);
    if (travelTenantId && travelTenantId !== tenantId) {
      return c.json({ error: 'not_found', message: `Viagem ${body.travel_id} não encontrada.` }, 404);
    }

    try {
      const decided = await applySuggestionDecision(tenantId, body.travel_id, {
        id: body.id,
        status: body.status,
        feedback: body.feedback?.trim() || null,
      });
      if (!decided) {
        return c.json({ error: 'not_found', message: `Sugestão ${body.id} não encontrada ou já decidida.` }, 404);
      }
      return c.json({ status: body.status }, 200);
    } catch (error) {
      logConversationError(body.travel_id, `falha ao aplicar decisão da sugestão ${body.id}`, error);
      return c.json({ error: 'decision_failed', message: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
});

const moveBodySchema = z.object({
  travel_id: z.string().min(1),
  id: z.string().min(1),
  date: z.string().regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD'),
  period: schedulePeriodSchema,
});

export const scheduleSuggestionMoveRoute = registerApiRoute('/travel_agent/schedule-suggestion/move', {
  method: 'PATCH',
  requiresAuth: false,
  openapi: {
    summary: 'Move uma sugestão (pendente ou aprovada) pra outro dia/período',
    description: 'Recebe `travel_id`, `id` da sugestão, e o novo `date`/`period`. Usado pelo drag and drop do kanban de sugestões no frontend.',
    tags: ['Schedule Suggestion'],
  },
  handler: async (c) => {
    let tenantId: string;
    try {
      tenantId = await resolveTenantId(c.req.header('Authorization'));
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return c.json({ error: 'unauthorized', message: error.message }, 401);
      }
      throw error;
    }

    const rawBody = await c.req.json().catch(() => null);
    const body = parseOrBadRequest(moveBodySchema, rawBody, c);
    if (body instanceof Response) return body;

    const travelTenantId = await getTenantIdByTravelId(body.travel_id);
    if (travelTenantId && travelTenantId !== tenantId) {
      return c.json({ error: 'not_found', message: `Viagem ${body.travel_id} não encontrada.` }, 404);
    }

    const moved = await moveSuggestion(tenantId, body.travel_id, body.id, body.date, body.period);
    if (!moved) {
      return c.json({ error: 'not_found', message: `Sugestão ${body.id} não encontrada.` }, 404);
    }
    return c.json({ moved: true }, 200);
  },
});

export const scheduleSuggestionDeleteRoute = registerApiRoute('/travel_agent/schedule-suggestion/decision', {
  method: 'DELETE',
  requiresAuth: false,
  openapi: {
    summary: 'Remove uma sugestão do histórico por completo (qualquer status)',
    description:
      'Recebe `travel_id` e `id` via query string. Diferente de rejeitar: a sugestão some da "inteligência" da viagem também, não ' +
      'fica registrada como rejeição — usado pro botão de apagar uma sugestão já aprovada na tela de histórico.',
    tags: ['Schedule Suggestion'],
  },
  handler: async (c) => {
    let tenantId: string;
    try {
      tenantId = await resolveTenantId(c.req.header('Authorization'));
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return c.json({ error: 'unauthorized', message: error.message }, 401);
      }
      throw error;
    }

    const travelId = c.req.query('travel_id');
    const id = c.req.query('id');
    if (!travelId) {
      return c.json({ error: 'bad_request', message: '"travel_id" é obrigatório.' }, 400);
    }
    if (!id) {
      return c.json({ error: 'bad_request', message: '"id" é obrigatório.' }, 400);
    }

    const travelTenantId = await getTenantIdByTravelId(travelId);
    if (travelTenantId && travelTenantId !== tenantId) {
      return c.json({ error: 'not_found', message: `Viagem ${travelId} não encontrada.` }, 404);
    }

    const removed = await deleteSuggestion(tenantId, travelId, id);
    if (!removed) {
      return c.json({ error: 'not_found', message: `Sugestão ${id} não encontrada.` }, 404);
    }
    return c.json({ removed: true }, 200);
  },
});
