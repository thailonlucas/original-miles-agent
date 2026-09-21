import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { insertVoucher } from '../../../services/travel-db';
import { triggerDailyScheduleUpdate } from './daily-schedule-trigger';

// Sem classificação automática de tipo aqui (isso é o pipeline de upload/extração, ver
// `routes/voucher-routes.ts`) — o consultor está descrevendo o voucher em texto livre no chat, não
// enviando um arquivo. "other" é o mesmo fallback usado lá quando o tipo não pôde ser determinado.
const FALLBACK_VOUCHER_TYPE_SLUG = 'other';

// "Criar Documento" — cria um voucher novo a partir de uma informação relevante que o consultor
// mandou no chat (não veio de upload/OCR). REGRA CENTRAL: nunca crie um voucher sem primeiro
// perguntar ao consultor se ele quer que essa informação seja adicionada como voucher, e só chamar
// esta tool depois que ele confirmar explicitamente na mensagem seguinte — nunca na mesma resposta
// em que você identificou a informação.
export const createVoucherTool = createTool({
  id: 'criarDocumento',
  description:
    'Cria um voucher (documento) novo para esta viagem, a partir de uma informação que o consultor descreveu no chat (não um upload). ' +
    'REGRA OBRIGATÓRIA: quando identificar no chat uma informação que parece ser um voucher/reserva (ex: um novo voo, hospedagem, ' +
    'traslado, passeio), NÃO chame esta tool direto — primeiro pergunte ao consultor se ele quer adicionar essa informação como um ' +
    'voucher da viagem. Só chame esta tool depois que ele confirmar explicitamente. Nunca invente title/content/dados — use só o que ' +
    'o consultor de fato informou.',
  inputSchema: z.object({
    title: z.string().describe('Título curto do voucher (ex: "Voo LATAM GRU -> FOR").'),
    content: z.string().describe('Conteúdo/resumo do voucher em texto, com as informações que o consultor forneceu.'),
    voucherTypeSlug: z
      .string()
      .optional()
      .describe('Tipo do voucher (ex: flight, accommodation, transfer, experience, restaurant_reservation, car_rental, other). Default: "other".'),
    aiExtractedData: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Dados estruturados do voucher, se o consultor tiver informado detalhes suficientes para estruturar (ex: datas, localizador, passageiros).'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ title, content, voucherTypeSlug, aiExtractedData }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('criarDocumento: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    const voucher = await insertVoucher({
      tenantId,
      travelId,
      title,
      content,
      voucherTypeSlug: voucherTypeSlug || FALLBACK_VOUCHER_TYPE_SLUG,
      aiExtractedData: aiExtractedData ?? null,
      rawContent: null,
      metadata: { issuer: 'company' },
      fileUrl: null,
    });

    triggerDailyScheduleUpdate(
      tenantId,
      travelId,
      { id: voucher.id, title: voucher.title, voucherTypeSlug: voucher.voucher_type_slug, content: voucher.content },
      userId,
    );
    return voucher;
  },
});
