import { appendApprovedSuggestion, ensureTravelExists, type ScheduleSuggestionDecision } from '../../services/travel-db';
import type { SchedulePeriod } from './schema';

export interface SuggestionDecisionInput {
  day: string; // YYYY-MM-DD
  period: SchedulePeriod;
  event: { title: string; content: string; type: string; observation: string | null };
  reason: string | null;
  status: 'approved' | 'rejected';
}

// Aplica a decisão do cliente sobre UMA sugestão do agente `schedule-suggestion`: só loga a decisão
// (aprovada OU rejeitada) em `travel.approved_suggestions` — histórico usado como "inteligência" da
// viagem pras próximas chamadas de sugestão (ver `suggest-day-activities.ts` -> `getApprovedSuggestions`)
// e exposto pro frontend mostrar pro usuário (`routes/schedule-suggestion-decision-routes.ts` GET).
//
// Uma sugestão APROVADA nunca vira evento em `travel.daily_schedule` sozinha — aprovar só registra
// a intenção do cliente ("isso combina com o que ele quer"), não confirma que a atividade vai
// acontecer de fato (não há reserva/voucher por trás). Virar um evento real do roteiro exige um
// voucher de verdade sendo extraído depois — misturar os dois deixava o dia a dia mostrando como
// certo algo que ainda não tinha nenhuma confirmação por trás.
export async function applySuggestionDecision(
  tenantId: string,
  travelId: string,
  input: SuggestionDecisionInput,
  userId: string,
): Promise<void> {
  // Garante a linha em `travel` antes de gravar `approved_suggestions` — mesmo motivo de
  // `ensureTravelExists` nas outras escritas (vouchers podem ser extraídos antes de qualquer
  // daily_schedule, então a viagem pode não ter linha ainda quando a primeira sugestão é decidida).
  await ensureTravelExists(tenantId, travelId, userId);

  const decision: ScheduleSuggestionDecision = {
    date: input.day,
    period: input.period,
    event: input.event,
    reason: input.reason,
    status: input.status,
    decidedAt: new Date().toISOString(),
  };
  await appendApprovedSuggestion(tenantId, travelId, decision);
}
