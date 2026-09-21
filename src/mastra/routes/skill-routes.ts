import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { createSkill, listSkills, updateSkill } from '../services/skill-db';
import { getTenantIdByEmail } from '../services/travel-db';
import { extractBearerToken, verifySupabaseAccessToken, UnauthorizedError } from '../services/supabase-auth';
import { parseOrBadRequest } from './validate';

// Mesmo contrato de autenticação das outras rotas de travel_agent/* (ver `voucher-routes.ts`).
async function resolveTenant(authorizationHeader: string | undefined | null): Promise<{ tenantId: string; userId: string }> {
  const token = extractBearerToken(authorizationHeader);
  const user = await verifySupabaseAccessToken(token);
  const tenantId = await getTenantIdByEmail(user.email);
  if (!tenantId) {
    throw new UnauthorizedError(`Nenhum tenant encontrado para o e-mail "${user.email}" (tabela team).`);
  }
  return { tenantId, userId: user.id };
}

// Endpoint único (GET/POST/PUT no mesmo path, id no corpo em vez de path param) — mesmo contrato do
// webhook n8n que este substitui (`https://n8n.flowerslab.ai/webhook/travel_agent/skills`), pra não
// exigir nenhuma mudança no frontend além da URL (ver `src/lib/agents.ts` -> `SKILLS_ENDPOINT`).
const SKILLS_PATH = '/travel_agent/skills';

const createBodySchema = z.object({
  title: z.string().min(1),
  chat_label: z.string().min(1).nullable().optional(),
  prompt: z.string().min(1).nullable().optional(),
  active: z.boolean().optional(),
});

const updateBodySchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string().min(1).optional(),
  chat_label: z.string().min(1).nullable().optional(),
  prompt: z.string().min(1).nullable().optional(),
  active: z.boolean().optional(),
});

export const skillListRoute = registerApiRoute(SKILLS_PATH, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Lista as habilidades (prompts pré-configurados exibidos como atalhos no chat) do tenant',
    tags: ['Skills'],
  },
  handler: async (c) => {
    let tenantId: string;
    try {
      ({ tenantId } = await resolveTenant(c.req.header('Authorization')));
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return c.json({ error: 'unauthorized', message: error.message }, 401);
      }
      throw error;
    }

    const skills = await listSkills(tenantId);
    return c.json(skills, 200);
  },
});

export const skillCreateRoute = registerApiRoute(SKILLS_PATH, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Cria uma nova habilidade',
    description: 'Body: `title`, `chat_label`, `prompt`, `active`.',
    tags: ['Skills'],
  },
  handler: async (c) => {
    let tenantId: string;
    let userId: string;
    try {
      ({ tenantId, userId } = await resolveTenant(c.req.header('Authorization')));
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return c.json({ error: 'unauthorized', message: error.message }, 401);
      }
      throw error;
    }

    const rawBody = await c.req.json().catch(() => null);
    const body = parseOrBadRequest(createBodySchema, rawBody, c);
    if (body instanceof Response) return body;

    const skill = await createSkill({
      tenantId,
      title: body.title,
      chatLabel: body.chat_label ?? null,
      prompt: body.prompt ?? null,
      active: body.active ?? true,
      createdBy: userId,
    });
    return c.json(skill, 201);
  },
});

export const skillUpdateRoute = registerApiRoute(SKILLS_PATH, {
  method: 'PUT',
  requiresAuth: false,
  openapi: {
    summary: 'Atualiza (parcialmente) uma habilidade existente',
    description: 'Body: `id` (obrigatório) + os campos a alterar (`title`, `chat_label`, `prompt`, `active`).',
    tags: ['Skills'],
  },
  handler: async (c) => {
    let tenantId: string;
    try {
      ({ tenantId } = await resolveTenant(c.req.header('Authorization')));
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return c.json({ error: 'unauthorized', message: error.message }, 401);
      }
      throw error;
    }

    const rawBody = await c.req.json().catch(() => null);
    const body = parseOrBadRequest(updateBodySchema, rawBody, c);
    if (body instanceof Response) return body;

    const patch: Parameters<typeof updateSkill>[2] = {};
    if ('title' in body) patch.title = body.title;
    if ('chat_label' in body) patch.chatLabel = body.chat_label ?? null;
    if ('prompt' in body) patch.prompt = body.prompt ?? null;
    if ('active' in body) patch.active = body.active;

    const skill = await updateSkill(tenantId, String(body.id), patch);
    if (!skill) {
      return c.json({ error: 'not_found', message: `Habilidade ${body.id} não encontrada.` }, 404);
    }
    return c.json(skill, 200);
  },
});
