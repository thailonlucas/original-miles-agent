import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { deleteVoucher } from '../../../services/travel-db';
import { triggerDailyScheduleRebuild } from './daily-schedule-trigger';

// "Deletar Documento" — exclui um voucher pelo doc_id. Ação destrutiva e irreversível: só chame
// depois que o consultor confirmar explicitamente que quer excluir aquele voucher específico,
// nunca por iniciativa própria.
export const deleteVoucherTool = createTool({
  id: 'deletarDocumento',
  description:
    'Exclui definitivamente um voucher (documento) da viagem, pelo doc_id da lista de vouchers disponível. Ação irreversível — só ' +
    'use depois que o consultor confirmar explicitamente que quer excluir este voucher específico.',
  inputSchema: z.object({
    docId: z.string().describe('doc_id do voucher a excluir, da lista de vouchers disponível.'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ docId }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('deletarDocumento: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    const deleted = await deleteVoucher(tenantId, travelId, docId);
    if (!deleted) {
      return { error: `voucher ${docId} não encontrado nesta viagem.` };
    }

    triggerDailyScheduleRebuild(tenantId, travelId, userId);
    return { deleted: true };
  },
});
