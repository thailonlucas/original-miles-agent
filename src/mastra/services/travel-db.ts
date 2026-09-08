import pg from 'pg';
import { env } from '../config/env';
import { requireEnv } from '../config/require-env';

// Acesso direto ao Postgres do Supabase (mesma connection string usada pelo storage do Mastra,
// ver `mastra-instance.ts`), em vez do client REST (`services/supabase.ts`, `SUPABASE_SERVICE_ROLE_KEY`).
// Isso ignora RLS de propósito — as policies de `voucher`/`voucher_type` escopam por tenant via
// `team.email = auth.jwt() ->> 'email'`, então quem chama estas funções precisa passar o
// `tenantId` já resolvido (ver `services/supabase-auth.ts` + `getTenantIdByEmail` abaixo).
let pool: pg.Pool | undefined;

function getPool(): pg.Pool {
  if (!pool) {
    const { SUPABASE_DB_URL } = requireEnv({ SUPABASE_DB_URL: env.SUPABASE_DB_URL }, 'Travel DB');
    pool = new pg.Pool({ connectionString: SUPABASE_DB_URL, max: 5 });
  }
  return pool;
}

export interface VoucherType {
  slug: string;
  name: string | null;
  description: string | null;
}

// Tipos de voucher ativos de um tenant (tabela `voucher_type`) — nome, slug e descrição usados
// pelo agente `voucher-type` (`agents/voucher-type/`) pra decidir a qual tipo um documento
// pertence. Não inclui `prompt`/`structured_output` (usados na extração em si, não na
// classificação) nem `ai_model`/`ai_provider`.
export async function getActiveVoucherTypes(tenantId: string): Promise<VoucherType[]> {
  const { rows } = await getPool().query<VoucherType>(
    `select slug, name, description from voucher_type where active = true and tenant_id = $1 order by name`,
    [tenantId],
  );
  return rows;
}

// Resolve o tenant do usuário autenticado — mesma lógica das policies de RLS de
// `voucher`/`voucher_type` (`team.email = auth.jwt() ->> 'email'`), replicada aqui porque o
// acesso é direto via Postgres (bypassa RLS). `email` vem de `verifySupabaseAccessToken`
// (`services/supabase-auth.ts`).
export async function getTenantIdByEmail(email: string): Promise<string | null> {
  const { rows } = await getPool().query<{ tenant_id: string | null }>(`select tenant_id from team where email = $1 limit 1`, [email]);
  return rows[0]?.tenant_id ?? null;
}

// Resolve o tenant dono de uma viagem — usado por rotas que recebem só `travel_id` (sem o
// access_token do usuário pra resolver por e-mail, ver `getTenantIdByEmail` acima), como o
// endpoint de geração do daily_schedule do zero.
export async function getTenantIdByTravelId(travelId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ tenant_id: string | null }>(`select tenant_id from travel where id = $1 limit 1`, [travelId]);
  return rows[0]?.tenant_id ?? null;
}

export interface VoucherTypeFull {
  slug: string;
  name: string | null;
  description: string | null;
  // Prompt de extração específico do tipo (instructions do agente extrator) — texto livre
  // cadastrado por linha em `voucher_type.prompt`.
  prompt: string | null;
  // JSON Schema (draft-07) que o agente extrator deve seguir — a coluna guarda `{ schema: {...} }`,
  // já desembrulhado aqui pro campo `schema`.
  schema: Record<string, unknown> | null;
  aiModel: string | null;
  aiProvider: string | null;
}

// Tipo de voucher completo (prompt + schema de extração + modelo) por slug — usado pelo agente
// extrator (`agents/voucher-extractor/`) depois que `voucher-type` já classificou o documento.
export async function getVoucherTypeBySlug(tenantId: string, slug: string): Promise<VoucherTypeFull | null> {
  const { rows } = await getPool().query<{
    slug: string;
    name: string | null;
    description: string | null;
    prompt: string | null;
    structured_output: Record<string, unknown> | null;
    ai_model: string | null;
    ai_provider: string | null;
  }>(
    `select slug, name, description, prompt, structured_output, ai_model, ai_provider
     from voucher_type where tenant_id = $1 and slug = $2 and active = true limit 1`,
    [tenantId, slug],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    schema: unwrapJsonSchema(row.structured_output),
    aiModel: row.ai_model,
    aiProvider: row.ai_provider,
  };
}

