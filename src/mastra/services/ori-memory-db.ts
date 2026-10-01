import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { requireEnv } from '../config/require-env';

// Memória do Ori em três camadas (ver `sql/ori_memory.sql`): prompt base (código, todos os tenants),
// regras do tenant (`ori_tenant_memory`) e preferências de cada consultor (`ori_user_memory`), mais
// as candidatas a subir de camada (`ori_memory_candidate`). Mesmo acesso direto ao Postgres de
// `travel-db.ts` (bypassa RLS — quem chama já resolveu tenant/usuário). Pool próprio porque é um
// domínio à parte, sem relação com viagem/voucher.
let pool: pg.Pool | undefined;

function getPool(): pg.Pool {
  if (!pool) {
    const { SUPABASE_DB_URL } = requireEnv({ SUPABASE_DB_URL: env.SUPABASE_DB_URL }, 'Ori Memory DB');
    pool = new pg.Pool({ connectionString: SUPABASE_DB_URL, max: 3 });
  }
  return pool;
}

export const USER_MEMORY_KINDS = ['conversa', 'cards', 'fluxo', 'vocabulario'] as const;
export type UserMemoryKind = (typeof USER_MEMORY_KINDS)[number];

export type UserMemorySource = 'explicito' | 'aprendido';

export interface UserMemoryItem {
  id: string;
  text: string;
  kind: UserMemoryKind;
  // "explicito": o consultor pediu ("sempre...", "nunca...") ou editou pela tela — vale na hora.
  // "aprendido": o `ori-memory-learner` percebeu sozinho — só vale depois de aparecer em
  // `LEARNED_MIN_SESSIONS` sessões diferentes.
  source: UserMemorySource;
  // Sessões em que o padrão apareceu. `hits` = tamanho da lista (calculado, nunca guardado), então a
  // mesma sessão analisada duas vezes não conta duas vezes, e dá pra abrir a conversa de origem.
  evidence: string[];
  created_at: string;
  updated_at: string;
}

