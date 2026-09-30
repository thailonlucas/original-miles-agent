import { learnFromSession } from './ori-memory-learner-agent';

// Fire-and-forget depois que a resposta do Ori já foi gravada no histórico (`routes/ori-routes.ts`):
// a conversa nunca espera o aprendizado, e uma falha aqui só perde um aprendizado.
// `console.error` em vez de `helpers/logger.ts` pelo mesmo motivo de
// `daily-schedule/daily-schedule-trigger.ts` (logger importa `mastra-instance`, que importa este agente).
export function triggerOriMemoryLearning(tenantId: string, travelId: string, userId: string, sessionId: string): void {
  void learnFromSession(tenantId, travelId, userId, sessionId).catch((error) =>
    console.error(`[memória do Ori] falha ao aprender com a sessão ${sessionId} (viagem ${travelId})`, error),
  );
}
