import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { addExplicitUserMemory, MAX_MEMORY_TEXT, USER_MEMORY_KINDS } from '../../../services/ori-memory-db';

// "Anotar Preferência do Consultor" — guarda UMA regra de como ESTE consultor quer trabalhar com o
// Ori (`ori_user_memory`, ver `services/ori-memory-db.ts`). Vale a partir da próxima resposta, em
// todas as sessões e viagens dele. Sem confirmação, como `anotarContextoViagem`: é o próprio
// consultor pedindo, e ele vê/apaga pela tela ou pedindo ao Ori ("esquecerPreferencia").
// Diferente do Contexto da Viagem: aquilo é sobre o CLIENTE; isto é sobre o CONSULTOR.
export const noteUserPreferenceTool = createTool({
  id: 'anotarPreferenciaConsultor',
  description:
    'Guarda UMA preferência de como ESTE consultor quer que você trabalhe — estilo de resposta, formato dos cards, o que perguntar ou ' +
    'não, vocabulário. Use quando ele disser como quer que você faça dali pra frente ("sempre...", "nunca...", "prefiro...", "pode ' +
    'parar de...") ou corrigir a mesma coisa pela segunda vez. Chame na hora, sem perguntar, e siga a conversa. NÃO use pra ' +
    'informação do cliente/viagem (isso é "anotarContextoViagem") nem pra algo que só vale pra esta mensagem.',
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .max(MAX_MEMORY_TEXT)
      .describe('A regra, curta, no imperativo, válida pra qualquer viagem (ex: "Cards do dia a dia só com o horário quando não houver mais nada").'),
    kind: z
      .enum(USER_MEMORY_KINDS)
      .describe('"conversa" (tom/tamanho das respostas), "cards" (formato de eventos/sugestões), "fluxo" (o que perguntar, quando agir), "vocabulario" (termos que ele usa).'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ text, kind }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const userId = requestContext.get<string, string>('user_id');
    const sessionId = requestContext.get<string, string | undefined>('session_id');
    if (!tenantId || !userId) {
      throw new Error('anotarPreferenciaConsultor: requestContext "tenant_id"/"user_id" são obrigatórios.');
    }
    const result = await addExplicitUserMemory(tenantId, userId, text, kind, sessionId);
    return 'error' in result ? result : { saved: true, id: result.item.id, text: result.item.text };
  },
});
