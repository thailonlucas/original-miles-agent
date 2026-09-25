import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { triggerDailyScheduleRemoval, triggerDailyScheduleUpdate } from '../agents/daily-schedule/daily-schedule-trigger';
import { createExtractedVoucher, type VoucherIssuer } from '../services/create-voucher';
import {
  insertVoucher,
  deleteVoucher,
  getVouchers,
  updateVoucherFields,
  getTenantIdByEmail,
  getTenantIdByTravelId,
  type UpdateVoucherInput,
} from '../services/travel-db';
import { extractBearerToken, verifySupabaseAccessToken, UnauthorizedError } from '../services/supabase-auth';
import { logConversationError } from '../helpers/logger';
import { parseOrBadRequest } from './validate';

const FALLBACK_VOUCHER_TYPE_SLUG = 'other';

const VOUCHER_ISSUERS: readonly VoucherIssuer[] = ['company', 'customer'];

function isVoucherIssuer(value: unknown): value is VoucherIssuer {
  return typeof value === 'string' && (VOUCHER_ISSUERS as readonly string[]).includes(value);
}

// Resolve o tenant do usuário autenticado a partir do header `Authorization: Bearer
// <access_token>` do Supabase Auth — mesmo contrato das outras rotas de travel_agent (ver
// `original-miles-cartinhas/src/routes/devs.tsx`). Lança `UnauthorizedError` (401) se o token
// faltar/for inválido, ou se o e-mail do usuário não estiver em nenhum `team` (sem tenant).
async function resolveTenantId(authorizationHeader: string | undefined | null): Promise<{ tenantId: string; userId: string }> {
  const token = extractBearerToken(authorizationHeader);
  const user = await verifySupabaseAccessToken(token);
  const tenantId = await getTenantIdByEmail(user.email);
  if (!tenantId) {
    throw new UnauthorizedError(`Nenhum tenant encontrado para o e-mail "${user.email}" (tabela team).`);
  }
  return { tenantId, userId: user.id };
}

