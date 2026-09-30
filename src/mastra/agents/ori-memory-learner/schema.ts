import { z } from 'zod';
import { USER_MEMORY_KINDS } from '../../services/ori-memory-db';

// Campos todos obrigatórios (null quando não se aplicam) em vez de união discriminada: o structured
// output da OpenAI em modo estrito lida melhor com um objeto plano. `learn-from-session.ts` valida
// cada operação antes de aplicar.
const memoryOperationSchema = z.object({
  op: z
    .enum(['add', 'reinforce', 'update', 'remove'])
    .describe(
      '"add": padrão novo. "reinforce": a conversa mostra de novo um padrão que já está na memória. "update": reescrever um item ' +
        'aprendido que ficou impreciso. "remove": o consultor mostrou o contrário de um item aprendido.',
    ),
  id: z.string().nullable().describe('Id do item da memória atual (reinforce/update/remove). null em "add".'),
  text: z
    .string()
    .nullable()
    .describe('A regra, curta, no imperativo, válida pra qualquer viagem (add/update). null em reinforce/remove.'),
  kind: z.enum(USER_MEMORY_KINDS).nullable().describe('Categoria (add/update). null em reinforce/remove.'),
  evidence_quote: z.string().describe('Trecho curto da conversa (fala do consultor) que sustenta a operação.'),
});

const candidateSchema = z.object({
  existing_id: z.string().nullable().describe('Id de uma candidata pendente que diz a mesma coisa, pra somar evidência. null se é nova.'),
  text: z.string().describe('A regra, curta, no imperativo.'),
  kind: z.enum(USER_MEMORY_KINDS),
  scope_hint: z
    .enum(['tenant', 'base'])
    .describe('"base": o Ori errou de um jeito que qualquer consultor corrigiria (defeito do prompt). "tenant": parece um jeito da agência.'),
  reason: z.string().describe('Por que isso parece valer além deste consultor.'),
});

export const memoryLearningResultSchema = z.object({
  operations: z.array(memoryOperationSchema).describe('Mudanças na memória deste consultor. Vazio se a conversa não ensina nada novo.'),
  candidates: z.array(candidateSchema).describe('Correções que parecem valer pra além deste consultor. Normalmente vazio.'),
});

export type MemoryLearningResult = z.infer<typeof memoryLearningResultSchema>;
