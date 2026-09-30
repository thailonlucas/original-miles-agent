import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { removeUserMemoryItem } from '../../../services/ori-memory-db';

// "Esquecer Preferência" — tira UMA preferência da memória deste consultor (`ori_user_memory`),
// pelo id que aparece na seção "Como este consultor trabalha" do prompt. Sem confirmação: só mexe
// na memória do próprio consultor, que pediu.
export const forgetUserPreferenceTool = createTool({
  id: 'esquecerPreferencia',
  description:
    'Remove UMA preferência da memória deste consultor, pelo id da seção "Como este consultor trabalha". Use quando ele pedir pra ' +
    'esquecer, disser que não vale mais ou pedir o contrário de uma preferência guardada (nesse caso, remova a antiga e anote a nova ' +
    'com "anotarPreferenciaConsultor"). Regras da agência não saem por aqui.',
  inputSchema: z.object({
    id: z.string().min(1).describe('Id da preferência (entre colchetes na seção "Como este consultor trabalha").'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ id }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !userId) {
      throw new Error('esquecerPreferencia: requestContext "tenant_id"/"user_id" são obrigatórios.');
    }
    const removed = await removeUserMemoryItem(tenantId, userId, id);
    return removed ? { removed: true, text: removed.text } : { error: `Preferência ${id} não encontrada.` };
  },
});
