import pg from 'pg';
import { env } from '../config/env';
import { requireEnv } from '../config/require-env';
import { dailyScheduleSchema, type DailyScheduleDay, type DailyScheduleEvent } from '../agents/daily-schedule/schema';
import { addApprovedSuggestions, fallbackDayTitle, insertEventIntoDays, scheduleRange, withoutSuggestion } from '../agents/daily-schedule/schedule-merge';
import { normalizeEventContent } from '../agents/daily-schedule/event-format';

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

// Lista completa (com `ai_extracted_data`) de todos os vouchers de uma viagem — usada pela rota
// `GET /travel_agent/extract/vouchers` (`routes/voucher-routes.ts`), mesmas colunas devolvidas por
// `insertVoucher`/`updateVoucherFields` (mesmo formato de item pros três endpoints).
export async function getVouchers(tenantId: string, travelId: string): Promise<VoucherRecord[]> {
  const { rows } = await getPool().query<VoucherRecord>(
    `select id, tenant_id, travel_id, title, content, voucher_type_slug, file_url, ai_extracted_data, created_at as "createdAt"
     from voucher where tenant_id = $1 and travel_id = $2 order by id`,
    [tenantId, travelId],
  );
  return rows;
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

// `travel_start_at`/`travel_end_at` se expandem quando `date` cai fora do range já conhecido (ex:
// uma sugestão aprovada, ou um evento movido, pra um dia mais cedo/tarde do que qualquer coisa já
// vista).
function expandTravelRange(travelStartAt: string | null, travelEndAt: string | null, date: string): { travelStartAt: string; travelEndAt: string } {
  return {
    travelStartAt: !travelStartAt || date < travelStartAt ? date : travelStartAt,
    travelEndAt: !travelEndAt || date > travelEndAt ? date : travelEndAt,
  };
}

// Insere um evento novo em `daily_schedule` (criando o dia se precisar) dentro de uma
// transação/lock JÁ ABERTA por quem chama — pra quando o insert precisa ser atômico junto de outra
// escrita na mesma chamada (ver `applySuggestionDecision`/`createDecidedSuggestion`,
// `agents/schedule-suggestion/`). `insertDailyScheduleEvent` logo abaixo é a versão standalone
// (abre seu próprio lock) pra quem só precisa disso.
export async function insertScheduleEventWithClient(
  tenantId: string,
  travelId: string,
  client: pg.PoolClient,
  date: string,
  period: 'morning' | 'afternoon' | 'night',
  event: DailyScheduleEvent,
): Promise<DailyScheduleEvent> {
  const state = await getTravelSchedule(tenantId, travelId, client);
  const parsed = dailyScheduleSchema.safeParse(state.dailySchedule);
  const days = parsed.success ? parsed.data : [];

  const normalized: DailyScheduleEvent = { ...event, content: normalizeEventContent(event.content, event.title) };
  const newDays = insertEventIntoDays(days, date, period, normalized);
  const { travelStartAt, travelEndAt } = expandTravelRange(state.travelStartAt, state.travelEndAt, date);
  await saveTravelSchedule(tenantId, travelId, { dailySchedule: newDays, travelStartAt, travelEndAt }, client);
  return normalized;
}

// UM evento do dia a dia pela posição (date, period, index) — `null` se não existir. Usado pela
// tool `detalharEvento` e pelo texto de aprovação das tools do Ori que mexem num evento.
export async function getDailyScheduleEvent(
  tenantId: string,
  travelId: string,
  date: string,
  period: 'morning' | 'afternoon' | 'night',
  index: number,
): Promise<DailyScheduleEvent | null> {
  const parsed = dailyScheduleSchema.safeParse((await getTravelSchedule(tenantId, travelId)).dailySchedule);
  if (!parsed.success) return null;
  return parsed.data.find((d) => d.date === date)?.events[period][index] ?? null;
}

export async function insertDailyScheduleEvent(
  tenantId: string,
  travelId: string,
  userId: string,
  date: string,
  period: 'morning' | 'afternoon' | 'night',
  event: DailyScheduleEvent,
): Promise<DailyScheduleEvent> {
  return withTravelScheduleLock(tenantId, travelId, userId, (client) =>
    insertScheduleEventWithClient(tenantId, travelId, client, date, period, event),
  );
}

// Edita título/conteúdo de UM evento já confirmado do roteiro (originado de voucher) — mesma ideia
// de editar um voucher (`updateVoucher` no frontend) — e/ou MOVE esse evento pra outro dia/período
// (`newDate`/`newPeriod`), mesma ação do drag-and-drop do front (`handleMoveEvent`,
// `DailyScheduleResponse.tsx`). Localiza o evento de origem por (date, period, index) — frágil se o
// roteiro for reconstruído entre o usuário abrir a tela e salvar (o índice pode não bater mais),
// mas aceitável pra uma edição/move rápido logo após ver a lista, mesmo risco que outras escritas
// otimistas do app. Usa o mesmo lock de `daily_schedule` das outras escritas
// (`rebuild-daily-schedule.ts` etc.) pra não pisar num rebuild/update incremental disparado ao
// mesmo tempo por um voucher novo.
export async function updateDailyScheduleEvent(
  tenantId: string,
  travelId: string,
  userId: string,
  date: string,
  period: 'morning' | 'afternoon' | 'night',
  index: number,
  patch: { title?: string; content?: string; newDate?: string; newPeriod?: 'morning' | 'afternoon' | 'night'; newIndex?: number },
): Promise<DailyScheduleEvent | null> {
  return withTravelScheduleLock(tenantId, travelId, userId, async (client) => {
    const state = await getTravelSchedule(tenantId, travelId, client);
    const parsed = dailyScheduleSchema.safeParse(state.dailySchedule);
    if (!parsed.success) return null;

    const days = parsed.data;
    const dayIndex = days.findIndex((d) => d.date === date);
    if (dayIndex < 0) return null;

    const day = days[dayIndex];
    const events = day.events[period];
    const current = events[index];
    if (!current) return null;

    const updatedEvent: DailyScheduleEvent = {
      ...current,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.content !== undefined ? { content: normalizeEventContent(patch.content, patch.title ?? current.title) } : {}),
    };

    const targetDate = patch.newDate ?? date;
    const targetPeriod = patch.newPeriod ?? period;
    let newDays: DailyScheduleDay[];

    if (targetDate === date && targetPeriod === period && (patch.newIndex === undefined || patch.newIndex === index)) {
      // Sem move — substitui o evento no lugar (preserva a posição).
      const newEvents = [...events];
      newEvents[index] = updatedEvent;
      newDays = [...days];
      newDays[dayIndex] = { ...day, events: { ...day.events, [period]: newEvents } };
    } else if (targetDate === date) {
      // Mesmo dia (outro período ou outra posição no mesmo período) — o evento sai e entra no MESMO
      // objeto de dia, que nunca fica vazio no caminho, então o `title` do dia é preservado.
      // `newIndex` é a posição final no período de destino; sem ele, vai pro fim.
      const withoutEvent = { ...day.events, [period]: events.filter((_, i) => i !== index) };
      const target = [...withoutEvent[targetPeriod]];
      target.splice(Math.max(0, Math.min(patch.newIndex ?? target.length, target.length)), 0, updatedEvent);
      newDays = [...days];
      newDays[dayIndex] = { ...day, events: { ...withoutEvent, [targetPeriod]: target } };
    } else {
      // Move de dia — remove do dia de origem (removendo o dia inteiro da lista se ficar sem
      // nenhum evento, já que `daily_schedule` é esparso: só guarda dias com >=1 evento) e insere
      // no dia de destino (`insertEventIntoDays` cria o dia, ordenado por data, se ele ainda não
      // existir na lista).
      const remainingSourceEvents = events.filter((_, i) => i !== index);
      const sourceDay: DailyScheduleDay = { ...day, events: { ...day.events, [period]: remainingSourceEvents } };
      const sourceIsEmpty =
        sourceDay.events.morning.length === 0 && sourceDay.events.afternoon.length === 0 && sourceDay.events.night.length === 0;

      const daysWithoutSourceEvent = [...days];
      if (sourceIsEmpty) {
        daysWithoutSourceEvent.splice(dayIndex, 1);
      } else {
        daysWithoutSourceEvent[dayIndex] = sourceDay;
      }

      newDays = insertEventIntoDays(daysWithoutSourceEvent, targetDate, targetPeriod, updatedEvent, patch.newIndex);
    }

    const { travelStartAt, travelEndAt } = expandTravelRange(state.travelStartAt, state.travelEndAt, targetDate);
    await saveTravelSchedule(tenantId, travelId, { dailySchedule: newDays, travelStartAt, travelEndAt }, client);
    return updatedEvent;
  });
}

