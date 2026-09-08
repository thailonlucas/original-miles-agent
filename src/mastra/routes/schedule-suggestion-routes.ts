import { registerApiRoute } from '@mastra/core/server';
import { suggestDayActivities } from '../agents/schedule-suggestion/suggest-day-activities';
import { getTenantIdByEmail, getTenantIdByTravelId } from '../services/travel-db';
import { extractBearerToken, verifySupabaseAccessToken, UnauthorizedError } from '../services/supabase-auth';
import { logConversationError } from '../helpers/logger';

// Mesmo contrato de autenticação de `voucher-routes.ts`/`daily-schedule-routes.ts`: o frontend
// manda o access_token do Supabase Auth do usuário (`Authorization: Bearer <access_token>`), não a
// chave estática (`ORIGINAL_MILES_API_KEY`) do resto do server.
async function resolveTenantId(authorizationHeader: string | undefined | null): Promise<string> {
  const token = extractBearerToken(authorizationHeader);
  const user = await verifySupabaseAccessToken(token);
  const tenantId = await getTenantIdByEmail(user.email);
  if (!tenantId) {
    throw new UnauthorizedError(`Nenhum tenant encontrado para o e-mail "${user.email}" (tabela team).`);
  }
  return tenantId;
}

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const scheduleSuggestionRoute = registerApiRoute('/travel_agent/schedule-suggestion', {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Sugere atividades para um dia específico do roteiro de uma viagem',
    description:
      'Recebe `travel_id` e `day` (YYYY-MM-DD). Pra cada período do dia (manhã/tarde/noite): se já houver evento confirmado no ' +
      '`daily_schedule`, sugere atividades ADICIONAIS que façam sentido com o que já está agendado (ex: proximidade geográfica); se o ' +
      'período está livre, sugere um punhado de opções plausíveis com base nos vouchers da viagem e no destino identificado. Não grava ' +
      'nada em `travel.daily_schedule` — cada sugestão aprovada pelo usuário deve ser inserida no roteiro separadamente.',
    tags: ['Schedule Suggestion'],
  },
  handler: async (c) => {
    let tenantId: string;
    try {
      tenantId = await resolveTenantId(c.req.header('Authorization'));
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return c.json({ error: 'unauthorized', message: error.message }, 401);
      }
      throw error;
    }

    const body = await c.req.json().catch(() => null);
    const travelId = (body as { travel_id?: unknown } | null)?.travel_id;
    const day = (body as { day?: unknown } | null)?.day;

    if (typeof travelId !== 'string' || !travelId) {
      return c.json({ error: 'bad_request', message: '"travel_id" é obrigatório.' }, 400);
    }
    if (typeof day !== 'string' || !DAY_REGEX.test(day)) {
      return c.json({ error: 'bad_request', message: '"day" é obrigatório e deve estar no formato YYYY-MM-DD.' }, 400);
    }

    // `travel_id` sozinho não escopa por tenant — confirma que, SE a viagem já existir em
    // `travel`, ela pertence ao tenant do usuário autenticado (mesmo cuidado de
    // `daily-schedule-routes.ts`). `travelTenantId` null (viagem ainda sem linha em `travel`,
    // comum antes do primeiro daily-schedule gerado) segue em frente — sem vouchers/roteiro pra
    // essa viagem ainda, o agente só devolve sugestões genéricas sem contexto.
    const travelTenantId = await getTenantIdByTravelId(travelId);
    if (travelTenantId && travelTenantId !== tenantId) {
      return c.json({ error: 'not_found', message: `Viagem ${travelId} não encontrada.` }, 404);
    }

    try {
      const suggestion = await suggestDayActivities(tenantId, travelId, day);
      return c.json(suggestion, 200);
    } catch (error) {
      logConversationError(travelId, `falha ao gerar sugestões de roteiro para o dia ${day}`, error);
      return c.json({ error: 'suggestion_failed', message: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
});
