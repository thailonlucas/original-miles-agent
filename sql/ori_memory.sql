-- Memória do Ori em três camadas (ver `src/mastra/services/ori-memory-db.ts` e
-- `src/mastra/agents/ori-memory-learner/AGENTS.md`):
--
-- 1. Prompt base (código) — vale pra todos os tenants; não fica em tabela.
-- 2. `ori_tenant_memory` — regras de uma agência, valem pra todos os consultores do tenant. Só
--    admin (`team.role = 'admin'`) altera.
-- 3. `ori_user_memory` — como UM consultor trabalha com o Ori (estilo, formato dos cards, fluxo).
--    Escrita pelo Ori (pedido explícito do consultor) e pelo agente `ori-memory-learner` (padrão
--    visto em 2+ sessões).
--
-- `ori_memory_candidate` — correções que parecem valer pra além de um consultor (regra da agência
-- ou defeito do prompt base). Ficam pendentes até um admin decidir.
--
-- `items` são arrays jsonb pequenos (poucas dezenas), sempre lidos inteiros e injetados no prompt —
-- por isso uma linha por dono em vez de uma linha por item.

create table if not exists ori_user_memory (
  tenant_id text not null,
  user_id text not null,
  -- [{ id, text, kind, source: 'explicito'|'aprendido', evidence: [session_id], created_at, updated_at }]
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create table if not exists ori_tenant_memory (
  tenant_id text primary key,
  -- [{ id, text, required, created_by, created_at, updated_at }]
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ori_memory_candidate (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  text text not null,
  kind text not null,
  -- Palpite do agente: 'tenant' (jeito da agência) ou 'base' (defeito do Ori pra todos).
  scope_hint text not null check (scope_hint in ('tenant', 'base')),
  reason text,
  -- [{ user_id, session_id }] — uma entrada por sessão; o tamanho é quantas vezes apareceu.
  evidence jsonb not null default '[]'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'accepted_tenant', 'accepted_base', 'rejected')),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ori_memory_candidate_tenant_status_idx on ori_memory_candidate (tenant_id, status);

-- Tabelas criadas via SQL cru não recebem os GRANTs automáticos que o Supabase Studio aplica
-- ao criar pela UI; sem isso, o client REST (service_role) recebe "permission denied for table".
grant select, insert, update, delete on ori_user_memory to service_role;
grant select, insert, update, delete on ori_tenant_memory to service_role;
grant select, insert, update, delete on ori_memory_candidate to service_role;