// Edita o título (subtítulo da coluna no kanban) de UM dia do roteiro. Marca `title_edited` pra que
// nenhuma junção/reconstrução por voucher troque o título depois (ver `schedule-merge.ts`). `title`
// vazio volta ao automático: título do primeiro evento do dia, sem a marca. `null` se o dia não
// existir — o array é esparso, dia sem evento não tem título pra editar.
export async function updateDailyScheduleDayTitle(
  tenantId: string,
  travelId: string,
  userId: string,
  date: string,
  title: string,
): Promise<DailyScheduleDay | null> {
  return withTravelScheduleLock(tenantId, travelId, userId, async (client) => {
    const state = await getTravelSchedule(tenantId, travelId, client);
    const parsed = dailyScheduleSchema.safeParse(state.dailySchedule);
    if (!parsed.success) return null;

    const day = parsed.data.find((d) => d.date === date);
    if (!day) return null;

    const trimmed = title.trim();
    const { title_edited: _previousFlag, ...rest } = day;
    const updatedDay: DailyScheduleDay = trimmed ? { ...rest, title: trimmed, title_edited: true } : { ...rest, title: fallbackDayTitle(rest, parsed.data) };

    const newDays = parsed.data.map((d) => (d === day ? updatedDay : d));
    await saveTravelSchedule(tenantId, travelId, { ...state, dailySchedule: newDays }, client);
    return updatedDay;
  });
}

