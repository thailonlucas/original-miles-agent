import { decideSuggestion, getSuggestions, insertScheduleEventWithClient, withTravelScheduleLock } from '../../services/travel-db';
import type { DailyScheduleEvent } from '../daily-schedule/schema';

export interface SuggestionDecisionInput {
  id: string;
  status: 'approved' | 'rejected';
  feedback: string | null;
}

export interface SuggestionDecisionResult {
  decided: boolean;
  // Preenchido só quando `status: 'approved'` e a decisão foi de fato aplicada.
  event: DailyScheduleEvent | null;
}

// Aplica a decisão da pessoa sobre UMA sugestão já persistida (gerada como "pending" em
// `appendPendingSuggestions`, ver `suggest-day-activities.ts`) — única função usada tanto pela
// rota (`routes/schedule-suggestion-decision-routes.ts`, botão de aprovar/rejeitar do front) quanto
// pela tool `decidirSugestao` do Ori, pra garantir que os dois fluxos decidem uma sugestão do
// mesmo jeito, nunca com lógica duplicada.
//
// "rejected": só grava `status`/`feedback`/`decidedAt` — não mexe em `daily_schedule`.
// "approved": grava a decisão E insere o evento dela em `daily_schedule`, atomicamente (mesmo
// lock/transação) — aprovar uma sugestão passa a valer como o consultor confirmando que aquela
// atividade entra no dia a dia de verdade, mesmo sem um voucher por trás (ver a regra de
// confirmação explícita antes de aprovar na description de `decidirSugestao`).
//
// Devolve `{ decided: false, event: null }` se o id não existir ou já tiver sido decidido antes
// (evita decidir duas vezes).
export async function applySuggestionDecision(
  tenantId: string,
  travelId: string,
  userId: string,
  input: SuggestionDecisionInput,
): Promise<SuggestionDecisionResult> {
  if (input.status === 'rejected') {
    const decided = await decideSuggestion(tenantId, travelId, input.id, 'rejected', input.feedback);
    return { decided, event: null };
  }

  return withTravelScheduleLock(tenantId, travelId, userId, async (client) => {
    const suggestions = await getSuggestions(tenantId, travelId, client);
    const suggestion = suggestions.find((s) => s.id === input.id && s.status === 'pending');
    if (!suggestion) return { decided: false, event: null };

    const decided = await decideSuggestion(tenantId, travelId, input.id, 'approved', input.feedback, client);
    if (!decided) return { decided: false, event: null };

    const event = await insertScheduleEventWithClient(tenantId, travelId, client, suggestion.date, suggestion.period, {
      ...suggestion.event,
      source: { type: 'suggestion', suggestion_id: suggestion.id },
    });
    return { decided: true, event };
  });
}
