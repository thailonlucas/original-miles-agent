import pg from 'pg';
import { env } from '../config/env';
import { requireEnv } from '../config/require-env';

// Mesmo acesso direto ao Postgres do Supabase de `travel-db.ts` (bypassa RLS de propósito — quem
// chama estas funções já resolveu o `tenantId` via `services/supabase-auth.ts`). Pool próprio,
// mesma razão de `skill-db.ts`/`company-reference-db.ts`.
let pool: pg.Pool | undefined;

function getPool(): pg.Pool {
  if (!pool) {
    const { SUPABASE_DB_URL } = requireEnv({ SUPABASE_DB_URL: env.SUPABASE_DB_URL }, 'Voucher Type DB');
    pool = new pg.Pool({ connectionString: SUPABASE_DB_URL, max: 5 });
  }
  return pool;
}

// Nomes de campo em snake_case direto (sem camelCase) — espelha exatamente `VoucherType` em
// `original-miles-cartinhas/src/components/cartinhas/shared/types.ts`, herdado do contrato antigo
// do webhook n8n. `structured_output` é jsonb "normal" (objeto, não string duplamente serializada
// como `voucher.ai_extracted_data`) — mesma leitura direta já feita por `getVoucherTypeBySlug`
// (`services/travel-db.ts`).
export interface VoucherTypeRecord {
  id: string;
  slug: string;
  name: string | null;
  description: string | null;
  prompt: string | null;
  structured_output: Record<string, unknown> | null;
  ai_model: string | null;
  ai_provider: string | null;
  active: boolean;
  tenant_id: string;
  created_at: string;
}

const SELECT_COLUMNS = `id, slug, name, description, prompt, structured_output, ai_model, ai_provider, active, tenant_id, created_at`;

export async function listVoucherTypes(tenantId: string): Promise<VoucherTypeRecord[]> {
  const { rows } = await getPool().query<VoucherTypeRecord>(`select ${SELECT_COLUMNS} from voucher_type where tenant_id = $1 order by name`, [
    tenantId,
  ]);
  return rows;
}

export interface CreateVoucherTypeInput {
  tenantId: string;
  slug: string;
  name: string;
  description: string | null;
  prompt: string | null;
  structuredOutput: Record<string, unknown> | null;
  aiModel: string | null;
  aiProvider: string | null;
  active: boolean;
}

export async function createVoucherType(input: CreateVoucherTypeInput): Promise<VoucherTypeRecord> {
  const { rows } = await getPool().query<VoucherTypeRecord>(
    `insert into voucher_type (tenant_id, slug, name, description, prompt, structured_output, ai_model, ai_provider, active)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning ${SELECT_COLUMNS}`,
    [
      input.tenantId,
      input.slug,
      input.name,
      input.description,
      input.prompt,
      input.structuredOutput ? JSON.stringify(input.structuredOutput) : null,
      input.aiModel,
      input.aiProvider,
      input.active,
    ],
  );
  return rows[0];
}

// Update parcial: campos ausentes de `patch` mantêm o valor atual — mesma convenção de
// `updateCompanyReference`. O frontend manda só `{ id, active }` no toggle rápido de
// ativar/desativar, então nenhum campo pode ser tratado como obrigatório aqui.
export interface UpdateVoucherTypeInput {
  name?: string;
  description?: string | null;
  prompt?: string | null;
  structuredOutput?: Record<string, unknown> | null;
  aiModel?: string | null;
  aiProvider?: string | null;
  active?: boolean;
}

export async function updateVoucherType(tenantId: string, id: string, patch: UpdateVoucherTypeInput): Promise<VoucherTypeRecord | null> {
  const { rows } = await getPool().query<VoucherTypeRecord>(
    `update voucher_type set
       name = coalesce($3, name),
       description = case when $4 then $5 else description end,
       prompt = case when $6 then $7 else prompt end,
       structured_output = case when $8 then $9 else structured_output end,
       ai_model = case when $10 then $11 else ai_model end,
       ai_provider = case when $12 then $13 else ai_provider end,
       active = coalesce($14, active)
     where tenant_id = $1 and id = $2
     returning ${SELECT_COLUMNS}`,
    [
      tenantId,
      id,
      patch.name ?? null,
      'description' in patch,
      patch.description ?? null,
      'prompt' in patch,
      patch.prompt ?? null,
      'structuredOutput' in patch,
      patch.structuredOutput ? JSON.stringify(patch.structuredOutput) : null,
      'aiModel' in patch,
      patch.aiModel ?? null,
      'aiProvider' in patch,
      patch.aiProvider ?? null,
      patch.active ?? null,
    ],
  );
  return rows[0] ?? null;
}