// Remove UM evento do dia a dia, localizado por (date, period, index) — tira o dia da lista se ele
// ficar vazio. Também é a decisão "remover" de um card marcado como voucher excluído. Um evento de
// voucher removido assim pode voltar se aquele voucher for atualizado (não há mais card pra
// enriquecer, então ele cria de novo) ou se o dia a dia for refeito.
export async function removeDailyScheduleEvent(
  tenantId: string,
  travelId: string,
  userId: string,
  date: string,
  period: 'morning' | 'afternoon' | 'night',
  index: number,
): Promise<DailyScheduleEvent | null> {
  return withTravelScheduleLock(tenantId, travelId, userId, async (client) => {
    const state = await getTravelSchedule(tenantId, travelId, client);
    const parsed = dailyScheduleSchema.safeParse(state.dailySchedule);
    if (!parsed.success) return null;

    const days = parsed.data;
    const day = days.find((d) => d.date === date);
    const removed = day?.events[period][index];
    if (!day || !removed) return null;

    const events = { ...day.events, [period]: day.events[period].filter((_, i) => i !== index) };
    const remaining = [...events.morning, ...events.afternoon, ...events.night];
    const newDays = days.flatMap((d) => {
      if (d !== day) return [d];
      if (remaining.length === 0) return [];
      return [{ ...d, title: d.title === removed.title && !d.title_edited ? fallbackDayTitle({ ...d, events }, days) : d.title, events }];
    });

    const { travelStartAt, travelEndAt } = scheduleRange(newDays);
    await saveTravelSchedule(tenantId, travelId, { dailySchedule: newDays, travelStartAt, travelEndAt }, client);

    // Evento de uma sugestão aprovada: a sugestão sai junto (mesma regra de `removeSuggestion`, no
    // sentido inverso) — senão ela ficava "aprovada" sem evento e voltava a aparecer como card no kanban.
    if (removed.source?.type === 'suggestion') {
      const suggestionId = removed.source.suggestion_id;
      const suggestions = await getSuggestions(tenantId, travelId, client);
      await saveSuggestions(tenantId, travelId, suggestions.filter((s) => s.id !== suggestionId), client);
    }
    return removed;
  });
}

// Decisão "manter" de um card marcado como voucher excluído (`removed_vouchers`, ver
// `markVoucherRemoved` em `schedule-merge.ts`): a marca sai e, se o card tinha sido criado pelo
// voucher excluído, ele vira evento manual — nenhuma mudança de voucher mexe mais nele por essa
// origem. Devolve `null` se o evento não existe e `{ event, changed: false }` se ele não estava marcado.
export async function keepDailyScheduleEvent(
  tenantId: string,
  travelId: string,
  userId: string,
  date: string,
  period: 'morning' | 'afternoon' | 'night',
  index: number,
): Promise<{ event: DailyScheduleEvent; changed: boolean } | null> {
  return withTravelScheduleLock(tenantId, travelId, userId, async (client) => {
    const state = await getTravelSchedule(tenantId, travelId, client);
    const parsed = dailyScheduleSchema.safeParse(state.dailySchedule);
    if (!parsed.success) return null;

    const day = parsed.data.find((d) => d.date === date);
    const current = day?.events[period][index];
    if (!day || !current) return null;
    if (!current.removed_vouchers?.length) return { event: current, changed: false };

    const removedIds = new Set(current.removed_vouchers.map((r) => r.voucher_id));
    const { removed_vouchers: _cleared, ...rest } = current;
    const event: DailyScheduleEvent =
      current.source?.type === 'voucher' && removedIds.has(current.source.voucher_id) ? { ...rest, source: { type: 'manual' } } : rest;

    const list = day.events[period].map((e, i) => (i === index ? event : e));
    const newDays = parsed.data.map((d) => (d === day ? { ...d, events: { ...d.events, [period]: list } } : d));
    await saveTravelSchedule(tenantId, travelId, { ...state, dailySchedule: newDays }, client);
    return { event, changed: true };
  });
}

// Resumo livre da viagem (perfil do cliente, tipo de viagem, preferências etc.), cadastrado uma vez
// pelo usuário (ver `routes/travel-summary-routes.ts`) e reaproveitado como contexto pelos agentes
// `daily-schedule`/`schedule-suggestion` — ao contrário de `daily_schedule`/`approved_suggestions`,
// não precisa do `withTravelScheduleLock` (não é lido+reescrito por múltiplas chamadas concorrentes,
// só substituído inteiro por uma edição explícita do usuário).
export async function getTravelSummary(tenantId: string, travelId: string, client: Queryable = getPool()): Promise<string | null> {
  const { rows } = await client.query<{ summary: string | null }>(`select summary from travel where tenant_id = $1 and id = $2 limit 1`, [
    tenantId,
    travelId,
  ]);
  return rows[0]?.summary ?? null;
}

// Cria a linha em `travel` se ainda não existir (mesmo motivo de `ensureTravelExists` — vouchers
// podem ser extraídos antes de qualquer daily_schedule, então `travel_id` pode não ter linha ainda
// quando o usuário cadastra o resumo).
export async function saveTravelSummary(tenantId: string, travelId: string, summary: string | null, userId: string): Promise<void> {
  await ensureTravelExists(tenantId, travelId, userId);
  await getPool().query(`update travel set summary = $1 where tenant_id = $2 and id = $3`, [summary, tenantId, travelId]);
}

// Tamanho máximo do Contexto da Viagem — limite da rota (`routes/travel-summary-routes.ts`).
export const MAX_TRAVEL_SUMMARY_LENGTH = 4000;

// --- Memória da viagem (`travel.ori_memory`, ver `sql/travel_ori_memory.sql`) ---
//
// O que os consultores contaram ao Ori sobre o cliente/a viagem. Compartilhada entre todos os
// consultores da viagem, e cada item diz quem contou, quando e em qual conversa — o Ori usa isso pra
// saber de onde veio cada informação. Separada de `travel.summary` ("Contexto da Viagem"), que é só
// do consultor: o Ori lê o summary e nunca escreve nele.

export const MAX_TRAVEL_MEMORY_ITEMS = 40;
export const MAX_TRAVEL_MEMORY_TEXT = 300;

