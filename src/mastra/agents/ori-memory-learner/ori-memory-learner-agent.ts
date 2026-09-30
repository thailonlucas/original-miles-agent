import { Agent } from '@mastra/core/agent';
import { getOriChatSession, type OriChatMessage } from '../../services/travel-db';
import {
  getTenantRules,
  getUserMemory,
  listMemoryCandidates,
  mutateUserMemory,
  newUserMemoryItem,
  normalizeMemoryText,
  trimUserMemory,
  upsertMemoryCandidate,
  type UserMemoryItem,
} from '../../services/ori-memory-db';
import { buildLearnerInstructions, buildLearnerUserMessage, type LearnerTurn } from './prompts/system-prompt';
import { memoryLearningResultSchema, type MemoryLearningResult } from './schema';

// Observa as conversas do Ori e mantém a memória de como cada consultor trabalha
// (`ori_user_memory`) + as candidatas a regra do tenant/prompt base (`ori_memory_candidate`). Roda
// em background depois da resposta (`ori-memory-learner-trigger.ts`), nunca no caminho da conversa.
// Sem tools e sem memória própria: recebe tudo pronto no prompt. Modelo leve — é classificação.
export const oriMemoryLearnerAgent = new Agent({
  id: 'ori-memory-learner',
  name: 'Ori Memory Learner',
  description: 'Aprende, a partir das conversas com o Ori, como cada consultor gosta de trabalhar, e propõe regras do tenant/prompt base.',
  instructions: buildLearnerInstructions(),
  model: 'openai/gpt-5.4-mini',
  defaultOptions: {
    structuredOutput: { schema: memoryLearningResultSchema },
  },
});

// Roda a cada N mensagens do consultor na sessão, olhando as últimas `LEARN_WINDOW` mensagens. A
// janela se sobrepõe entre rodadas de propósito (pra não perder contexto), e não conta em dobro
// porque a evidência é por sessão.
export const LEARN_EVERY_USER_MESSAGES = 3;
const LEARN_WINDOW = 12;
const MAX_TURN_CHARS = 1500;

function toTurns(messages: OriChatMessage[]): LearnerTurn[] {
  return messages.map((m): LearnerTurn => {
    if (m.role === 'user') return { role: 'consultor', text: m.content.slice(0, MAX_TURN_CHARS) };
    let text = m.raw;
    try {
      const parsed = JSON.parse(m.raw) as { response?: string; pending_approval?: { tool_name?: string; args?: unknown } };
      text = parsed.response ?? m.raw;
      // O card que o Ori mandou gravar é o que o consultor mais corrige — sem ele o learner não vê o erro.
      if (parsed.pending_approval) text += `\n[pediu aprovação de ${parsed.pending_approval.tool_name}: ${JSON.stringify(parsed.pending_approval.args)}]`;
    } catch {
      // raw antigo sem JSON: usa o texto como veio.
    }
    if (m.approval_decision) text += `\n[consultor ${m.approval_decision === 'approved' ? 'aprovou' : 'recusou'}]`;
    return { role: 'ori', text: text.slice(0, MAX_TURN_CHARS) };
  });
}

// Aplica as operações da LLM com as regras do código: item explícito é do consultor (o learner nunca
// altera nem remove), "add" de algo que já existe vira reforço, e a mesma sessão não conta duas vezes.
export function applyLearnedOperations(items: UserMemoryItem[], operations: MemoryLearningResult['operations'], sessionId: string): UserMemoryItem[] {
  let next = items;
  const now = new Date().toISOString();
  const withEvidence = (item: UserMemoryItem): UserMemoryItem =>
    item.evidence.includes(sessionId) ? item : { ...item, evidence: [...item.evidence, sessionId], updated_at: now };
  const replace = (item: UserMemoryItem) => (next = next.map((i) => (i.id === item.id ? item : i)));

  for (const op of operations) {
    const target = op.id ? next.find((i) => i.id === op.id) : undefined;
    if (op.op === 'add' && op.text && op.kind) {
      const same = next.find((i) => normalizeMemoryText(i.text) === normalizeMemoryText(op.text!));
      if (same) replace(withEvidence(same));
      else next = [...next, newUserMemoryItem(op.text, op.kind, 'aprendido', sessionId)];
    } else if (op.op === 'reinforce' && target) {
      replace(withEvidence(target));
    } else if (op.op === 'update' && target?.source === 'aprendido' && op.text) {
      replace({ ...withEvidence(target), text: op.text.trim(), ...(op.kind ? { kind: op.kind } : {}), updated_at: now });
    } else if (op.op === 'remove' && target?.source === 'aprendido') {
      next = next.filter((i) => i.id !== target.id);
    }
  }
  return next === items ? items : trimUserMemory(next);
}

export async function learnFromSession(tenantId: string, travelId: string, userId: string, sessionId: string): Promise<void> {
  const session = await getOriChatSession(tenantId, travelId, userId, sessionId);
  if (!session) return;
  const userMessages = session.messages.filter((m) => m.role === 'user').length;
  if (userMessages === 0 || userMessages % LEARN_EVERY_USER_MESSAGES !== 0) return;

  const [items, tenantRules, pending] = await Promise.all([
    getUserMemory(tenantId, userId),
    getTenantRules(tenantId),
    listMemoryCandidates(tenantId, 'pending'),
  ]);
  const turns = toTurns(session.messages.slice(-LEARN_WINDOW));
  const { object } = await oriMemoryLearnerAgent.generate(buildLearnerUserMessage(items, tenantRules, pending, turns));

  if (object.operations.length > 0) {
    await mutateUserMemory(tenantId, userId, (current) => ({ items: applyLearnedOperations(current, object.operations, sessionId), result: null }));
  }
  for (const candidate of object.candidates) {
    await upsertMemoryCandidate(
      tenantId,
      { existingId: candidate.existing_id, text: candidate.text, kind: candidate.kind, scopeHint: candidate.scope_hint, reason: candidate.reason },
      { user_id: userId, session_id: sessionId },
    );
  }
}
