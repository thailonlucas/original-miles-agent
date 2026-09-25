import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createExtractedVoucher } from '../../../services/create-voucher';

// "Criar Documento" — cria um voucher novo a partir do que o consultor descreveu no chat (não veio de
// upload). O texto passa pelo MESMO pipeline de extração de um upload (`createExtractedVoucher`, a
// função da rota `POST /travel_agent/extract/vouchers`): classifica o tipo e extrai `ai_extracted_data`
// no schema daquele tipo — é isso que faz o voucher aparecer completo no front (check-in, quartos,
// passageiros...). O model só escreve o texto; nunca monta a estrutura sozinho.
//
// REGRA CENTRAL: nunca crie um voucher sem primeiro perguntar ao consultor se ele quer que essa
// informação seja adicionada como voucher, e só chamar esta tool depois que ele confirmar
// explicitamente na mensagem seguinte — nunca na mesma resposta em que você identificou a informação.
export const createVoucherTool = createTool({
  id: 'criarDocumento',
  description:
    'Cria um voucher (documento) novo para esta viagem, a partir de uma informação que o consultor descreveu no chat (não um upload). ' +
    'O texto passa pelo mesmo extrator dos uploads, que identifica o tipo e estrutura os dados sozinho. ' +
    'REGRA OBRIGATÓRIA: quando identificar no chat uma informação que parece ser um voucher/reserva (ex: um novo voo, hospedagem, ' +
    'traslado, passeio), NÃO chame esta tool direto — primeiro pergunte ao consultor se ele quer adicionar essa informação como um ' +
    'voucher da viagem. Só chame esta tool depois que ele confirmar explicitamente. Nunca invente dados — use só o que ' +
    'o consultor de fato informou.',
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .describe(
        'Tudo o que o consultor informou sobre essa reserva, em texto corrido e sem resumir: tipo (hotel, voo, traslado...), nome do ' +
          'fornecedor, cidade/endereço, datas e horários (ex: check-in/check-out), passageiros/hóspedes, localizador ou número da ' +
          'reserva, quarto, valores, política de cancelamento — o que tiver sido dito. Junte as informações de mensagens anteriores ' +
          'da conversa sobre a mesma reserva.',
      ),
  }),
  outputSchema: z.unknown(),
  execute: async ({ text }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('criarDocumento: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    const voucher = await createExtractedVoucher(tenantId, travelId, userId, { text }, 'company');
    // Sem `ai_extracted_data` no retorno: o model não precisa dele, e ele iria inteiro pra memória da thread.
    return { created: true, id: voucher.id, title: voucher.title, type: voucher.voucher_type_slug, content: voucher.content };
  },
});
