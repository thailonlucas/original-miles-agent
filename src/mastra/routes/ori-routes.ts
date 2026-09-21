import { registerApiRoute } from '@mastra/core/server';
import { askOri } from '../agents/ori/ori-agent';
import { getTenantIdByEmail, getTenantIdByTravelId } from '../services/travel-db';
import { extractBearerToken, verifySupabaseAccessToken, UnauthorizedError } from '../services/supabase-auth';
import { logConversationError } from '../helpers/logger';

// Mesmo contrato de autenticação das outras rotas de travel_agent (ver `voucher-routes.ts` /
// `schedule-suggestion-routes.ts`): o frontend manda o access_token do Supabase Auth do usuário
// (`Authorization: Bearer <access_token>`), não a chave estática (`ORIGINAL_MILES_API_KEY`).
async function resolveTenantId(authorizationHeader: string | undefined | null): Promise<{ tenantId: string; userId: string }> {
  const token = extractBearerToken(authorizationHeader);
  const user = await verifySupabaseAccessToken(token);
  const tenantId = await getTenantIdByEmail(user.email);
  if (!tenantId) {
    throw new UnauthorizedError(`Nenhum tenant encontrado para o e-mail "${user.email}" (tabela team).`);
  }
  return { tenantId, userId: user.id };
}

// Corta um prompt absurdamente longo em vez de rejeitar — mesmo raciocínio de
// `schedule-suggestion-routes.ts`, mas com limite maior (mensagem de chat, não um pedido curto).
const MAX_PROMPT_LENGTH = 4000;

export const oriChatRoute = registerApiRoute('/travel_agent/ori', {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Conversa com o Ori, o agente da Original Miles usado pelos consultores para consultar/montar o roteiro de uma viagem',
    description:
      'Form fields: `travel_id`, `session_id`, `prompt`. Injeta a lista de vouchers já extraídos da viagem (id/title/content) no contexto ' +
      'do agente e devolve a resposta gerada. `session_id` isola a memória de conversa (o Ori lembra do que já foi dito na mesma ' +
      'sessão, inclusive para confirmar a criação de um voucher pedida numa mensagem anterior). O Ori pode buscar, criar, atualizar ' +
      'e excluir vouchers da viagem através de tools próprias, sempre escopadas ao tenant/viagem do usuário autenticado.',
    tags: ['Ori'],
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

    // Form fields (multipart/form-data), não JSON — mesmo contrato de `voucher-routes.ts`: o
    // frontend hoje monta um `FormData` (`travel_id`/`prompt`/`session_id`) pra este endpoint,
    // herdado do webhook n8n original que ele substitui.
    const form = await c.req.formData();
    const travelId = form.get('travel_id');
    const sessionId = form.get('session_id');
    const rawPrompt = form.get('prompt');

    if (typeof travelId !== 'string' || !travelId) {
      return c.json({ error: 'bad_request', message: '"travel_id" é obrigatório.' }, 400);
    }
    if (typeof sessionId !== 'string' || !sessionId) {
      return c.json({ error: 'bad_request', message: '"session_id" é obrigatório.' }, 400);
    }
    if (typeof rawPrompt !== 'string' || !rawPrompt.trim()) {
      return c.json({ error: 'bad_request', message: '"prompt" é obrigatório.' }, 400);
    }
    const prompt = rawPrompt.trim().slice(0, MAX_PROMPT_LENGTH);

    // `travel_id` sozinho não escopa por tenant — mesmo cuidado de `schedule-suggestion-routes.ts`/
    // `daily-schedule-routes.ts`: confirma que, SE a viagem já existir em `travel`, ela pertence ao
    // tenant autenticado. `travelTenantId` null (viagem ainda sem linha em `travel`) segue em
    // frente, sem vouchers pra injetar no contexto ainda.
    const travelTenantId = await getTenantIdByTravelId(travelId);
    if (travelTenantId && travelTenantId !== tenantId) {
      return c.json({ error: 'not_found', message: `Viagem ${travelId} não encontrada.` }, 404);
    }

    try {
      const result = await askOri(tenantId, travelId, userId, sessionId, prompt);
      return c.json(result, 200);
    } catch (error) {
      logConversationError(travelId, `Ori: falha ao gerar resposta (session_id ${sessionId})`, error);
      return c.json({ error: 'ori_failed', message: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
});