// A maioria das linhas de `voucher_type` guarda `structured_output` como `{ schema: {...} }`, mas
// pelo menos uma (`other`) guarda o JSON Schema direto na raiz (sem o wrapper `schema`) — os dois
// formatos existem de verdade no banco (não é um caso hipotético). Aceita ambos: se tem `.schema`,
// usa ele; senão, se o próprio valor já parece um JSON Schema (tem `properties`), usa ele direto.
function unwrapJsonSchema(structuredOutput: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!structuredOutput) return null;
  const schema = structuredOutput.schema;
  if (schema && typeof schema === 'object') return schema as Record<string, unknown>;
  if ('properties' in structuredOutput) return structuredOutput;
  return null;
}

export interface InsertVoucherInput {
  tenantId: string;
  travelId: string;
  title: string | null;
  content: string | null;
  voucherTypeSlug: string;
  // Objeto já extraído (não a string) — serializado aqui do jeito que o resto do sistema espera
  // (ver comentário dentro da função) antes de ir pro Postgres.
  aiExtractedData: Record<string, unknown> | null;
  rawContent: string | null;
  metadata: Record<string, unknown> | null;
  fileUrl: string | null;
}

export interface VoucherRecord {
  id: string;
  tenant_id: string;
  travel_id: string;
  title: string | null;
  content: string | null;
  voucher_type_slug: string;
  file_url: string | null;
  ai_extracted_data: string | null;
  createdAt: string;
}

// Remove um voucher (usado pela rota DELETE /travel_agent/extract/vouchers) — sempre escopado por
// tenant, pra um tenant nunca conseguir apagar voucher de outro mesmo sabendo o `id`.
export async function deleteVoucher(tenantId: string, travelId: string, voucherId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(`delete from voucher where tenant_id = $1 and travel_id = $2 and id = $3`, [
    tenantId,
    travelId,
    voucherId,
  ]);
  return (rowCount ?? 0) > 0;
}

export interface VoucherSummary {
  id: string;
  voucherTypeSlug: string;
  title: string | null;
  content: string | null;
}

// Lista leve (sem `ai_extracted_data`) de todos os vouchers de uma viagem — o que o agente
// `agents/daily-schedule/` recebe no prompt do usuário pra decidir quais vouchers abrir com a tool
// `openVoucher` (ver `tools/open-voucher-tool.ts`). Não filtra por tipo aqui (ex: exclui
// `travel_insurance`) — isso é responsabilidade de quem monta o roteiro.
export async function getVoucherSummaries(tenantId: string, travelId: string, client: Queryable = getPool()): Promise<VoucherSummary[]> {
  const { rows } = await client.query<{ id: string; voucher_type_slug: string; title: string | null; content: string | null }>(
    `select id, voucher_type_slug, title, content from voucher where tenant_id = $1 and travel_id = $2 order by id`,
    [tenantId, travelId],
  );
  return rows.map((row) => ({ id: row.id, voucherTypeSlug: row.voucher_type_slug, title: row.title, content: row.content }));
}

