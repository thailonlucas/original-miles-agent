import { registerApiRoute, type ContextWithMastra } from '@mastra/core/server';
import { z } from 'zod';
import {
  addTenantRule,
  decideMemoryCandidate,
  getTeamMemberByEmail,
  getTenantRules,
  getUserMemory,
  isActiveItem,
  itemHits,
  listMemoryCandidates,
  MAX_MEMORY_TEXT,
  removeTenantRule,
  removeUserMemoryItem,
  updateTenantRule,
  updateUserMemoryItem,
  type UserMemoryItem,
} from '../services/ori-memory-db';
import { extractBearerToken, verifySupabaseAccessToken, UnauthorizedError } from '../services/supabase-auth';
import { parseOrBadRequest } from './validate';

// Memória do Ori (ver `services/ori-memory-db.ts`): o consultor vê/edita/apaga a PRÓPRIA memória;
// regras do tenant qualquer membro lê e só admin (`team.role = 'admin'`) altera; candidatas só admin
// vê e decide. Mesmo contrato de autenticação das outras rotas de travel_agent/*.
interface Member {
  tenantId: string;
  userId: string;
  isAdmin: boolean;
}

async function resolveMember(authorizationHeader: string | undefined | null): Promise<Member> {
  const token = extractBearerToken(authorizationHeader);
  const user = await verifySupabaseAccessToken(token);
  const member = await getTeamMemberByEmail(user.email);
  if (!member) {
    throw new UnauthorizedError(`Nenhum tenant encontrado para o e-mail "${user.email}" (tabela team).`);
  }
  return { tenantId: member.tenantId, userId: user.id, isAdmin: member.role === 'admin' };
}

// Autentica e, com `adminOnly`, barra quem não é admin — devolve a resposta de erro pronta ou o membro.
async function authorize(c: ContextWithMastra, adminOnly = false): Promise<Member | Response> {
  let member: Member;
  try {
    member = await resolveMember(c.req.header('Authorization'));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return c.json({ error: 'unauthorized', message: error.message }, 401);
    }
    throw error;
  }
  if (adminOnly && !member.isAdmin) {
    return c.json({ error: 'forbidden', message: 'Só admin do tenant pode fazer isso.' }, 403);
  }
  return member;
}

// Item como a tela mostra: `hits` (em quantas sessões apareceu) e `active` (se já entra no prompt).
const presentItem = (item: UserMemoryItem) => ({ ...item, hits: itemHits(item), active: isActiveItem(item) });

const textSchema = z.string().trim().min(1).max(MAX_MEMORY_TEXT);

export const oriMemoryGetRoute = registerApiRoute('/travel_agent/ori/memory', {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Memória do Ori sobre o consultor autenticado, e as regras do tenant',
    description:
      'Devolve `{ items, tenant_rules }`. `items`: o que o Ori aprendeu sobre como este consultor trabalha (`source` "explicito" = ' +
      'pedido por ele; "aprendido" = percebido nas conversas), com `hits` (sessões em que apareceu), `evidence` (ids das sessões) e ' +
      '`active` (aprendido só entra no prompt depois de visto em 2 sessões). `tenant_rules`: regras da agência, pra todos.',
    tags: ['Ori'],
  },
  handler: async (c) => {
    const member = await authorize(c);
    if (member instanceof Response) return member;
    const [items, tenantRules] = await Promise.all([getUserMemory(member.tenantId, member.userId), getTenantRules(member.tenantId)]);
    return c.json({ items: items.map(presentItem), tenant_rules: tenantRules }, 200);
  },
});

export const oriMemoryUpdateRoute = registerApiRoute('/travel_agent/ori/memory/:itemId', {
  method: 'PATCH',
  requiresAuth: false,
  openapi: {
    summary: 'Edita um item da memória do consultor autenticado',
    description: 'Body: `{ text }`. Editar confirma o item: ele passa a "explicito" e entra no prompt na hora.',
    tags: ['Ori'],
  },
  handler: async (c) => {
    const member = await authorize(c);
    if (member instanceof Response) return member;
    const body = parseOrBadRequest(z.object({ text: textSchema }), await c.req.json().catch(() => null), c);
    if (body instanceof Response) return body;
    const item = await updateUserMemoryItem(member.tenantId, member.userId, c.req.param('itemId'), body.text);
    return item ? c.json(presentItem(item), 200) : c.json({ error: 'not_found', message: 'Item não encontrado.' }, 404);
  },
});

export const oriMemoryDeleteRoute = registerApiRoute('/travel_agent/ori/memory/:itemId', {
  method: 'DELETE',
  requiresAuth: false,
  openapi: {
    summary: 'Apaga um item da memória do consultor autenticado',
    description: 'O Ori para de seguir essa preferência a partir da próxima mensagem.',
    tags: ['Ori'],
  },
  handler: async (c) => {
    const member = await authorize(c);
    if (member instanceof Response) return member;
    const removed = await removeUserMemoryItem(member.tenantId, member.userId, c.req.param('itemId'));
    return removed ? c.json({ deleted: true }, 200) : c.json({ error: 'not_found', message: 'Item não encontrado.' }, 404);
  },
});

