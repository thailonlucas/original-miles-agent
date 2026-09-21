import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getVoucherExtractedData } from '../../../services/travel-db';

// "Buscar Documento" — abre o `ai_extracted_data` completo de UM voucher pelo doc_id (da lista de
// vouchers já disponível nas instructions, ver `prompts/system-prompt.ts`). Mesmo contrato de
// `agents/daily-schedule/tools/open-voucher-tool.ts`: `tenant_id` vem do `requestContext`, nunca de
// um argumento que o model preenche — evita um voucher de outro tenant vazar por um id
// adivinhado/errado.
export const searchVoucherTool = createTool({
  id: 'buscarDocumento',
  description:
    'Abre os dados completos extraídos de um voucher (documento) específico da viagem, pelo doc_id da lista de vouchers disponível. ' +
    'Use para investigar e conseguir detalhes mais ricos que não estão no resumo (ex: nome dos hóspedes/passageiros, detalhes do hotel, ' +
    'endereços, localizadores) antes de responder ao consultor. Pesquise só quando houver uma tarefa concreta que precise desses ' +
    'detalhes — não abra vouchers apenas para explorar.',
  inputSchema: z.object({
    docId: z.string().describe('doc_id do voucher a abrir, da lista de vouchers disponível.'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ docId }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    if (!tenantId) {
      throw new Error('buscarDocumento: requestContext "tenant_id" é obrigatório.');
    }
    const data = await getVoucherExtractedData(tenantId, docId);
    return data ?? { error: `voucher ${docId} não encontrado ou sem dados extraídos.` };
  },
});
