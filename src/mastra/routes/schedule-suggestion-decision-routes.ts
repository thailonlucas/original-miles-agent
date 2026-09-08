import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { applySuggestionDecision } from '../agents/schedule-suggestion/apply-suggestion-decision';
import { schedulePeriodSchema } from '../agents/schedule-suggestion/schema';
import { getApprovedSuggestions, getTenantIdByEmail, getTenantIdByTravelId } from '../services/travel-db';
import { extractBearerToken, verifySupabaseAccessToken, UnauthorizedError } from '../services/supabase-auth';
import { logConversationError } from '../helpers/logger';
import { parseOrBadRequest } from './validate';

// Mesmo contrato de autenticação das outras rotas de travel_agent/* (ver `voucher-routes.ts`).
// Devolve também `userId` — ver comentário equivalente em `daily-schedule-routes.ts`.
async function resolveTenantId(authorizationHeader: string | undefined | null): Promise<{ tenantId: string; userId: string }> {
  const token = extractBearerToken(authorizationHeader);
  const user = await verifySupabaseAccessToken(token);
  const tenantId = await getTenantIdByEmail(user.email);
  if (!tenantId) {
    throw new UnauthorizedError(`Nenhum tenant encontrado para o e-mail "${user.email}" (tabela team).`);
  }
  return { tenantId, userId: user.id };
}

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Corpo espera de volta exatamente a sugestão que `POST /travel_agent/schedule-suggestion` gerou
// (`title`/`content`/`type`/`observation`/`reason`) pra esse dia/período, mais a decisão do
// cliente — o frontend não precisa reconsultar nada, só reenviar o objeto que já recebeu.
const decisionBodySchema = z.object({
  travel_id: z.string().min(1),
  day: z.string().regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD'),
  period: schedulePeriodSchema,
  status: z.enum(['approved', 'rejected']),
  event: z.object({
    title: z.string().min(1),
    content: z.string().min(1),
    type: z.string().min(1),
    observation: z.string().nullable(),
  }),
  reason: z.string().nullable().optional(),
});

export const scheduleSuggestionDecisionListRoute = registerApiRoute('/travel_agent/schedule-suggestion/decision', {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Lista o histórico de sugestões aprovadas/rejeitadas de uma viagem',
    description:
      'Recebe `travel_id` via query string. Devolve `{ decisions }` — todas as decisões já registradas em `travel.approved_suggestions` ' +
      '(aprovadas E rejeitadas), mais recente primeiro. Mesmo histórico usado pelo agente `schedule-suggestion` pra calibrar as próximas ' +
      'sugestões (ver regra 4.1 do prompt) — este endpoint só expõe ele pro frontend mostrar pro usuário.',
    tags: ['Schedule Suggestion'],
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

    const travelTenantId = await getTenantIdByTravelId(travelId);
    if (travelTenantId && travelTenantId !== tenantId) {
      return c.json({ error: 'not_found', message: `Viagem ${travelId} não encontrada.` }, 404);
    }

    const decisions = await getApprovedSuggestions(tenantId, travelId);
    // Mais recente primeiro — mais útil pro usuário revisar o que acabou de decidir do que o
    // histórico completo em ordem de gravação.
    decisions.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
    return c.json({ decisions }, 200);
  },
});

export const scheduleSuggestionDecisionRoute = registerApiRoute('/travel_agent/schedule-suggestion/decision', {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Registra a aprovação ou rejeição de uma sugestão do schedule-suggestion',
    description:
      'Recebe `travel_id`, `day`, `period`, o `event` sugerido e `status` ("approved"/"rejected"). A decisão é gravada em ' +
      '`travel.approved_suggestions` (histórico usado como "inteligência" da viagem pras próximas sugestões, e exposto ao frontend pelo ' +
      'GET deste mesmo endpoint). Aprovar NÃO insere o evento em `travel.daily_schedule` — uma sugestão aprovada só vira evento real do ' +
      'roteiro quando um voucher de verdade for extraído; até lá ela existe apenas como intenção registrada.',
    tags: ['Schedule Suggestion'],
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
    const body = parseOrBadRequest(decisionBodySchema, rawBody, c);
    if (body instanceof Response) return body;

    // `travel_id` sozinho não escopa por tenant — mesmo cuidado das outras rotas de travel_agent/*.
    // `travelTenantId` null (viagem ainda sem linha em `travel`) segue em frente:
    // `applySuggestionDecision` cria a linha (`ensureTravelExists`) antes de gravar.
    const travelTenantId = await getTenantIdByTravelId(body.travel_id);
    if (travelTenantId && travelTenantId !== tenantId) {
      return c.json({ error: 'not_found', message: `Viagem ${body.travel_id} não encontrada.` }, 404);
    }

    try {
      await applySuggestionDecision(
        tenantId,
        body.travel_id,
        {
          day: body.day,
          period: body.period,
          event: body.event,
          reason: body.reason ?? null,
          status: body.status,
        },
        userId,
      );
      return c.json({ status: body.status }, 200);
    } catch (error) {
      logConversationError(body.travel_id, `falha ao aplicar decisão de sugestão (dia ${body.day}, período ${body.period})`, error);
      return c.json({ error: 'decision_failed', message: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
});
