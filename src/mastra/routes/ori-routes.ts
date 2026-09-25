import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { askOri, decideOriToolCall } from '../agents/ori/ori-agent';
import { getTenantIdByEmail, getTenantIdByTravelId } from '../services/travel-db';
import { extractBearerToken, verifySupabaseAccessToken, UnauthorizedError } from '../services/supabase-auth';
import { logConversationError } from '../helpers/logger';
import { parseOrBadRequest } from './validate';

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
      'e excluir vouchers da viagem através de tools próprias, sempre escopadas ao tenant/viagem do usuário autenticado. A resposta ' +
      'inclui `updated_data` (boolean, calculado pelo backend, não pela IA): `true` quando esta resposta chamou alguma tool de ' +
      'escrita (voucher, evento do dia a dia, contexto da viagem ou sugestões) — sinal pro front saber que precisa recarregar os ' +
      'dados da viagem, sem indicar especificamente o que mudou. Se a resposta trouxer `pending_approval`, a geração pausou numa ' +
      'tool sensível (`decidirSugestao`/`adicionarSugestaoAoDiaADia`) esperando confirmação — resolva com ' +
      '`POST /travel_agent/ori/approval` antes de mandar a próxima mensagem normal.',
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

const approvalBodySchema = z.object({
  travel_id: z.string().min(1),
  run_id: z.string().min(1),
  tool_call_id: z.string().min(1),
  approved: z.boolean(),
  // Só relevante quando `approved: false` — motivo que o consultor deu pra recusar, devolvido ao
  // model no lugar do resultado da tool (ver `declineToolCallGenerate` do Mastra).
  reason: z.string().max(500).optional(),
});

export const oriApprovalRoute = registerApiRoute('/travel_agent/ori/approval', {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Aprova ou recusa uma tool call do Ori que pausou esperando confirmação',
    description:
      'Recebe `travel_id`, `run_id`/`tool_call_id` (do `pending_approval` de uma resposta anterior de `POST /travel_agent/ori`), `approved` e ' +
      '`reason` opcional (quando recusado). Devolve o MESMO envelope de `POST /travel_agent/ori` — se aprovada, a tool roda de ' +
      'verdade e a resposta final do Ori vem preenchida; se recusada, o model recebe o motivo e responde sem executar a tool. Pode ' +
      'vir com um novo `pending_approval` se o model encadear outra tool sensível em seguida.',
    tags: ['Ori'],
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

    const rawBody = await c.req.json().catch(() => null);
    const body = parseOrBadRequest(approvalBodySchema, rawBody, c);
    if (body instanceof Response) return body;

    const travelTenantId = await getTenantIdByTravelId(body.travel_id);
    if (travelTenantId && travelTenantId !== tenantId) {
      return c.json({ error: 'not_found', message: `Viagem ${body.travel_id} não encontrada.` }, 404);
    }

    try {
      const result = await decideOriToolCall(tenantId, body.travel_id, body.run_id, body.tool_call_id, body.approved, body.reason);
      return c.json(result, 200);
    } catch (error) {
      logConversationError(body.run_id, `Ori: falha ao ${body.approved ? 'aprovar' : 'recusar'} tool call ${body.tool_call_id}`, error);
      return c.json({ error: 'ori_approval_failed', message: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
});