// Dados completos extraídos de UM voucher, por id — usado pela tool `openVoucher`
// (`tools/open-voucher-tool.ts`), chamada pelo agente sob demanda em vez de todo `ai_extracted_data`
// de todos os vouchers ir de uma vez no prompt.
export async function getVoucherExtractedData(
  tenantId: string,
  voucherId: string,
  client: Queryable = getPool(),
): Promise<Record<string, unknown> | null> {
  const { rows } = await client.query<{ ai_extracted_data: string | null }>(
    `select ai_extracted_data from voucher where tenant_id = $1 and id = $2 limit 1`,
    [tenantId, voucherId],
  );
  const raw = rows[0]?.ai_extracted_data;
  // `ai_extracted_data` sai do `pg` já como string JS (jsonb "string" escalar, ver comentário em
  // `insertVoucher`) — precisa de um segundo `JSON.parse` pra virar objeto de novo.
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

export interface TravelScheduleState {
  // Array esparso — só os dias com pelo menos um evento (ver AGENTS.md de `agents/daily-schedule/`
  // sobre por que não guardamos mais dias vazios aqui). Pra saber o range completo da viagem
  // (inclusive dias sem evento), use `travelStartAt`/`travelEndAt`.
  dailySchedule: unknown[];
  travelStartAt: string | null;
  travelEndAt: string | null;
}

export async function getTravelSchedule(tenantId: string, travelId: string, client: Queryable = getPool()): Promise<TravelScheduleState> {
  const { rows } = await client.query<{ daily_schedule: string | null; travel_start_at: string | null; travel_end_at: string | null }>(
    `select daily_schedule, travel_start_at::text as travel_start_at, travel_end_at::text as travel_end_at
     from travel where tenant_id = $1 and id = $2 limit 1`,
    [tenantId, travelId],
  );
  const row = rows[0];
  return {
    // `daily_schedule` sai do `pg` como string JS (double-encoding, ver `insertVoucher`) — precisa
    // de um segundo `JSON.parse`. `null`/coluna vazia vira array vazio, nunca `null`.
    dailySchedule: row?.daily_schedule ? (JSON.parse(row.daily_schedule) as unknown[]) : [],
    travelStartAt: row?.travel_start_at ?? null,
    travelEndAt: row?.travel_end_at ?? null,
  };
}

// Garante que existe uma linha em `travel` pra este id/tenant antes de ler/gravar o roteiro.
// Necessário porque este repo NUNCA cria `travel` (só lê/atualiza — quem cria é outro sistema, ver
// comentário em `insertVoucher`), mas na prática já existe `travel_id` usado em `voucher`
// (extração de voucher não depende de `travel` existir) sem uma linha correspondente em `travel`
// ainda — sem isso, o `update` de `saveTravelSchedule` roda contra 0 linhas e falha em silêncio
// (nenhum erro, nenhuma gravação), e as rotas que resolvem tenant via `getTenantIdByTravelId`
// devolviam 404 mesmo a viagem "existindo" (só ainda não em `travel`). `on conflict do nothing`
// pra nunca sobrescrever uma linha já existente (inclusive de outro tenant — nesse caso a
// linha simplesmente não muda, e as queries scoped por tenant_id que rodam depois continuam
// corretamente não encontrando nada pra esse tenant).
//
// `created_by` é `NOT NULL` com default `auth.uid()` — que só resolve dentro de um request
// autenticado via Supabase Auth/PostgREST, nunca nesta conexão direta via `pg` (confirmado:
// `select auth.uid()` por aqui devolve `null`). Por isso `userId` (o `id` do usuário logado, do
// mesmo `AuthenticatedUser` de `supabase-auth.ts`) precisa ser passado explicitamente — sem isso
// o insert falha com constraint violation assim que a linha realmente não existir ainda.
export async function ensureTravelExists(tenantId: string, travelId: string, userId: string, client: Queryable = getPool()): Promise<void> {
  // PK real de `travel` é composta (`id`, `tenant_id`) — `on conflict (id)` sozinho não casa com
  // nenhuma constraint e falha com "no unique or exclusion constraint" mesmo numa linha nova.
  await client.query(`insert into travel (id, tenant_id, created_by) values ($1, $2, $3) on conflict (id, tenant_id) do nothing`, [
    travelId,
    tenantId,
    userId,
  ]);
}

export async function saveTravelSchedule(tenantId: string, travelId: string, state: TravelScheduleState, client: Queryable = getPool()): Promise<void> {
  // Mesmo double-encoding de `ai_extracted_data` (ver comentário em `insertVoucher`) — os
  // registros já gravados pelo fluxo antigo em n8n guardam `daily_schedule` como jsonb *string*
  // (o `JSON.parse` de quem lê espera isso), não como array direto.
  await client.query(`update travel set daily_schedule = $1, travel_start_at = $2, travel_end_at = $3 where tenant_id = $4 and id = $5`, [
    JSON.stringify(JSON.stringify(state.dailySchedule)),
    state.travelStartAt,
    state.travelEndAt,
    tenantId,
    travelId,
  ]);
}

export interface ScheduleSuggestionDecision {
  date: string; // YYYY-MM-DD
  period: 'morning' | 'afternoon' | 'night';
  event: { title: string; content: string; type: string; observation: string | null };
  // Motivo original dado pelo agente `schedule-suggestion` pra essa sugestão (ver
  // `agents/schedule-suggestion/schema.ts` -> `scheduleSuggestionEventSchema.reason`) — guardado
  // aqui mesmo pra rejeição, pra a "inteligência" da viagem saber TAMBÉM o que foi oferecido e
  // recusado, não só o que foi aprovado.
  reason: string | null;
  status: 'approved' | 'rejected';
  decidedAt: string; // ISO 8601
}

// Histórico de decisões (aprovar/rejeitar) sobre sugestões do agente `schedule-suggestion` — a
// "inteligência" da viagem: usado por `agents/schedule-suggestion/suggest-day-activities.ts` pra
// alimentar as PRÓXIMAS chamadas de sugestão com o que o cliente já aprovou/rejeitou antes (ver
// `prompts/system-prompt.ts` desse agente). Ao contrário de `ai_extracted_data`/`daily_schedule`,
// esta coluna é nova (sem consumidor legado em n8n) — grava jsonb normal, sem o double-encoding
// dessas duas (ver comentário em `insertVoucher`).
export async function getApprovedSuggestions(tenantId: string, travelId: string, client: Queryable = getPool()): Promise<ScheduleSuggestionDecision[]> {
  const { rows } = await client.query<{ approved_suggestions: ScheduleSuggestionDecision[] | null }>(
    `select approved_suggestions from travel where tenant_id = $1 and id = $2 limit 1`,
    [tenantId, travelId],
  );
  return rows[0]?.approved_suggestions ?? [];
}

// Concatena a decisão no array jsonb direto no Postgres (`||` de jsonb) em vez de ler+reescrever
// em código — evita perder uma decisão concorrente sem precisar do advisory lock de
// `withTravelScheduleLock` só pra esta coluna (que é independente de `daily_schedule`).
export async function appendApprovedSuggestion(
  tenantId: string,
  travelId: string,
  decision: ScheduleSuggestionDecision,
  client: Queryable = getPool(),
): Promise<void> {
  await client.query(
    `update travel set approved_suggestions = coalesce(approved_suggestions, '[]'::jsonb) || $1::jsonb where tenant_id = $2 and id = $3`,
    [JSON.stringify([decision]), tenantId, travelId],
  );
}

// Namespace arbitrário pro advisory lock abaixo — só existe pra não colidir com outro uso futuro
// de `pg_advisory_xact_lock` nesta mesma base (todos usariam a mesma "tabela" de locks do Postgres,
// que é só um espaço de chaves inteiras, sem relação com nenhuma tabela real).
const DAILY_SCHEDULE_LOCK_NAMESPACE = 837_465;

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

// Serializa qualquer leitura+escrita do `daily_schedule` de uma viagem — pensado pra evitar que
// dois vouchers extraídos ao mesmo tempo (ou uma extração e uma exclusão) disparem dois rebuilds
// concorrentes que se pisam (o mais lento sobrescrevendo o resultado do mais rápido com uma foto
// desatualizada dos vouchers). `pg_advisory_xact_lock` trava por `travelId` (hash) só dentro desta
// transação — a segunda chamada concorrente para a MESMA viagem espera aqui até a primeira
// terminar (commit ou rollback libera o lock automaticamente), e quando segue, já lê os vouchers
// mais atuais (incluindo o que motivou a primeira chamada). Chamadas para viagens diferentes nunca
// se bloqueiam entre si (`hashtext(travelId)` como segunda chave do lock).
//
// A conexão fica presa (e a chamada de IA acontece) durante todo o `fn` — aceitável pro volume
// atual, mas se algum dia o pool apertar (`SUPABASE_DB_URL` é a Session Pooler do Supabase, ver
// `mastra-instance.ts`), vale revisitar: soltar o lock antes da chamada de IA e reconferir/mesclar
// no final é mais complexo, mas evita segurar conexão parada por vários segundos.
export async function withTravelScheduleLock<T>(
  tenantId: string,
  travelId: string,
  userId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [DAILY_SCHEDULE_LOCK_NAMESPACE, travelId]);
    // Ver `ensureTravelExists` — garante a linha antes de qualquer leitura/gravação de
    // `daily_schedule`/`approved_suggestions` dentro de `fn`.
    await ensureTravelExists(tenantId, travelId, userId, client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function insertVoucher(input: InsertVoucherInput): Promise<VoucherRecord> {
  // `ai_extracted_data` é `jsonb`, mas o resto do sistema (frontend, registros já gravados pelo
  // fluxo antigo em n8n) trata o valor como STRING — `JSON.parse(item.ai_extracted_data)` no
  // frontend (ver original-miles-cartinhas/src/routes/devs.tsx). Um único `JSON.stringify` viraria
  // um jsonb *objeto* (Postgres reconhece `{"a":1}` como objeto JSON válido); pra gravar como jsonb
  // *string* (compatível com o `JSON.parse` que já existe do lado de fora), precisa de um segundo
  // `JSON.stringify` — o valor final enviado ao Postgres é a string JSON de uma string JSON.
  const aiExtractedData = input.aiExtractedData ? JSON.stringify(JSON.stringify(input.aiExtractedData)) : null;
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null;

  const { rows } = await getPool().query<VoucherRecord>(
    `insert into voucher (tenant_id, travel_id, title, content, voucher_type_slug, file_url, ai_extracted_data, raw_content, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id, tenant_id, travel_id, title, content, voucher_type_slug, file_url, ai_extracted_data, created_at as "createdAt"`,
    [input.tenantId, input.travelId, input.title, input.content, input.voucherTypeSlug, input.fileUrl, aiExtractedData, input.rawContent, metadata],
  );
  return rows[0];
}
