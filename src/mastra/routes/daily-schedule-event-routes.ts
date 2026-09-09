import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { schedulePeriodSchema } from '../agents/schedule-suggestion/schema';
import { getTenantIdByEmail, getTenantIdByTravelId, updateDailyScheduleEvent } from '../services/travel-db';
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

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const updateBodySchema = z
  .object({
    travel_id: z.string().min(1),
    date: z.string().regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD'),
    period: schedulePeriodSchema,
    index: z.number().int().min(0),
    title: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
  })
  .refine((body) => body.title !== undefined || body.content !== undefined, {
    message: 'Informe "title" e/ou "content" pra atualizar.',
  });

export const dailyScheduleEventUpdateRoute = registerApiRoute('/travel_agent/daily-schedule/event', {
  method: 'PATCH',
  requiresAuth: false,
  openapi: {
    summary: 'Edita título/conteúdo de um evento já confirmado do roteiro (originado de voucher)',
    description:
      'Recebe `travel_id`, `date`, `period`, `index` (posição do evento no array daquele dia/período) e `title`/`content` ' +
      '(pelo menos um dos dois). Mesma ideia de editar um voucher, aplicada a um evento específico de `travel.daily_schedule`.',
    tags: ['Daily Schedule'],
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

    const updated = await updateDailyScheduleEvent(tenantId, body.travel_id, userId, body.date, body.period, body.index, {
      title: body.title,
      content: body.content,
    });
    if (!updated) {
      return c.json({ error: 'not_found', message: 'Evento não encontrado nesse dia/período/índice.' }, 404);
    }
    return c.json(updated, 200);
  },
});
