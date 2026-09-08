import { registerApiRoute } from '@mastra/core/server';
import { extractVoucher, extractVoucherFromText } from '../agents/voucher-extractor/voucher-extractor';
import { rebuildDailySchedule, updateDailyScheduleForVoucher } from '../agents/daily-schedule/rebuild-daily-schedule';
import { insertVoucher, deleteVoucher, getTenantIdByEmail, type VoucherSummary } from '../services/travel-db';
import { extractBearerToken, verifySupabaseAccessToken, UnauthorizedError } from '../services/supabase-auth';
import { logConversationError } from '../helpers/logger';

// Ambas disparam em background — a resposta HTTP não espera o roteiro terminar de ser
// atualizado/reconstruído (ver AGENTS.md de `agents/daily-schedule/`).
//
// Criar voucher -> update incremental (não reprocessa os outros vouchers da viagem). Excluir
// voucher -> rebuild completo (remover a contribuição de só um voucher de um roteiro montado
// incrementalmente não é confiável — ver comentário em `rebuildDailySchedule`).
function triggerDailyScheduleUpdate(tenantId: string, travelId: string, voucher: VoucherSummary, userId: string): void {
  void updateDailyScheduleForVoucher(tenantId, travelId, voucher, userId).catch((error) =>
    logConversationError(travelId, 'falha ao atualizar daily_schedule', error),
  );
}

function triggerDailyScheduleRebuild(tenantId: string, travelId: string, userId: string): void {
  void rebuildDailySchedule(tenantId, travelId, userId).catch((error) =>
    logConversationError(travelId, 'falha ao reconstruir daily_schedule', error),
  );
}

const FALLBACK_VOUCHER_TYPE_SLUG = 'other';

// Quem criou o voucher: "company" (time da agência) ou "customer" (cliente sozinho, self-service).
// Salvo em `metadata.issuer` (não existe coluna própria pra isso na tabela `voucher`).
const VOUCHER_ISSUERS = ['company', 'customer'] as const;
type VoucherIssuer = (typeof VOUCHER_ISSUERS)[number];

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

    let extraction;
    try {
      if (hasFile) {
        extraction = await extractVoucher(new Uint8Array(await file.arrayBuffer()), file.type || 'application/pdf', tenantId);
      } else if (hasText) {
        extraction = await extractVoucherFromText(text, tenantId);
      } else {
        throw new Error('unreachable: nem "file" nem "text" presentes'); // já validado acima
      }
    } catch (error) {
      logConversationError(travelId, 'falha ao extrair voucher', error);
      return c.json({ error: 'extraction_failed', message: error instanceof Error ? error.message : String(error) }, 500);
    }

    const voucher = await insertVoucher({
      tenantId,
      travelId,
      title:
        typeof extraction.extractedData.document_name === 'string'
          ? extraction.extractedData.document_name
          : (hasFile && file.name) || null,
      content: typeof extraction.extractedData.content === 'string' ? extraction.extractedData.content : null,
      voucherTypeSlug: extraction.voucherTypeSlug,
      aiExtractedData: extraction.extractedData,
      rawContent: extraction.rawContent,
      metadata,
      fileUrl: null,
    });

    triggerDailyScheduleUpdate(
      tenantId,
      travelId,
      {
        id: voucher.id,
        title: voucher.title,
        voucherTypeSlug: voucher.voucher_type_slug,
        content: voucher.content,
      },
      userId,
    );
    return c.json(voucher, 201);
  },
});

export const voucherDeleteRoute = registerApiRoute('/travel_agent/extract/vouchers', {
  method: 'DELETE',
  requiresAuth: false,
  openapi: {
    summary: 'Exclui um voucher e reconstrói o roteiro dia a dia da viagem',
    description: 'Form fields: `travel_id`, `id`. Depois de excluir, dispara `rebuildDailySchedule` em background (mesmo gatilho da extração).',
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

    triggerDailyScheduleRebuild(tenantId, travelId, userId);
    return c.json({ deleted: true }, 200);
  },
});
