import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { updateVoucherFields } from '../../../services/travel-db';
import { triggerDailyScheduleUpdate } from './daily-schedule-trigger';

// "Atualizar Documento" — corrige/complementa um voucher já existente (title, content e/ou
// ai_extracted_data) pelo doc_id. `tenant_id`/`travel_id`/`user_id` vêm do `requestContext`
// (mesmo contrato de `search-voucher-tool.ts`), nunca de argumento que o model preenche.
export const updateVoucherTool = createTool({
  id: 'atualizarDocumento',
  description:
    'Atualiza um voucher (documento) já existente, pelo doc_id da lista de vouchers disponível. Use quando o consultor apontar que ' +
    'uma informação extraída está errada, incompleta ou desatualizada, e informar qual é o valor correto. Só envie os campos que ' +
    'realmente precisam mudar — campos não informados permanecem como estão. REGRA OBRIGATÓRIA: ao identificar uma correção possível, ' +
    'primeiro pergunte ao consultor se é isso mesmo que ele quer mudar — nunca chame esta tool na mesma resposta em que você ' +
    'identificou o problema. Só chame depois que ele confirmar explicitamente numa mensagem seguinte.',
  inputSchema: z
    .object({
      docId: z.string().describe('doc_id do voucher a atualizar, da lista de vouchers disponível.'),
      title: z.string().optional().describe('Novo título do voucher, se precisar mudar.'),
      content: z.string().optional().describe('Novo conteúdo/resumo do voucher, se precisar mudar.'),
      aiExtractedData: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Novos dados extraídos do voucher (objeto completo, substitui o anterior), se precisar corrigir algum detalhe.'),
    })
    .refine((value) => value.title !== undefined || value.content !== undefined || value.aiExtractedData !== undefined, {
      message: 'Informe ao menos um campo para atualizar (title, content ou aiExtractedData).',
    }),
  outputSchema: z.unknown(),
  execute: async ({ docId, title, content, aiExtractedData }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('atualizarDocumento: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    const fields: { title?: string; content?: string; aiExtractedData?: Record<string, unknown> } = {};
    if (title !== undefined) fields.title = title;
    if (content !== undefined) fields.content = content;
    if (aiExtractedData !== undefined) fields.aiExtractedData = aiExtractedData;

    const updated = await updateVoucherFields(tenantId, travelId, docId, fields);
    if (!updated) {
      return { error: `voucher ${docId} não encontrado nesta viagem.` };
    }

    triggerDailyScheduleUpdate(
      tenantId,
      travelId,
      { id: updated.id, title: updated.title, voucherTypeSlug: updated.voucher_type_slug, content: updated.content },
      userId,
    );
    return updated;
  },
});
