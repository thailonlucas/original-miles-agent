import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { askOri, decideOriToolCall } from '../agents/ori/ori-agent';
import { randomUUID } from 'node:crypto';
import type { OriResponse } from '../agents/ori/schema';
import {
  appendOriChatMessages,
  getOriChatSession,
  getTenantIdByEmail,
  getTenantIdByTravelId,
  listOriChatSessions,
  recordOriApprovalDecision,
  type OriChatMessage,
} from '../services/travel-db';
import { extractBearerToken, verifySupabaseAccessToken, UnauthorizedError } from '../services/supabase-auth';
import { logConversationError } from '../helpers/logger';
import { triggerOriMemoryLearning } from '../agents/ori-memory-learner/ori-memory-learner-trigger';
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

// Quantas sessões anteriores o drawer do chat lista pra retomar (`GET /travel_agent/ori/sessions`).
const RECENT_SESSIONS_LIMIT = 5;

// Bolha de resposta do Ori no formato do histórico (`ori_chat_session`), com o `tool_call_id` do
// cartão de aprovação quando a resposta pausou — é por ele que a decisão é registrada depois.
function assistantHistoryMessage(result: OriResponse): OriChatMessage {
  return {
    id: randomUUID(),
    role: 'assistant',
    raw: JSON.stringify(result),
    ...(result.pending_approval ? { tool_call_id: result.pending_approval.tool_call_id } : {}),
    created_at: new Date().toISOString(),
  };
}

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
      // Histórico é best-effort: uma falha ao gravar não pode derrubar a resposta que o Ori já gerou
      // (e cujas tools de escrita já rodaram).
      const now = new Date().toISOString();
      await appendOriChatMessages(
        tenantId,
        travelId,
        userId,
        sessionId,
        [{ id: randomUUID(), role: 'user', content: prompt, created_at: now }, assistantHistoryMessage(result)],
        prompt,
      ).catch((error) => logConversationError(travelId, `Ori: falha ao gravar histórico (session_id ${sessionId})`, error));
      // Depois do histórico gravado: o learner lê a sessão de `ori_chat_session`.
      triggerOriMemoryLearning(tenantId, travelId, userId, sessionId);
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
  // Sessão do chat onde o cartão de aprovação apareceu — quando vem, a decisão e a resposta
  // seguinte entram no histórico dela (`ori_chat_session`). Opcional pra não quebrar clientes antigos.
  session_id: z.string().min(1).optional(),
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
      'vir com um novo `pending_approval` se o model encadear outra tool sensível em seguida. `session_id` opcional grava a decisão e a ' +
      'resposta no histórico da sessão (ver `GET /travel_agent/ori/sessions`).',
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

    const rawBody = await c.req.json().catch(() => null);
    const body = parseOrBadRequest(approvalBodySchema, rawBody, c);
    if (body instanceof Response) return body;

    const travelTenantId = await getTenantIdByTravelId(body.travel_id);
    if (travelTenantId && travelTenantId !== tenantId) {
      return c.json({ error: 'not_found', message: `Viagem ${body.travel_id} não encontrada.` }, 404);
    }

    try {
      const result = await decideOriToolCall(tenantId, body.travel_id, body.run_id, body.tool_call_id, body.approved, body.reason);
      if (body.session_id) {
        await recordOriApprovalDecision(
          tenantId,
          body.travel_id,
          userId,
          body.session_id,
          body.tool_call_id,
          body.approved ? 'approved' : 'rejected',
          assistantHistoryMessage(result),
        ).catch((error) => logConversationError(body.travel_id, `Ori: falha ao gravar decisão no histórico (session_id ${body.session_id})`, error));
      }
      return c.json(result, 200);
    } catch (error) {
      logConversationError(body.run_id, `Ori: falha ao ${body.approved ? 'aprovar' : 'recusar'} tool call ${body.tool_call_id}`, error);
      return c.json({ error: 'ori_approval_failed', message: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
});

export const oriSessionListRoute = registerApiRoute('/travel_agent/ori/sessions', {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Lista as últimas sessões de chat do Ori do usuário autenticado numa viagem',
    description:
      `Query: \`travel_id\`. Devolve \`{ sessions }\` com as ${RECENT_SESSIONS_LIMIT} sessões mais recentes (por última mensagem) do ` +
      'consultor autenticado nesta viagem: `session_id`, `title` (primeiro prompt), `message_count`, `created_at`, `updated_at`. ' +
      'Pra retomar uma, busque as mensagens em `GET /travel_agent/ori/sessions/:sessionId` e continue mandando o mesmo `session_id` ' +
      'em `POST /travel_agent/ori` — a memória do agente é a mesma thread.',
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

    const travelId = c.req.query('travel_id');
    if (!travelId) {
      return c.json({ error: 'bad_request', message: '"travel_id" é obrigatório.' }, 400);
    }

    const sessions = await listOriChatSessions(tenantId, travelId, userId, RECENT_SESSIONS_LIMIT);
    return c.json({ sessions }, 200);
  },
});

export const oriSessionGetRoute = registerApiRoute('/travel_agent/ori/sessions/:sessionId', {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Busca a transcrição de uma sessão de chat do Ori, pra retomar a conversa',
    description:
      'Query: `travel_id`. Devolve a sessão com `messages` no formato que o drawer renderiza: `{ role: "user", content }` ou ' +
      '`{ role: "assistant", raw, tool_call_id?, approval_decision? }` — `raw` é o envelope de `POST /travel_agent/ori` serializado ' +
      '(pode trazer `pending_approval`; `approval_decision` diz se o cartão já foi decidido). 404 se a sessão não for do usuário autenticado.',
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

    const travelId = c.req.query('travel_id');
    if (!travelId) {
      return c.json({ error: 'bad_request', message: '"travel_id" é obrigatório.' }, 400);
    }

    const sessionId = c.req.param('sessionId');
    const session = await getOriChatSession(tenantId, travelId, userId, sessionId);
    if (!session) {
      return c.json({ error: 'not_found', message: `Sessão ${sessionId} não encontrada.` }, 404);
    }
    return c.json(session, 200);
  },
});