export interface TravelMemoryItem {
  id: string;
  text: string;
  created_by: string;
  created_by_email: string | null;
  session_id: string | null;
  created_at: string;
  // Última correção (`corrigirAnotacaoViagem` ou a rota). Ausente se o item nunca foi corrigido.
  updated_by?: string;
  updated_by_email?: string | null;
  updated_session_id?: string | null;
  updated_at?: string;
}

// Quem está escrevendo — vem do `requestContext` (tools) ou do token (rotas), nunca do model.
export interface TravelMemoryAuthor {
  userId: string;
  email: string | null;
  sessionId: string | null;
}

const normalizeTravelMemoryText = (text: string): string =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.!;]+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();

export async function getTravelMemory(tenantId: string, travelId: string, client: Queryable = getPool()): Promise<TravelMemoryItem[]> {
  const { rows } = await client.query<{ ori_memory: TravelMemoryItem[] | null }>(
    `select ori_memory from travel where tenant_id = $1 and id = $2 limit 1`,
    [tenantId, travelId],
  );
  return rows[0]?.ori_memory ?? [];
}

// Lê, transforma e grava na mesma transação, com a linha travada — dois consultores (ou duas
// mensagens) podem anotar na mesma viagem ao mesmo tempo. Devolver a mesma lista = nada mudou.
async function mutateTravelMemory<T>(
  tenantId: string,
  travelId: string,
  userId: string,
  mutate: (items: TravelMemoryItem[]) => { items: TravelMemoryItem[]; result: T },
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await ensureTravelExists(tenantId, travelId, userId, client);
    const { rows } = await client.query<{ ori_memory: TravelMemoryItem[] | null }>(
      `select ori_memory from travel where tenant_id = $1 and id = $2 for update`,
      [tenantId, travelId],
    );
    const current = rows[0]?.ori_memory ?? [];
    const { items, result } = mutate(current);
    if (items !== current) {
      await client.query(`update travel set ori_memory = $3::jsonb where tenant_id = $1 and id = $2`, [tenantId, travelId, JSON.stringify(items)]);
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

// Anota UMA informação. O mesmo texto (normalizado) já anotado não duplica — devolve o existente.
export async function addTravelMemoryItem(
  tenantId: string,
  travelId: string,
  author: TravelMemoryAuthor,
  text: string,
): Promise<{ item: TravelMemoryItem; duplicate: boolean } | { error: string }> {
  return mutateTravelMemory<{ item: TravelMemoryItem; duplicate: boolean } | { error: string }>(tenantId, travelId, author.userId, (items) => {
    const key = normalizeTravelMemoryText(text);
    const existing = items.find((i) => normalizeTravelMemoryText(i.text) === key);
    if (existing) return { items, result: { item: existing, duplicate: true } };
    if (items.length >= MAX_TRAVEL_MEMORY_ITEMS) {
      return {
        items,
        result: { error: `A memória desta viagem está cheia (${MAX_TRAVEL_MEMORY_ITEMS} anotações). Corrija ou remova alguma que não vale mais antes.` },
      };
    }
    const item: TravelMemoryItem = {
      id: crypto.randomUUID(),
      text: text.trim().slice(0, MAX_TRAVEL_MEMORY_TEXT),
      created_by: author.userId,
      created_by_email: author.email,
      session_id: author.sessionId,
      created_at: new Date().toISOString(),
    };
    return { items: [...items, item], result: { item, duplicate: false } };
  });
}

// Corrige o texto de UM item. Mantém quem anotou originalmente e registra quem corrigiu.
export async function updateTravelMemoryItem(
  tenantId: string,
  travelId: string,
  author: TravelMemoryAuthor,
  itemId: string,
  text: string,
): Promise<{ previous: TravelMemoryItem; item: TravelMemoryItem } | null> {
  return mutateTravelMemory(tenantId, travelId, author.userId, (items) => {
    const previous = items.find((i) => i.id === itemId);
    if (!previous) return { items, result: null };
    const item: TravelMemoryItem = {
      ...previous,
      text: text.trim().slice(0, MAX_TRAVEL_MEMORY_TEXT),
      updated_by: author.userId,
      updated_by_email: author.email,
      updated_session_id: author.sessionId,
      updated_at: new Date().toISOString(),
    };
    return { items: items.map((i) => (i.id === itemId ? item : i)), result: { previous, item } };
  });
}

export async function removeTravelMemoryItem(tenantId: string, travelId: string, userId: string, itemId: string): Promise<TravelMemoryItem | null> {
  return mutateTravelMemory(tenantId, travelId, userId, (items) => {
    const removed = items.find((i) => i.id === itemId) ?? null;
    return { items: removed ? items.filter((i) => i.id !== itemId) : items, result: removed };
  });
}

// Contexto do cliente pros agentes que montam o dia a dia e sugerem atividades (`daily-schedule`,
// `schedule-suggestion`): o Contexto da Viagem do consultor + o que a equipe contou ao Ori. Antes as
// anotações do Ori iam pro próprio summary, então esses agentes continuam recebendo as duas coisas
// num texto só, no mesmo parâmetro `summary` de sempre.
export async function getTravelClientContext(tenantId: string, travelId: string, client: Queryable = getPool()): Promise<string | null> {
  // Em sequência: `client` pode ser o PoolClient da transação do rebuild, que não aceita queries paralelas.
  const summary = await getTravelSummary(tenantId, travelId, client);
  const memory = await getTravelMemory(tenantId, travelId, client);
  const notes = memory.map((i) => `- ${i.text}`).join('\n');
  if (!notes) return summary;
  return summary ? `${summary}\n\nContado pela equipe no chat:\n${notes}` : `Contado pela equipe no chat:\n${notes}`;
}

export type SuggestionStatus = 'pending' | 'approved' | 'rejected';

// Uma sugestão do agente `schedule-suggestion`, do momento em que é gerada até ser decidida (ou
// não). Guardada com um `id` estável desde a geração — necessário pra decidir, mover (drag and
// drop entre dias) ou apagar uma sugestão específica depois, sem depender de reenviar o objeto
// inteiro de volta (como o fluxo antigo fazia).
export interface StoredSuggestion {
  id: string;
  date: string; // YYYY-MM-DD
  period: 'morning' | 'afternoon' | 'night';
  event: { title: string; content: string; type: string; observation: string | null };
  // Motivo original dado pelo agente `schedule-suggestion` pra essa sugestão (ver
  // `agents/schedule-suggestion/schema.ts` -> `scheduleSuggestionEventSchema.reason`).
  reason: string | null;
  status: SuggestionStatus;
  // Motivo dado pela PESSOA (não pelo agente) ao aprovar/rejeitar — ver
  // `routes/schedule-suggestion-decision-routes.ts`. Sinal mais forte que `reason`/`status`
  // sozinhos pras próximas sugestões (ver regra 4.1 do prompt de
  // `agents/schedule-suggestion/prompts/system-prompt.ts`): explica o QUE agradou ou desagradou
  // (ex: "muito caro", "adoramos vinícolas"), não só que aprovou/rejeitou. Sempre `null` enquanto
  // `status` for "pending".
  feedback: string | null;
  createdAt: string; // ISO 8601 — quando o agente gerou esta sugestão.
  decidedAt: string | null; // ISO 8601 — quando aprovada/rejeitada; `null` enquanto pendente.
}

// Todas as sugestões já geradas pro agente pra esta viagem (pendentes, aprovadas e rejeitadas) —
// única fonte usada tanto pelo prompt do agente (filtra as decididas, ver
// `suggest-day-activities.ts`) quanto pelo frontend (mostra tudo no histórico, e as pendentes
// aparecem como card no dia a dia até serem decididas).
export async function getSuggestions(tenantId: string, travelId: string, client: Queryable = getPool()): Promise<StoredSuggestion[]> {
  const { rows } = await client.query<{ suggestions: StoredSuggestion[] | null }>(
    `select suggestions from travel where tenant_id = $1 and id = $2 limit 1`,
    [tenantId, travelId],
  );
  return rows[0]?.suggestions ?? [];
}

// Grava as sugestões recém-geradas pelo agente como "pending" — chamado logo após
// `suggestActivitiesForDay` responder, antes de devolver a resposta HTTP (ver
// `suggest-day-activities.ts`). Concatena via `||` de jsonb (sem lock: é só um append, não
// depende de ler o estado atual pra decidir o que escrever).
export async function appendPendingSuggestions(
  tenantId: string,
  travelId: string,
  userId: string,
  suggestions: StoredSuggestion[],
): Promise<void> {
  if (suggestions.length === 0) return;
  // Garante a linha em `travel` — mesmo motivo de `ensureTravelExists` nas outras escritas
  // (primeira sugestão pedida pra uma viagem pode acontecer antes de qualquer voucher/roteiro).
  await ensureTravelExists(tenantId, travelId, userId);
  await getPool().query(`update travel set suggestions = coalesce(suggestions, '[]'::jsonb) || $1::jsonb where tenant_id = $2 and id = $3`, [
    JSON.stringify(suggestions),
    tenantId,
    travelId,
  ]);
}

// Aprova ou rejeita UMA sugestão pendente pelo `id` — só decide quem ainda está "pending" (a
// condição no WHERE/CASE evita decidir a mesma sugestão duas vezes por engano). Devolve `true` se
// encontrou e decidiu, `false` se o id não existia ou já tinha sido decidido.
export async function decideSuggestion(
  tenantId: string,
  travelId: string,
  suggestionId: string,
  status: 'approved' | 'rejected',
  feedback: string | null,
  client: Queryable = getPool(),
): Promise<boolean> {
  const decidedAt = new Date().toISOString();
  const { rows } = await client.query<{ decided: boolean }>(
    `update travel
     set suggestions = coalesce((
       select jsonb_agg(
         case when elem->>'id' = $3 and elem->>'status' = 'pending'
           then elem || jsonb_build_object('status', $4::text, 'feedback', to_jsonb($5::text), 'decidedAt', $6::text)
           else elem
         end
       )
       from jsonb_array_elements(coalesce(suggestions, '[]'::jsonb)) elem
     ), '[]'::jsonb)
     where tenant_id = $1 and id = $2
       and exists (
         select 1 from jsonb_array_elements(coalesce(suggestions, '[]'::jsonb)) elem
         where elem->>'id' = $3 and elem->>'status' = 'pending'
       )
     returning true as decided`,
    [tenantId, travelId, suggestionId, status, feedback, decidedAt],
  );
  return rows.length > 0;
}

// Registra uma sugestão que nasceu e foi decidida na própria conversa do Ori (proposta no chat, o
// consultor gostou ou não) — nunca passou pelo gerador em massa nem ficou pendente no kanban, por isso
// não reaproveita `applySuggestionDecision`. Aprovada: grava a sugestão E insere o evento no dia a
// dia, na mesma transação. Rejeitada: só grava a sugestão com o motivo — é esse histórico que faz o
// gerador de sugestões (`suggest-day-activities.ts`) e o próprio Ori não oferecerem de novo o que já
// foi recusado. Devolve o evento inserido (aprovada) ou `null` (rejeitada).
export async function createDecidedSuggestion(
  tenantId: string,
  travelId: string,
  userId: string,
  input: NewSuggestionInput,
  status: 'approved' | 'rejected',
  feedback: string | null,
): Promise<DailyScheduleEvent | null> {
  return withTravelScheduleLock(tenantId, travelId, userId, async (client) => {
    const now = new Date().toISOString();
    const suggestion: StoredSuggestion = {
      id: crypto.randomUUID(),
      date: input.date,
      period: input.period,
      event: { ...input.event, content: normalizeEventContent(input.event.content, input.event.title) },
      reason: input.reason,
      status,
      feedback,
      createdAt: now,
      decidedAt: now,
    };
    await client.query(`update travel set suggestions = coalesce(suggestions, '[]'::jsonb) || $1::jsonb where tenant_id = $2 and id = $3`, [
      JSON.stringify([suggestion]),
      tenantId,
      travelId,
    ]);

    if (status === 'rejected') return null;
    return insertScheduleEventWithClient(tenantId, travelId, client, input.date, input.period, {
      ...suggestion.event,
      source: { type: 'suggestion', suggestion_id: suggestion.id },
    });
  });
}

// Move uma sugestão (pendente ou já aprovada) pra outro dia/período — usado pelo drag and drop do
// kanban de sugestões no frontend. Não restringe por `status`: mover uma sugestão já aprovada
// continua fazendo sentido (o cliente decidiu fazer aquilo em outro dia).
export async function moveSuggestion(
  tenantId: string,
  travelId: string,
  suggestionId: string,
  newDate: string,
  newPeriod: 'morning' | 'afternoon' | 'night',
): Promise<boolean> {
  const { rows } = await getPool().query<{ moved: boolean }>(
    `update travel
     set suggestions = coalesce((
       select jsonb_agg(
         case when elem->>'id' = $3
           then elem || jsonb_build_object('date', $4::text, 'period', $5::text)
           else elem
         end
       )
       from jsonb_array_elements(coalesce(suggestions, '[]'::jsonb)) elem
     ), '[]'::jsonb)
     where tenant_id = $1 and id = $2
       and exists (select 1 from jsonb_array_elements(coalesce(suggestions, '[]'::jsonb)) elem where elem->>'id' = $3)
     returning true as moved`,
    [tenantId, travelId, suggestionId, newDate, newPeriod],
  );
  return rows.length > 0;
}

async function saveSuggestions(tenantId: string, travelId: string, suggestions: StoredSuggestion[], client: Queryable): Promise<void> {
  await client.query(`update travel set suggestions = $1::jsonb where tenant_id = $2 and id = $3`, [JSON.stringify(suggestions), tenantId, travelId]);
}

export interface NewSuggestionInput {
  date: string;
  period: 'morning' | 'afternoon' | 'night';
  event: { title: string; content: string; type: string; observation: string | null };
  reason: string | null;
}

// Cria UMA sugestão pendente a partir da conversa (sem passar pelo gerador em massa) — ela aparece
// no kanban de sugestões pra ser decidida depois, igual às geradas por `sugerirAtividades`. Usada
// pela tool `criarSugestao` do Ori e pela rota `POST /travel_agent/schedule-suggestion/item`.
export async function createPendingSuggestion(tenantId: string, travelId: string, userId: string, input: NewSuggestionInput): Promise<StoredSuggestion> {
  const suggestion: StoredSuggestion = {
    id: crypto.randomUUID(),
    date: input.date,
    period: input.period,
    event: { ...input.event, content: normalizeEventContent(input.event.content, input.event.title) },
    reason: input.reason,
    status: 'pending',
    feedback: null,
    createdAt: new Date().toISOString(),
    decidedAt: null,
  };
  await appendPendingSuggestions(tenantId, travelId, userId, [suggestion]);
  return suggestion;
}

export interface SuggestionPatch {
  title?: string;
  content?: string;
  type?: string;
  reason?: string | null;
  date?: string;
  period?: 'morning' | 'afternoon' | 'night';
}

// Altera texto e/ou dia/período de uma sugestão AINDA PENDENTE. Uma aprovada já virou evento do dia
// a dia — aí o que se edita é o evento (`updateDailyScheduleEvent`), não a sugestão. Devolve `null`
// se o id não existir ou a sugestão já tiver sido decidida. Usada pela tool `atualizarSugestao` e
// pela rota `PATCH /travel_agent/schedule-suggestion/item`.
export async function updatePendingSuggestion(
  tenantId: string,
  travelId: string,
  userId: string,
  suggestionId: string,
  patch: SuggestionPatch,
): Promise<StoredSuggestion | null> {
  return withTravelScheduleLock(tenantId, travelId, userId, async (client) => {
    const suggestions = await getSuggestions(tenantId, travelId, client);
    const current = suggestions.find((s) => s.id === suggestionId && s.status === 'pending');
    if (!current) return null;

    const updated: StoredSuggestion = {
      ...current,
      date: patch.date ?? current.date,
      period: patch.period ?? current.period,
      reason: patch.reason !== undefined ? patch.reason : current.reason,
      event: {
        ...current.event,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.content !== undefined ? { content: normalizeEventContent(patch.content, patch.title ?? current.event.title) } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
      },
    };
    await saveSuggestions(tenantId, travelId, suggestions.map((s) => (s.id === suggestionId ? updated : s)), client);
    return updated;
  });
}

export interface ApprovedSuggestionsBackfill {
  inserted: { date: string; period: string; title: string }[];
  duplicates: { date: string; period: string; title: string }[];
}

// Migração única: sugestões aprovadas ANTES de aprovar passar a inserir o evento continuam só como
// "sugestão aprovada" (card fora da cronologia do dia a dia). Isto põe cada uma no dia a dia como
// evento de verdade (`source: suggestion`). Duplicada (mesmo título no mesmo dia/período de um
// evento que já existe) não vira outro evento — a sugestão repetida é apagada. `apply: false` só
// relata o que faria, sem gravar. Usada por `scripts/backfill-approved-suggestions.ts`.
export async function backfillApprovedSuggestions(tenantId: string, travelId: string, apply: boolean): Promise<ApprovedSuggestionsBackfill> {
  const { rows } = await getPool().query<{ created_by: string | null }>(`select created_by from travel where tenant_id = $1 and id = $2`, [
    tenantId,
    travelId,
  ]);
  const ownerId = rows[0]?.created_by;
  if (!ownerId) return { inserted: [], duplicates: [] };

  return withTravelScheduleLock(tenantId, travelId, ownerId, async (client) => {
    const state = await getTravelSchedule(tenantId, travelId, client);
    const parsed = dailyScheduleSchema.safeParse(state.dailySchedule);
    const days = parsed.success ? parsed.data : [];
    const suggestions = await getSuggestions(tenantId, travelId, client);

    const result = addApprovedSuggestions(days, suggestions);
    const describe = (id: string) => {
      const s = suggestions.find((x) => x.id === id)!;
      return { date: s.date, period: s.period, title: s.event.title };
    };

    if (apply && (result.insertedIds.length > 0 || result.duplicateIds.length > 0)) {
      const { travelStartAt, travelEndAt } = scheduleRange(result.days);
      await saveTravelSchedule(tenantId, travelId, { dailySchedule: result.days, travelStartAt, travelEndAt }, client);
      const duplicates = new Set(result.duplicateIds);
      await saveSuggestions(tenantId, travelId, suggestions.filter((s) => !duplicates.has(s.id)), client);
    }
    return { inserted: result.insertedIds.map(describe), duplicates: result.duplicateIds.map(describe) };
  });
}

// Remove uma sugestão por completo (qualquer status). Diferente de rejeitar: some do histórico e da
// "inteligência" da viagem. Se ela já tinha sido aprovada, o evento que ela virou no dia a dia sai
// junto, na mesma transação — antes o evento ficava órfão. Usada pela tool `removerSugestao` e pela
// rota `DELETE /travel_agent/schedule-suggestion/decision` (botão de apagar do histórico).
export async function removeSuggestion(tenantId: string, travelId: string, userId: string, suggestionId: string): Promise<StoredSuggestion | null> {
  return withTravelScheduleLock(tenantId, travelId, userId, async (client) => {
    const suggestions = await getSuggestions(tenantId, travelId, client);
    const removed = suggestions.find((s) => s.id === suggestionId);
    if (!removed) return null;

    await saveSuggestions(tenantId, travelId, suggestions.filter((s) => s.id !== suggestionId), client);

    if (removed.status === 'approved') {
      const state = await getTravelSchedule(tenantId, travelId, client);
      const parsed = dailyScheduleSchema.safeParse(state.dailySchedule);
      if (parsed.success) {
        const days = withoutSuggestion(parsed.data, suggestionId);
        const { travelStartAt, travelEndAt } = scheduleRange(days);
        await saveTravelSchedule(tenantId, travelId, { dailySchedule: days, travelStartAt, travelEndAt }, client);
      }
    }
    return removed;
  });
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

export interface UpdateVoucherInput {
  title?: string | null;
  content?: string | null;
  voucherTypeSlug?: string;
  // Mesma ressalva de `insertVoucher` sobre jsonb-como-string: serializado duas vezes aqui embaixo
  // antes de ir pro Postgres.
  aiExtractedData?: Record<string, unknown> | null;
}

// Atualiza campos de um voucher já existente (usado pela tool "atualizarDocumento" do agente Ori,
// `agents/ori/tools/update-voucher-tool.ts`) — só grava os campos presentes em `input` (chave
// ausente = não toca nesse campo; chave presente com `null` = limpa o campo). Sempre escopado por
// tenant_id + travel_id, mesmo cuidado de `deleteVoucher`, pra nunca editar voucher de outra
// viagem/tenant mesmo sabendo o id.
export async function updateVoucherFields(
  tenantId: string,
  travelId: string,
  voucherId: string,
  input: UpdateVoucherInput,
): Promise<VoucherRecord | null> {
  const columns: string[] = [];
  const values: unknown[] = [];

  if ('title' in input) {
    columns.push('title');
    values.push(input.title);
  }
  if ('content' in input) {
    columns.push('content');
    values.push(input.content);
  }
  if ('voucherTypeSlug' in input) {
    columns.push('voucher_type_slug');
    values.push(input.voucherTypeSlug);
  }
  if ('aiExtractedData' in input) {
    columns.push('ai_extracted_data');
    values.push(input.aiExtractedData ? JSON.stringify(JSON.stringify(input.aiExtractedData)) : null);
  }
  if (columns.length === 0) {
    throw new Error('updateVoucherFields: nenhum campo para atualizar.');
  }

  const setClause = columns.map((column, index) => `${column} = $${index + 4}`).join(', ');
  const { rows } = await getPool().query<VoucherRecord>(
    `update voucher set ${setClause} where tenant_id = $1 and travel_id = $2 and id = $3
     returning id, tenant_id, travel_id, title, content, voucher_type_slug, file_url, ai_extracted_data, created_at as "createdAt"`,
    [tenantId, travelId, voucherId, ...values],
  );
  return rows[0] ?? null;
}

// --- Histórico do chat do Ori (tabela `ori_chat_session`, ver `sql/ori_chat_session.sql`) ---
// Transcrição no formato que o drawer do front renderiza, não no formato interno do Mastra Memory.
// Toda leitura/escrita é escopada por tenant + viagem + usuário: cada consultor só vê as próprias
// sessões.

export type OriChatMessage =
  | { id: string; role: 'user'; content: string; created_at: string }
  | {
      id: string;
      role: 'assistant';
      // Envelope `OriResponse` serializado, igual ao corpo que `POST /travel_agent/ori` devolve.
      raw: string;
      // Só presente quando a resposta pausou num `pending_approval` — usado pra achar o cartão ao
      // registrar a decisão (`recordOriApprovalDecision`).
      tool_call_id?: string;
      approval_decision?: 'approved' | 'rejected';
      created_at: string;
    };

export interface OriChatSessionSummary {
  session_id: string;
  title: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface OriChatSession extends OriChatSessionSummary {
  messages: OriChatMessage[];
}

const ORI_CHAT_TITLE_MAX = 120;

// Acrescenta mensagens no fim da sessão, criando a linha na primeira mensagem (o título vira o
// primeiro prompt). O `where` do upsert impede que um `session_id` reaproveitado por outro
// tenant/usuário escreva numa sessão que não é dele.
export async function appendOriChatMessages(
  tenantId: string,
  travelId: string,
  userId: string,
  sessionId: string,
  messages: OriChatMessage[],
  title: string,
): Promise<void> {
  await getPool().query(
    `insert into ori_chat_session (tenant_id, travel_id, session_id, user_id, title, messages)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (travel_id, session_id) do update
       set messages = ori_chat_session.messages || excluded.messages, updated_at = now()
       where ori_chat_session.tenant_id = excluded.tenant_id and ori_chat_session.user_id = excluded.user_id`,
    [tenantId, travelId, sessionId, userId, title.slice(0, ORI_CHAT_TITLE_MAX), JSON.stringify(messages)],
  );
}

// Marca a decisão no cartão de aprovação (`tool_call_id`) e acrescenta a resposta seguinte do
// Ori, numa única escrita.
export async function recordOriApprovalDecision(
  tenantId: string,
  travelId: string,
  userId: string,
  sessionId: string,
  toolCallId: string,
  decision: 'approved' | 'rejected',
  reply: OriChatMessage,
): Promise<void> {
  await getPool().query(
    `update ori_chat_session
     set messages = coalesce(
           (select jsonb_agg(
                     case when elem->>'tool_call_id' = $5 then elem || jsonb_build_object('approval_decision', $6::text) else elem end
                     order by ord)
            from jsonb_array_elements(messages) with ordinality as t(elem, ord)),
           '[]'::jsonb
         ) || $7::jsonb,
         updated_at = now()
     where tenant_id = $1 and travel_id = $2 and user_id = $3 and session_id = $4`,
    [tenantId, travelId, userId, sessionId, toolCallId, decision, JSON.stringify([reply])],
  );
}

// Página de sessões, mais recente primeiro. Busca uma linha a mais que `limit` só pra saber se
// ainda há outra página (`has_more`) sem precisar de um `count(*)`.
export async function listOriChatSessions(
  tenantId: string,
  travelId: string,
  userId: string,
  limit: number,
  offset = 0,
): Promise<{ sessions: OriChatSessionSummary[]; hasMore: boolean }> {
  const { rows } = await getPool().query<OriChatSessionSummary>(
    `select session_id, title, jsonb_array_length(messages)::int as message_count, created_at, updated_at
     from ori_chat_session
     where tenant_id = $1 and travel_id = $2 and user_id = $3
     order by updated_at desc, session_id
     limit $4 offset $5`,
    [tenantId, travelId, userId, limit + 1, offset],
  );
  return { sessions: rows.slice(0, limit), hasMore: rows.length > limit };
}

// Apaga a sessão do histórico — só se for do usuário autenticado. `false` = não achou (ou não é dele).
export async function deleteOriChatSession(tenantId: string, travelId: string, userId: string, sessionId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `delete from ori_chat_session
     where tenant_id = $1 and travel_id = $2 and user_id = $3 and session_id = $4`,
    [tenantId, travelId, userId, sessionId],
  );
  return (rowCount ?? 0) > 0;
}

export async function getOriChatSession(tenantId: string, travelId: string, userId: string, sessionId: string): Promise<OriChatSession | null> {
  const { rows } = await getPool().query<OriChatSession>(
    `select session_id, title, messages, jsonb_array_length(messages)::int as message_count, created_at, updated_at
     from ori_chat_session
     where tenant_id = $1 and travel_id = $2 and user_id = $3 and session_id = $4`,
    [tenantId, travelId, userId, sessionId],
  );
  return rows[0] ?? null;
}
