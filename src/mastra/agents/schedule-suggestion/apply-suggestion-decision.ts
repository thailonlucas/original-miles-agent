import { decideSuggestion } from '../../services/travel-db';

export interface SuggestionDecisionInput {
  id: string;
  status: 'approved' | 'rejected';
  feedback: string | null;
}

// Aplica a decisão da pessoa sobre UMA sugestão já persistida (gerada como "pending" em
// `appendPendingSuggestions`, ver `suggest-day-activities.ts`) — só atualiza `status`/`feedback`/
// `decidedAt` dela por `id`, nunca insere nada em `travel.daily_schedule`: aprovar registra a
// intenção do cliente ("isso combina com o que ele quer"), não confirma que a atividade vai
// acontecer de fato (não há reserva/voucher por trás). Virar um evento real do roteiro exige um
// voucher de verdade sendo extraído depois.
//
// Devolve `false` se o id não existir ou já tiver sido decidido antes (evita decidir duas vezes).
export async function applySuggestionDecision(tenantId: string, travelId: string, input: SuggestionDecisionInput): Promise<boolean> {
  return decideSuggestion(tenantId, travelId, input.id, input.status, input.feedback);
}
