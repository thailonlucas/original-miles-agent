import { registerApiRoute, type ContextWithMastra } from '@mastra/core/server';
import { z } from 'zod';
import { schedulePeriodSchema } from '../agents/schedule-suggestion/schema';
import {
  getTenantIdByEmail,
  getTenantIdByTravelId,
  insertDailyScheduleEvent,
  removeDailyScheduleEvent,
  updateDailyScheduleEvent,
} from '../services/travel-db';
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
    // Destino do move (drag-and-drop do front, `handleMoveEvent` em `DailyScheduleResponse.tsx`) —
    // omitidos = edição no lugar; presentes = move o evento pra este dia/período (cria o dia se
    // ele ainda não tiver nenhum evento).
    new_date: z.string().regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD').optional(),
    new_period: schedulePeriodSchema.optional(),
    // Posição final (0-based) no período de destino — a ordem cronológica dentro da manhã/tarde/noite.
    // Omitido num move = vai pro fim do período.
    new_index: z.number().int().min(0).optional(),
  })
  .refine(
    (body) =>
      body.title !== undefined || body.content !== undefined || body.new_date !== undefined || body.new_period !== undefined || body.new_index !== undefined,
    { message: 'Informe "title"/"content" pra editar, e/ou "new_date"/"new_period"/"new_index" pra mover o evento.' },
  );

export const dailyScheduleEventUpdateRoute = registerApiRoute('/travel_agent/daily-schedule/event', {
  method: 'PATCH',
  requiresAuth: false,
  openapi: {
    summary: 'Edita título/conteúdo de um evento já confirmado do roteiro, e/ou move ele pra outro dia/período',
    description:
      'Recebe `travel_id`, `date`, `period`, `index` (posição atual do evento) e ao menos um de: `title`/`content` (edição no ' +
      'lugar) ou `new_date`/`new_period`/`new_index` (move o evento pra outro dia/período e/ou outra posição dentro do período — ' +
      'mesma chamada usada pelo drag-and-drop do dia a dia no front). Cria o dia de destino se ele ainda não tiver nenhum evento; remove o dia de origem da lista se ele ficar ' +
      'vazio depois do move.',
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
      newDate: body.new_date,
      newPeriod: body.new_period,
      newIndex: body.new_index,
    });
    if (!updated) {
      return c.json({ error: 'not_found', message: 'Evento não encontrado nesse dia/período/índice.' }, 404);
    }
    return c.json(updated, 200);
  },
});

// Autentica, lê o body e confere que a viagem é do tenant — passos iguais nas três rotas de evento
// abaixo. Devolve a `Response` de erro pronta, ou os dados pra seguir.
async function authorizeEventRequest<S extends z.ZodType<{ travel_id: string }>>(
  c: ContextWithMastra,
  schema: S,
): Promise<Response | { tenantId: string; userId: string; body: z.infer<S> }> {
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

  const body = parseOrBadRequest(schema, await c.req.json().catch(() => null), c);
  if (body instanceof Response) return body;

  const travelTenantId = await getTenantIdByTravelId(body.travel_id);
  if (travelTenantId && travelTenantId !== tenantId) {
    return c.json({ error: 'not_found', message: `Viagem ${body.travel_id} não encontrada.` }, 404);
  }
  return { tenantId, userId, body };
}

const createBodySchema = z.object({
  travel_id: z.string().min(1),
  date: z.string().regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD'),
  period: schedulePeriodSchema,
  title: z.string().min(1),
  content: z.string().default(''),
  type: z.string().min(1).default('other'),
  observation: z.string().nullable().default(null),
});

export const dailyScheduleEventCreateRoute = registerApiRoute('/travel_agent/daily-schedule/event', {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Adiciona um evento ao dia a dia, sem regenerar o resto',
    description:
      'Recebe `travel_id`, `date`, `period`, `title` e opcionalmente `content`/`type`/`observation`. Grava com ' +
      '`source: { type: "manual" }` — nenhuma reconstrução a partir de vouchers apaga o evento. Mesma função da tool ' +
      '`adicionarEventoDiaADia` do Ori (que grava com `source: { type: "chat" }`).',
    tags: ['Daily Schedule'],
  },
  handler: async (c) => {
    const auth = await authorizeEventRequest(c, createBodySchema);
    if (auth instanceof Response) return auth;
    const { tenantId, userId, body } = auth;

    const event = await insertDailyScheduleEvent(tenantId, body.travel_id, userId, body.date, body.period, {
      title: body.title,
      content: body.content,
      type: body.type,
      observation: body.observation,
      source: { type: 'manual' },
    });
    return c.json(event, 201);
  },
});

const removeBodySchema = z.object({
  travel_id: z.string().min(1),
  date: z.string().regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD'),
  period: schedulePeriodSchema,
  index: z.number().int().min(0),
});

export const dailyScheduleEventDeleteRoute = registerApiRoute('/travel_agent/daily-schedule/event', {
  method: 'DELETE',
  requiresAuth: false,
  openapi: {
    summary: 'Remove um evento do dia a dia, sem regenerar o resto',
    description:
      'Body JSON: `travel_id`, `date`, `period`, `index`. Um evento de voucher removido assim volta se o voucher for atualizado ' +
      'ou o dia a dia regenerado — pra tirar de vez, exclua o voucher. Mesma função da tool `removerEventoDiaADia` do Ori.',
    tags: ['Daily Schedule'],
  },
  handler: async (c) => {
    const auth = await authorizeEventRequest(c, removeBodySchema);
    if (auth instanceof Response) return auth;
    const { tenantId, userId, body } = auth;

    const removed = await removeDailyScheduleEvent(tenantId, body.travel_id, userId, body.date, body.period, body.index);
    if (!removed) {
      return c.json({ error: 'not_found', message: 'Evento não encontrado nesse dia/período/índice.' }, 404);
    }
    return c.json({ removed: true }, 200);
  },
});
