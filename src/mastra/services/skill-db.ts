import pg from 'pg';
import { env } from '../config/env';
import { requireEnv } from '../config/require-env';

// Mesmo acesso direto ao Postgres do Supabase de `travel-db.ts`/`company-reference-db.ts` (bypassa
// RLS de propósito — quem chama estas funções já resolveu o `tenantId` via `services/supabase-auth.ts`).
// Pool próprio: `skill` é um domínio à parte, sem relação com viagem/voucher.
let pool: pg.Pool | undefined;

function getPool(): pg.Pool {
  if (!pool) {
    const { SUPABASE_DB_URL } = requireEnv({ SUPABASE_DB_URL: env.SUPABASE_DB_URL }, 'Skill DB');
    pool = new pg.Pool({ connectionString: SUPABASE_DB_URL, max: 5 });
  }
  return pool;
}

// Nomes de campo espelham exatamente o que o frontend já espera (`Skill` em
// `original-miles-cartinhas/src/components/cartinhas/shared/types.ts`) — mistura de snake_case
// (`tenant_id`, `chat_label`, herdados do contrato antigo do webhook n8n) e camelCase (`createdAt`),
// mesmo padrão de `VoucherRecord` em `travel-db.ts`.
export interface SkillRecord {
  id: string;
  tenant_id: string;
  title: string | null;
  chat_label: string | null;
  prompt: string | null;
  active: boolean;
  createdAt: string;
}

const SELECT_COLUMNS = `id, tenant_id, title, chat_label, prompt, active, created_at as "createdAt"`;

// Todas as habilidades do tenant, ativas e inativas — a tela de admin decide o que mostrar/permitir
// editar; o filtro de "só ativa" (pra virar atalho no chat) é feito no próprio frontend.
export async function listSkills(tenantId: string): Promise<SkillRecord[]> {
  const { rows } = await getPool().query<SkillRecord>(`select ${SELECT_COLUMNS} from skill where tenant_id = $1 order by title`, [tenantId]);
  return rows;
}

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface CreateSkillInput {
  tenantId: string;
  title: string;
  chatLabel: string | null;
  prompt: string | null;
  active: boolean;
  createdBy: string;
}

export async function createSkill(input: CreateSkillInput): Promise<SkillRecord> {
  const { rows } = await getPool().query<SkillRecord>(
    `insert into skill (tenant_id, title, chat_label, prompt, active, slug, created_by)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning ${SELECT_COLUMNS}`,
    [input.tenantId, input.title, input.chatLabel, input.prompt, input.active, slugify(input.title), input.createdBy],
  );
  return rows[0];
}

// Update parcial: campos ausentes de `patch` mantêm o valor atual — mesma convenção de
// `updateCompanyReference` (`services/company-reference-db.ts`). O frontend às vezes manda só
// `{ id, active }` (toggle rápido), então não dá pra tratar todo campo como obrigatório no PUT.
export interface UpdateSkillInput {
  title?: string;
  chatLabel?: string | null;
  prompt?: string | null;
  active?: boolean;
}

export async function updateSkill(tenantId: string, id: string, patch: UpdateSkillInput): Promise<SkillRecord | null> {
  const { rows } = await getPool().query<SkillRecord>(
    `update skill set
       title = coalesce($3, title),
       chat_label = case when $4 then $5 else chat_label end,
       prompt = case when $6 then $7 else prompt end,
       active = coalesce($8, active)
     where tenant_id = $1 and id = $2
     returning ${SELECT_COLUMNS}`,
    [tenantId, id, patch.title ?? null, 'chatLabel' in patch, patch.chatLabel ?? null, 'prompt' in patch, patch.prompt ?? null, patch.active ?? null],
  );
  return rows[0] ?? null;
}
