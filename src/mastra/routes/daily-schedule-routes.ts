import { registerApiRoute } from '@mastra/core/server';
import { generateDailySchedule } from '../agents/daily-schedule/generate-daily-schedule';
import { getTenantIdByTravelId, getTenantIdByEmail } from '../services/travel-db';
import { extractBearerToken, verifySupabaseAccessToken, UnauthorizedError } from '../services/supabase-auth';
import { logConversationError } from '../helpers/logger';

// Mesmo contrato de autenticação de `voucher-routes.ts`: o frontend manda o access_token do
// Supabase Auth do usuário (`Authorization: Bearer <access_token>`), não a chave estática
// (`ORIGINAL_MILES_API_KEY`) do resto do server — por isso `requiresAuth: false` + verificação
// própria dentro da rota. Devolve também `userId` (o `auth.uid()` real do usuário logado) —
// necessário pra `ensureTravelExists` (ver `travel-db.ts`), já que `auth.uid()` não resolve
// sozinho na conexão direta via `pg` usada por trás dessas rotas.
async function resolveTenantId(authorizationHeader: string | undefined | null): Promise<{ tenantId: string; userId: string }> {
  const token = extractBearerToken(authorizationHeader);
  const user = await verifySupabaseAccessToken(token);
  const tenantId = await getTenantIdByEmail(user.email);
  if (!tenantId) {
    throw new UnauthorizedError(`Nenhum tenant encontrado para o e-mail "${user.email}" (tabela team).`);
  }
  return { tenantId, userId: user.id };
}

export const dailyScheduleGenerateRoute = registerApiRoute('/travel_agent/daily-schedule', {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Gera do zero o roteiro dia a dia (daily_schedule) de uma viagem a partir dos vouchers já extraídos',
    description:
      'Recebe `travel_id` e `session_id`. Reconstrói o roteiro completo (um item por dia entre o primeiro e o último dia do ' +
      'itinerário, incluindo dias sem evento) a partir de TODOS os vouchers já extraídos da viagem, grava em `travel.daily_schedule` ' +
      '(e atualiza `travel_start_at`/`travel_end_at`) e devolve o resultado. Complementar ao update incremental disparado a cada ' +
      'novo voucher (`agents/daily-schedule/rebuild-daily-schedule.ts`) — este endpoint é para gerar/reconstruir sob demanda.',
    tags: ['Daily Schedule'],
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

    const body = await c.req.json().catch(() => null);
    const travelId = (body as { travel_id?: unknown } | null)?.travel_id;
    const sessionId = (body as { session_id?: unknown } | null)?.session_id;

    if (typeof travelId !== 'string' || !travelId) {
      return c.json({ error: 'bad_request', message: '"travel_id" é obrigatório.' }, 400);
    }
    if (typeof sessionId !== 'string' || !sessionId) {
      return c.json({ error: 'bad_request', message: '"session_id" é obrigatório.' }, 400);
    }

    // `travel_id` sozinho não escopa por tenant — confirma que, SE a viagem já existir em
    // `travel`, ela pertence ao tenant do usuário autenticado (senão um `travel_id` de outro
    // tenant passaria pelas queries scoped e só produziria um roteiro vazio, silenciosamente).
    // Só bloqueia em caso de mismatch de verdade — `travelTenantId` null (viagem ainda não tem
    // linha em `travel`, comum: vouchers podem ser extraídos antes disso, ver `insertVoucher`)
    // segue em frente, e `generateDailySchedule` cria a linha (`ensureTravelExists`, dentro do
    // lock) antes de gravar.
    const travelTenantId = await getTenantIdByTravelId(travelId);
    if (travelTenantId && travelTenantId !== tenantId) {
      return c.json({ error: 'not_found', message: `Viagem ${travelId} não encontrada.` }, 404);
    }

    try {
      const { response, analysedDocIds } = await generateDailySchedule(tenantId, travelId, userId);
      return c.json({ response, analysed_doc_ids: analysedDocIds }, 200);
    } catch (error) {
      logConversationError(travelId, `falha ao gerar daily_schedule (session_id ${sessionId})`, error);
      return c.json({ error: 'generation_failed', message: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
});