export const voucherExtractRoute = registerApiRoute('/travel_agent/extract/vouchers', {
  method: 'POST',
  // Autenticação própria (Supabase Auth, não o `SimpleAuth`/ORIGINAL_MILES_API_KEY do resto do
  // server) — o frontend manda o access_token do usuário, não a chave estática da API.
  requiresAuth: false,
  openapi: {
    summary: 'Recebe um voucher (imagem/PDF, ou texto já extraído), extrai o tipo e os dados estruturados, e grava na tabela `voucher`',
    description:
      'Substitui o fluxo equivalente em n8n (`travel_agent/extract/vouchers`). Aceita `file` (imagem/PDF, roda OCR primeiro) ' +
      'ou `text` (texto já extraído em outro lugar, pula o OCR) — um dos dois é obrigatório. Pipeline: (texto, via OCR se ' +
      'veio `file`) -> classifica o tipo de voucher (`agents/voucher-type/`) -> extrai os dados estruturados usando o ' +
      'prompt/schema cadastrados para aquele tipo (`agents/voucher-extractor/`) -> grava o resultado na tabela `voucher`, ' +
      'vinculado a `travel_id`.',
    tags: ['Vouchers'],
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

    const form = await c.req.formData();
    const travelId = form.get('travel_id');
    const file = form.get('file');
    const text = form.get('text');
    const extractWithAi = form.get('extract_with_ai');
    const issuer = form.get('issuer');

    if (typeof travelId !== 'string' || !travelId) {
      return c.json({ error: 'bad_request', message: '"travel_id" é obrigatório.' }, 400);
    }
    const hasFile = file instanceof File;
    const hasText = typeof text === 'string' && text.trim().length > 0;
    if (!hasFile && !hasText) {
      return c.json({ error: 'bad_request', message: 'Envie "file" (imagem/PDF) ou "text" (texto já extraído) — um dos dois é obrigatório.' }, 400);
    }
    if (!isVoucherIssuer(issuer)) {
      return c.json({ error: 'bad_request', message: `"issuer" é obrigatório e deve ser um de: ${VOUCHER_ISSUERS.join(', ')}.` }, 400);
    }

    // Default `true`: só pula a extração por IA se vier explicitamente "false".
    const shouldExtractWithAi = extractWithAi !== 'false';
    const metadata = { issuer };

    if (!shouldExtractWithAi) {
      const voucher = await insertVoucher({
        tenantId,
        travelId,
        title: hasFile ? file.name || null : null,
        content: null,
        voucherTypeSlug: FALLBACK_VOUCHER_TYPE_SLUG,
        aiExtractedData: null,
        rawContent: hasText ? text : null,
        metadata,
        fileUrl: null,
      });
      // Sem `ai_extracted_data` (extração pulada), não há nada de novo pro roteiro aprender — não
      // vale a chamada de IA só pra confirmar isso.
      return c.json(voucher, 201);
    }

    const source = hasFile
      ? { file: new Uint8Array(await file.arrayBuffer()), mediaType: file.type || 'application/pdf', fileName: file.name || null }
      : { text: text as string };
    try {
      const voucher = await createExtractedVoucher(tenantId, travelId, userId, source, issuer);
      return c.json(voucher, 201);
    } catch (error) {
      logConversationError(travelId, 'falha ao extrair voucher', error);
      return c.json({ error: 'extraction_failed', message: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
});

export const voucherDeleteRoute = registerApiRoute('/travel_agent/extract/vouchers', {
  method: 'DELETE',
  requiresAuth: false,
  openapi: {
    summary: 'Exclui um voucher e reconstrói o roteiro dia a dia da viagem',
    description: 'Form fields: `travel_id`, `id`. Depois de excluir, remove em background os eventos desse voucher do dia a dia.',
    tags: ['Vouchers'],
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

    const form = await c.req.formData();
    const travelId = form.get('travel_id');
    const voucherId = form.get('id');

    if (typeof travelId !== 'string' || !travelId) {
      return c.json({ error: 'bad_request', message: '"travel_id" é obrigatório.' }, 400);
    }
    if (typeof voucherId !== 'string' || !voucherId) {
      return c.json({ error: 'bad_request', message: '"id" é obrigatório.' }, 400);
    }

    const deleted = await deleteVoucher(tenantId, travelId, voucherId);
    if (!deleted) {
      return c.json({ error: 'not_found', message: `Voucher ${voucherId} não encontrado para a viagem ${travelId}.` }, 404);
    }

    triggerDailyScheduleRemoval(tenantId, travelId, voucherId, userId);
    return c.json({ deleted: true }, 200);
  },
});

export const voucherListRoute = registerApiRoute('/travel_agent/extract/vouchers', {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Lista os vouchers de uma viagem',
    description: 'Recebe `travel_id` via query string. Retorna um array de vouchers no mesmo formato do endpoint de criação (POST).',
    tags: ['Vouchers'],
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

    // Mesmo cuidado de escopo por tenant das outras rotas GET de travel_agent/* (ver
    // `travel-summary-routes.ts`) — `travel_id` sozinho não garante isolamento.
    const travelTenantId = await getTenantIdByTravelId(travelId);
    if (travelTenantId && travelTenantId !== tenantId) {
      return c.json({ error: 'not_found', message: `Viagem ${travelId} não encontrada.` }, 404);
    }

    const vouchers = await getVouchers(tenantId, travelId);
    return c.json(vouchers, 200);
  },
});

const updateBodySchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    travel_id: z.string().min(1),
    title: z.string().nullable().optional(),
    content: z.string().nullable().optional(),
    voucher_type_slug: z.string().min(1).optional(),
    // JSON (serializado) dos dados extraídos — mesmo formato que o front já recebe/edita (ver
    // `original-miles-cartinhas/src/components/cartinhas/vouchers/VoucherDetailModal.tsx`,
    // `JSON.stringify(extracted ?? null)`), não o objeto direto.
    ai_extracted_data: z.string().nullable().optional(),
  })
  .refine(
    (body) =>
      body.title !== undefined || body.content !== undefined || body.voucher_type_slug !== undefined || body.ai_extracted_data !== undefined,
    { message: 'Informe ao menos um campo para atualizar (title, content, voucher_type_slug ou ai_extracted_data).' },
  );

export const voucherUpdateRoute = registerApiRoute('/travel_agent/extract/vouchers', {
  method: 'PUT',
  requiresAuth: false,
  openapi: {
    summary: 'Atualiza campos de um voucher já cadastrado',
    description:
      'Body JSON: `id`, `travel_id` e ao menos um de `title`/`content`/`voucher_type_slug`/`ai_extracted_data` (JSON serializado ' +
      'como string). Só os campos enviados são alterados; envie `null` explícito para limpar um campo. Dispara a mesma atualização ' +
      'incremental de `daily_schedule` do voucher criado/editado pelo agente Ori.',
    tags: ['Vouchers'],
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

    let aiExtractedData: Record<string, unknown> | null | undefined;
    if (body.ai_extracted_data !== undefined) {
      if (body.ai_extracted_data === null) {
        aiExtractedData = null;
      } else {
        try {
          aiExtractedData = JSON.parse(body.ai_extracted_data) as Record<string, unknown>;
        } catch {
          return c.json({ error: 'bad_request', message: '"ai_extracted_data" precisa ser um JSON válido (serializado como string).' }, 400);
        }
      }
    }

    const fields: UpdateVoucherInput = {};
    if (body.title !== undefined) fields.title = body.title;
    if (body.content !== undefined) fields.content = body.content;
    if (body.voucher_type_slug !== undefined) fields.voucherTypeSlug = body.voucher_type_slug;
    if (aiExtractedData !== undefined) fields.aiExtractedData = aiExtractedData;

    const updated = await updateVoucherFields(tenantId, body.travel_id, body.id, fields);
    if (!updated) {
      return c.json({ error: 'not_found', message: `Voucher ${body.id} não encontrado para a viagem ${body.travel_id}.` }, 404);
    }

    triggerDailyScheduleUpdate(
      tenantId,
      body.travel_id,
      { id: updated.id, title: updated.title, voucherTypeSlug: updated.voucher_type_slug, content: updated.content },
      userId,
    );
    return c.json(updated, 200);
  },
});