export interface TenantMemoryRule {
  id: string;
  text: string;
  // Obrigatória: a preferência de um consultor não pode contrariar. Não obrigatória: é o padrão da
  // agência, que o consultor pode ajustar pro próprio jeito.
  required: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type CandidateStatus = 'pending' | 'accepted_tenant' | 'accepted_base' | 'rejected';

export interface MemoryCandidate {
  id: string;
  tenant_id: string;
  text: string;
  kind: string;
  scope_hint: 'tenant' | 'base';
  reason: string | null;
  evidence: { user_id: string; session_id: string }[];
  status: CandidateStatus;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

// Padrão aprendido (não pedido) só entra no prompt depois de visto em 2 sessões — um caso isolado
// não vira regra.
export const LEARNED_MIN_SESSIONS = 2;
// Tetos pra memória caber inteira no prompt de toda chamada.
export const MAX_USER_ITEMS = 15;
export const MAX_TENANT_RULES = 20;
// Folgado pra caber um modelo de card inteiro que o consultor colou ("TAP Air Portugal • TP 0824 ...").
export const MAX_MEMORY_TEXT = 1000;

export const itemHits = (item: UserMemoryItem): number => item.evidence.length;

export const isActiveItem = (item: UserMemoryItem): boolean => item.source === 'explicito' || itemHits(item) >= LEARNED_MIN_SESSIONS;

export const normalizeMemoryText = (text: string): string =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.!;]+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();

export function newUserMemoryItem(text: string, kind: UserMemoryKind, source: UserMemorySource, sessionId?: string): UserMemoryItem {
  const now = new Date().toISOString();
  return { id: randomUUID(), text: text.trim().slice(0, MAX_MEMORY_TEXT), kind, source, evidence: sessionId ? [sessionId] : [], created_at: now, updated_at: now };
}

// Estourou o teto: sai primeiro o aprendido com menos sessões e há mais tempo sem aparecer. Item
// explícito nunca sai sozinho — se só sobrar explícito, quem chama recusa a inclusão.
export function trimUserMemory(items: UserMemoryItem[]): UserMemoryItem[] {
  if (items.length <= MAX_USER_ITEMS) return items;
  const removable = items
    .filter((i) => i.source === 'aprendido')
    .sort((a, b) => itemHits(a) - itemHits(b) || a.updated_at.localeCompare(b.updated_at));
  const drop = new Set(removable.slice(0, items.length - MAX_USER_ITEMS).map((i) => i.id));
  return items.filter((i) => !drop.has(i.id));
}

// --- Team ---

export interface TeamMember {
  tenantId: string;
  role: string | null;
}

export async function getTeamMemberByEmail(email: string): Promise<TeamMember | null> {
  const { rows } = await getPool().query<{ tenant_id: string | null; role: string | null }>(
    `select tenant_id, role from team where email = $1 limit 1`,
    [email],
  );
  const row = rows[0];
  return row?.tenant_id ? { tenantId: row.tenant_id, role: row.role } : null;
}

// --- Memória do consultor ---

export async function getUserMemory(tenantId: string, userId: string): Promise<UserMemoryItem[]> {
  const { rows } = await getPool().query<{ items: UserMemoryItem[] }>(
    `select items from ori_user_memory where tenant_id = $1 and user_id = $2`,
    [tenantId, userId],
  );
  return rows[0]?.items ?? [];
}

// Lê, transforma e grava na mesma transação, com a linha travada — o Ori (tool, na conversa) e o
// `ori-memory-learner` (em background) podem escrever ao mesmo tempo na memória do mesmo consultor.
// `mutate` devolve a lista nova; devolver a mesma referência significa "nada mudou" (não grava).
export async function mutateUserMemory<T>(
  tenantId: string,
  userId: string,
  mutate: (items: UserMemoryItem[]) => { items: UserMemoryItem[]; result: T },
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into ori_user_memory (tenant_id, user_id) values ($1, $2) on conflict (tenant_id, user_id) do nothing`,
      [tenantId, userId],
    );
    const { rows } = await client.query<{ items: UserMemoryItem[] }>(
      `select items from ori_user_memory where tenant_id = $1 and user_id = $2 for update`,
      [tenantId, userId],
    );
    const current = rows[0]?.items ?? [];
    const { items, result } = mutate(current);
    if (items !== current) {
      await client.query(`update ori_user_memory set items = $3::jsonb, updated_at = now() where tenant_id = $1 and user_id = $2`, [
        tenantId,
        userId,
        JSON.stringify(items),
      ]);
    }
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

// O formato de card que ESTE consultor pediu (itens ativos, kind "cards") — vai pros prompts de todo
// caminho que escreve card (`formatCardPreferences`, `daily-schedule/event-format.ts`). Memória é
// complemento: falha ao ler não derruba a geração, só cai no formato padrão.
export async function getCardPreferences(tenantId: string, userId: string): Promise<string[]> {
  try {
    const items = await getUserMemory(tenantId, userId);
    return items.filter((i) => i.kind === 'cards' && isActiveItem(i)).map((i) => i.text);
  } catch (error) {
    console.error(`[memória do Ori] falha ao ler preferências de card do usuário ${userId}`, error);
    return [];
  }
}

// Pedido explícito do consultor (tool `anotarPreferenciaConsultor`). Se já existe um item com o
// mesmo texto, ele vira explícito e ganha a sessão como evidência, em vez de duplicar.
export async function addExplicitUserMemory(
  tenantId: string,
  userId: string,
  text: string,
  kind: UserMemoryKind,
  sessionId?: string,
): Promise<{ item: UserMemoryItem } | { error: string }> {
  return mutateUserMemory<{ item: UserMemoryItem } | { error: string }>(tenantId, userId, (items) => {
    const key = normalizeMemoryText(text);
    const existing = items.find((i) => normalizeMemoryText(i.text) === key);
    const now = new Date().toISOString();
    if (existing) {
      const item: UserMemoryItem = {
        ...existing,
        source: 'explicito',
        evidence: sessionId && !existing.evidence.includes(sessionId) ? [...existing.evidence, sessionId] : existing.evidence,
        updated_at: now,
      };
      return { items: items.map((i) => (i.id === existing.id ? item : i)), result: { item } };
    }
    const item = newUserMemoryItem(text, kind, 'explicito', sessionId);
    const next = trimUserMemory([...items, item]);
    if (!next.some((i) => i.id === item.id) || next.length > MAX_USER_ITEMS) {
      return {
        items,
        result: { error: `A memória deste consultor está cheia (${MAX_USER_ITEMS} preferências). Peça pra ele remover alguma antes.` },
      };
    }
    return { items: next, result: { item } };
  });
}

// Editar pela tela confirma o item: vira explícito.
export async function updateUserMemoryItem(tenantId: string, userId: string, itemId: string, text: string): Promise<UserMemoryItem | null> {
  return mutateUserMemory(tenantId, userId, (items) => {
    const current = items.find((i) => i.id === itemId);
    if (!current) return { items, result: null };
    const item: UserMemoryItem = { ...current, text: text.trim().slice(0, MAX_MEMORY_TEXT), source: 'explicito', updated_at: new Date().toISOString() };
    return { items: items.map((i) => (i.id === itemId ? item : i)), result: item };
  });
}

export async function removeUserMemoryItem(tenantId: string, userId: string, itemId: string): Promise<UserMemoryItem | null> {
  return mutateUserMemory(tenantId, userId, (items) => {
    const removed = items.find((i) => i.id === itemId) ?? null;
    return { items: removed ? items.filter((i) => i.id !== itemId) : items, result: removed };
  });
}

// --- Regras do tenant ---

export async function getTenantRules(tenantId: string): Promise<TenantMemoryRule[]> {
  const { rows } = await getPool().query<{ items: TenantMemoryRule[] }>(`select items from ori_tenant_memory where tenant_id = $1`, [tenantId]);
  return rows[0]?.items ?? [];
}

async function mutateTenantRules<T>(tenantId: string, mutate: (rules: TenantMemoryRule[]) => { rules: TenantMemoryRule[]; result: T }): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query(`insert into ori_tenant_memory (tenant_id) values ($1) on conflict (tenant_id) do nothing`, [tenantId]);
    const { rows } = await client.query<{ items: TenantMemoryRule[] }>(`select items from ori_tenant_memory where tenant_id = $1 for update`, [tenantId]);
    const current = rows[0]?.items ?? [];
    const { rules, result } = mutate(current);
    if (rules !== current) {
      await client.query(`update ori_tenant_memory set items = $2::jsonb, updated_at = now() where tenant_id = $1`, [tenantId, JSON.stringify(rules)]);
    }
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function addTenantRule(
  tenantId: string,
  userId: string,
  text: string,
  required: boolean,
): Promise<{ rule: TenantMemoryRule } | { error: string }> {
  return mutateTenantRules<{ rule: TenantMemoryRule } | { error: string }>(tenantId, (rules) => {
    if (rules.length >= MAX_TENANT_RULES) {
      return { rules, result: { error: `O tenant já tem ${MAX_TENANT_RULES} regras. Remova alguma antes.` } };
    }
    const now = new Date().toISOString();
    const rule: TenantMemoryRule = { id: randomUUID(), text: text.trim().slice(0, MAX_MEMORY_TEXT), required, created_by: userId, created_at: now, updated_at: now };
    return { rules: [...rules, rule], result: { rule } };
  });
}

export async function updateTenantRule(
  tenantId: string,
  ruleId: string,
  patch: { text?: string; required?: boolean },
): Promise<TenantMemoryRule | null> {
  return mutateTenantRules(tenantId, (rules) => {
    const current = rules.find((r) => r.id === ruleId);
    if (!current) return { rules, result: null };
    const rule: TenantMemoryRule = {
      ...current,
      ...(patch.text !== undefined ? { text: patch.text.trim().slice(0, MAX_MEMORY_TEXT) } : {}),
      ...(patch.required !== undefined ? { required: patch.required } : {}),
      updated_at: new Date().toISOString(),
    };
    return { rules: rules.map((r) => (r.id === ruleId ? rule : r)), result: rule };
  });
}

export async function removeTenantRule(tenantId: string, ruleId: string): Promise<boolean> {
  return mutateTenantRules(tenantId, (rules) => {
    const exists = rules.some((r) => r.id === ruleId);
    return { rules: exists ? rules.filter((r) => r.id !== ruleId) : rules, result: exists };
  });
}

// --- Candidatas a regra do tenant / prompt base ---

const CANDIDATE_COLUMNS = `id, tenant_id, text, kind, scope_hint, reason, evidence, status, decided_by, decided_at, created_at, updated_at`;

export async function listMemoryCandidates(tenantId: string, status: CandidateStatus | null): Promise<MemoryCandidate[]> {
  const { rows } = await getPool().query<MemoryCandidate>(
    `select ${CANDIDATE_COLUMNS} from ori_memory_candidate
     where tenant_id = $1 and ($2::text is null or status = $2)
     order by jsonb_array_length(evidence) desc, updated_at desc`,
    [tenantId, status],
  );
  return rows;
}

// Acrescenta a evidência numa candidata pendente que já existe (`existingId`, escolhido pelo
// learner, ou o mesmo texto normalizado) ou cria uma nova. A mesma sessão nunca conta duas vezes.
export async function upsertMemoryCandidate(
  tenantId: string,
  input: { existingId: string | null; text: string; kind: string; scopeHint: 'tenant' | 'base'; reason: string | null },
  evidence: { user_id: string; session_id: string },
): Promise<void> {
  const pending = await listMemoryCandidates(tenantId, 'pending');
  const key = normalizeMemoryText(input.text);
  const match = pending.find((c) => c.id === input.existingId) ?? pending.find((c) => normalizeMemoryText(c.text) === key);
  if (match) {
    if (match.evidence.some((e) => e.session_id === evidence.session_id)) return;
    await getPool().query(
      `update ori_memory_candidate set evidence = evidence || $3::jsonb, updated_at = now() where tenant_id = $1 and id = $2 and status = 'pending'`,
      [tenantId, match.id, JSON.stringify([evidence])],
    );
    return;
  }
  await getPool().query(
    `insert into ori_memory_candidate (tenant_id, text, kind, scope_hint, reason, evidence) values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [tenantId, input.text.trim().slice(0, MAX_MEMORY_TEXT), input.kind, input.scopeHint, input.reason, JSON.stringify([evidence])],
  );
}

export async function decideMemoryCandidate(
  tenantId: string,
  candidateId: string,
  status: Exclude<CandidateStatus, 'pending'>,
  decidedBy: string,
): Promise<MemoryCandidate | null> {
  const { rows } = await getPool().query<MemoryCandidate>(
    `update ori_memory_candidate set status = $3, decided_by = $4, decided_at = now(), updated_at = now()
     where tenant_id = $1 and id = $2 and status = 'pending'
     returning ${CANDIDATE_COLUMNS}`,
    [tenantId, candidateId, status, decidedBy],
  );
  return rows[0] ?? null;
}