export const oriTenantRuleCreateRoute = registerApiRoute('/travel_agent/ori/tenant-rules', {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Cria uma regra do Ori pra todos os consultores do tenant (admin)',
    description: 'Body: `{ text, required? }`. `required: true` = a preferência de um consultor não pode contrariar.',
    tags: ['Ori'],
  },
  handler: async (c) => {
    const member = await authorize(c, true);
    if (member instanceof Response) return member;
    const body = parseOrBadRequest(z.object({ text: textSchema, required: z.boolean().optional() }), await c.req.json().catch(() => null), c);
    if (body instanceof Response) return body;
    const result = await addTenantRule(member.tenantId, member.userId, body.text, body.required ?? false);
    return 'error' in result ? c.json({ error: 'limit_reached', message: result.error }, 409) : c.json(result.rule, 201);
  },
});

export const oriTenantRuleUpdateRoute = registerApiRoute('/travel_agent/ori/tenant-rules/:ruleId', {
  method: 'PATCH',
  requiresAuth: false,
  openapi: {
    summary: 'Edita uma regra do Ori do tenant (admin)',
    description: 'Body: `{ text?, required? }`.',
    tags: ['Ori'],
  },
  handler: async (c) => {
    const member = await authorize(c, true);
    if (member instanceof Response) return member;
    const body = parseOrBadRequest(
      z.object({ text: textSchema.optional(), required: z.boolean().optional() }),
      await c.req.json().catch(() => null),
      c,
    );
    if (body instanceof Response) return body;
    const rule = await updateTenantRule(member.tenantId, c.req.param('ruleId'), body);
    return rule ? c.json(rule, 200) : c.json({ error: 'not_found', message: 'Regra não encontrada.' }, 404);
  },
});

export const oriTenantRuleDeleteRoute = registerApiRoute('/travel_agent/ori/tenant-rules/:ruleId', {
  method: 'DELETE',
  requiresAuth: false,
  openapi: {
    summary: 'Remove uma regra do Ori do tenant (admin)',
    description: 'Vale pra todos os consultores a partir da próxima mensagem.',
    tags: ['Ori'],
  },
  handler: async (c) => {
    const member = await authorize(c, true);
    if (member instanceof Response) return member;
    const deleted = await removeTenantRule(member.tenantId, c.req.param('ruleId'));
    return deleted ? c.json({ deleted: true }, 200) : c.json({ error: 'not_found', message: 'Regra não encontrada.' }, 404);
  },
});

const candidateStatusSchema = z.enum(['pending', 'accepted_tenant', 'accepted_base', 'rejected']);

export const oriMemoryCandidateListRoute = registerApiRoute('/travel_agent/ori/memory-candidates', {
  method: 'GET',
  requiresAuth: false,
  openapi: {
    summary: 'Candidatas a regra do tenant / ajuste do prompt base (admin)',
    description:
      'Query opcional: `status` (default "pending"; "all" pra todas). Correções que o learner viu e que parecem valer além de um ' +
      'consultor. `scope_hint`: "tenant" (jeito da agência) ou "base" (defeito do Ori pra todos — vira tarefa pro time de dev). ' +
      'Ordenadas por quantas sessões apareceram (`evidence`).',
    tags: ['Ori'],
  },
  handler: async (c) => {
    const member = await authorize(c, true);
    if (member instanceof Response) return member;
    const rawStatus = c.req.query('status') ?? 'pending';
    const status = rawStatus === 'all' ? null : candidateStatusSchema.safeParse(rawStatus);
    if (status && !status.success) {
      return c.json({ error: 'bad_request', message: '"status" inválido.' }, 400);
    }
    const candidates = await listMemoryCandidates(member.tenantId, status ? status.data : null);
    return c.json({ candidates }, 200);
  },
});

export const oriMemoryCandidateDecisionRoute = registerApiRoute('/travel_agent/ori/memory-candidates/:candidateId/decision', {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Decide uma candidata (admin)',
    description:
      'Body: `{ decision: "tenant" | "base" | "rejected", text?, required? }`. "tenant" cria a regra do tenant na hora (com `text` ' +
      'ajustado, se enviado). "base" só marca como aceita — o ajuste no prompt base é código, feito pelo time de dev. "rejected" descarta.',
    tags: ['Ori'],
  },
  handler: async (c) => {
    const member = await authorize(c, true);
    if (member instanceof Response) return member;
    const body = parseOrBadRequest(
      z.object({ decision: z.enum(['tenant', 'base', 'rejected']), text: textSchema.optional(), required: z.boolean().optional() }),
      await c.req.json().catch(() => null),
      c,
    );
    if (body instanceof Response) return body;

    const candidateId = c.req.param('candidateId');
    const pending = (await listMemoryCandidates(member.tenantId, 'pending')).find((cand) => cand.id === candidateId);
    if (!pending) {
      return c.json({ error: 'not_found', message: 'Candidata pendente não encontrada.' }, 404);
    }

    // Regra antes da decisão: com o limite de regras cheio, a candidata continua pendente.
    let rule = null;
    if (body.decision === 'tenant') {
      const result = await addTenantRule(member.tenantId, member.userId, body.text ?? pending.text, body.required ?? false);
      if ('error' in result) return c.json({ error: 'limit_reached', message: result.error }, 409);
      rule = result.rule;
    }
    const status = body.decision === 'tenant' ? 'accepted_tenant' : body.decision === 'base' ? 'accepted_base' : 'rejected';
    const candidate = await decideMemoryCandidate(member.tenantId, candidateId, status, member.userId);
    return c.json({ candidate, ...(rule ? { rule } : {}) }, 200);
  },
});
