import { registerApiRoute } from '@mastra/core/server';
import { suggestDayActivities } from '../agents/schedule-suggestion/suggest-day-activities';
import { getTenantIdByEmail, getTenantIdByTravelId } from '../services/travel-db';
import { extractBearerToken, verifySupabaseAccessToken, UnauthorizedError } from '../services/supabase-auth';
import { logConversationError } from '../helpers/logger';

// Mesmo contrato de autenticação de `voucher-routes.ts`/`daily-schedule-routes.ts`: o frontend
// manda o access_token do Supabase Auth do usuário (`Authorization: Bearer <access_token>`), não a
// chave estática (`ORIGINAL_MILES_API_KEY`) do resto do server.
async function resolveTenantId(authorizationHeader: string | undefined | null): Promise<{ tenantId: string; userId: string }> {
  const token = extractBearerToken(authorizationHeader);
  const user = await verifySupabaseAccessToken(token);
  const tenantId = await getTenantIdByEmail(user.email);
  if (!tenantId) {
    throw new UnauthorizedError(`Nenhum tenant encontrado para o e-mail "${user.email}" (tabela team).`);
  }
  return { tenantId, userId: user.id };
}

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const scheduleSuggestionRoute = registerApiRoute('/travel_agent/schedule-suggestion', {
  method: 'POST',
  requiresAuth: false,
  openapi: {
    summary: 'Sugere atividades para um dia específico do roteiro de uma viagem',
    description:
      'Recebe `travel_id` e `day` (YYYY-MM-DD). Opcionalmente aceita `prompt` (texto livre do cliente descrevendo o tipo de recomendação ' +
      'que busca, ex: "passeio no parque", "dia na praia") e `quantity` (1 a 5, quantas sugestões gerar por período livre — default 3). ' +
      'Pra cada período do dia (manhã/tarde/noite): se já houver evento confirmado no `daily_schedule`, sugere atividades ADICIONAIS que ' +
      'façam sentido com o que já está agendado (ex: proximidade geográfica); se o período está livre, sugere um punhado de opções ' +
      'plausíveis com base nos vouchers da viagem, no destino identificado e no `prompt` do cliente (se houver). Não grava nada em ' +
      '`travel.daily_schedule` — cada sugestão aprovada pelo usuário deve ser inserida no roteiro separadamente.',
    tags: ['Schedule Suggestion'],
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
    const day = (body as { day?: unknown } | null)?.day;
    const rawPrompt = (body as { prompt?: unknown } | null)?.prompt;
    const rawQuantity = (body as { quantity?: unknown } | null)?.quantity;

    if (typeof travelId !== 'string' || !travelId) {
      return c.json({ error: 'bad_request', message: '"travel_id" é obrigatório.' }, 400);
    }
    if (typeof day !== 'string' || !DAY_REGEX.test(day)) {
      return c.json({ error: 'bad_request', message: '"day" é obrigatório e deve estar no formato YYYY-MM-DD.' }, 400);
    }
    if (rawPrompt !== undefined && rawPrompt !== null && typeof rawPrompt !== 'string') {
      return c.json({ error: 'bad_request', message: '"prompt", se enviado, deve ser uma string.' }, 400);
    }
    if (rawQuantity !== undefined && rawQuantity !== null && (typeof rawQuantity !== 'number' || !Number.isInteger(rawQuantity))) {
      return c.json({ error: 'bad_request', message: '"quantity", se enviado, deve ser um número inteiro.' }, 400);
    }

    // Corta um prompt absurdamente longo em vez de rejeitar — evita gastar contexto do agente à
    // toa sem travar o fluxo por causa de um texto colado sem querer.
    const prompt = typeof rawPrompt === 'string' ? rawPrompt.trim().slice(0, 500) || null : null;
    const quantity = typeof rawQuantity === 'number' ? Math.min(5, Math.max(1, rawQuantity)) : 3;

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
      const suggestion = await suggestDayActivities(tenantId, travelId, userId, day, prompt, quantity);
      return c.json(suggestion, 200);
    } catch (error) {
      logConversationError(travelId, `falha ao gerar sugestões de roteiro para o dia ${day}`, error);
      return c.json({ error: 'suggestion_failed', message: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
});
