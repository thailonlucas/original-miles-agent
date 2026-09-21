import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { createVoucherType, listVoucherTypes, updateVoucherType } from '../services/voucher-type-db';
import { getTenantIdByEmail } from '../services/travel-db';
import { extractBearerToken, verifySupabaseAccessToken, UnauthorizedError } from '../services/supabase-auth';
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

// Endpoint único (GET/POST/PUT no mesmo path, id no corpo em vez de path param) — mesmo contrato do
// webhook n8n que este substitui (`https://n8n.flowerslab.ai/webhook/travel_agent/voucher_type`),
// pra não exigir mudança no frontend além da URL (`src/lib/agents.ts` -> `VOUCHER_TYPE_ENDPOINT`).
// O frontend já calcula `slug` a partir de `name` (client-side, `slugify`) e manda pronto no POST.
const VOUCHER_TYPE_PATH = '/travel_agent/voucher_type';

const createBodySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1).nullable().optional(),
  prompt: z.string().min(1).nullable().optional(),
  structured_output: z.record(z.string(), z.unknown()).nullable().optional(),
  ai_model: z.string().min(1).nullable().optional(),
  ai_provider: z.string().min(1).nullable().optional(),
  active: z.boolean().optional(),
});

const updateBodySchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string().min(1).optional(),
  description: z.string().min(1).nullable().optional(),
  prompt: z.string().min(1).nullable().optional(),
  structured_output: z.record(z.string(), z.unknown()).nullable().optional(),
  ai_model: z.string().min(1).nullable().optional(),
  ai_provider: z.string().min(1).nullable().optional(),
  active: z.boolean().optional(),
});

export const voucherTypeListRoute = registerApiRoute(VOUCHER_TYPE_PATH, {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Lista os tipos de voucher (voo, hospedagem, transfer etc.) do tenant, com o prompt/schema de extração de cada um',
    tags: ['Voucher Type'],
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

    const types = await listVoucherTypes(tenantId);
    return c.json(types, 200);
  },
});

export const voucherTypeCreateRoute = registerApiRoute(VOUCHER_TYPE_PATH, {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Cria um novo tipo de voucher',
    description: 'Body: `slug` (calculado a partir do `name` pelo frontend), `name`, `description`, `prompt`, `structured_output`, `ai_model`, `ai_provider`, `active`.',
    tags: ['Voucher Type'],
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
    const body = parseOrBadRequest(createBodySchema, rawBody, c);
    if (body instanceof Response) return body;

    const voucherType = await createVoucherType({
      tenantId,
      slug: body.slug,
      name: body.name,
      description: body.description ?? null,
      prompt: body.prompt ?? null,
      structuredOutput: body.structured_output ?? null,
      aiModel: body.ai_model ?? null,
      aiProvider: body.ai_provider ?? null,
      active: body.active ?? true,
    });
    return c.json(voucherType, 201);
  },
});

export const voucherTypeUpdateRoute = registerApiRoute(VOUCHER_TYPE_PATH, {
  method: 'PUT',
  requiresAuth: false,
  openapi: {
    summary: 'Atualiza (parcialmente) um tipo de voucher existente, inclusive para ativar/desativar',
    description: 'Body: `id` (obrigatório) + os campos a alterar.',
    tags: ['Voucher Type'],
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
    const body = parseOrBadRequest(updateBodySchema, rawBody, c);
    if (body instanceof Response) return body;

    const patch: Parameters<typeof updateVoucherType>[2] = {};
    if ('name' in body) patch.name = body.name;
    if ('description' in body) patch.description = body.description ?? null;
    if ('prompt' in body) patch.prompt = body.prompt ?? null;
    if ('structured_output' in body) patch.structuredOutput = body.structured_output ?? null;
    if ('ai_model' in body) patch.aiModel = body.ai_model ?? null;
    if ('ai_provider' in body) patch.aiProvider = body.ai_provider ?? null;
    if ('active' in body) patch.active = body.active;

    const voucherType = await updateVoucherType(tenantId, String(body.id), patch);
    if (!voucherType) {
      return c.json({ error: 'not_found', message: `Tipo de voucher ${body.id} não encontrado.` }, 404);
    }
    return c.json(voucherType, 200);
  },
});
