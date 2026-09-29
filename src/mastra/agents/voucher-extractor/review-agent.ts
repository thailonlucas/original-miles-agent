import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import type { VoucherTypeFull } from '../../services/travel-db';

// `voucher_type.ai_provider` guarda "open_ai" (valor legado do fluxo antigo em n8n) — o model
// router do Mastra usa o prefixo "openai". Outros providers (se algum dia existirem) passam direto.
function toModelRouterProvider(aiProvider: string | null): string {
  if (!aiProvider || aiProvider === 'open_ai') return 'openai';
  return aiProvider;
}

function buildReviewInstructions(): string {
  return `Você revisa a extração estruturada de um voucher de viagem, comparando o JSON extraído com o texto bruto (raw content) que deu origem a ele.

Você vai receber:
1. O texto bruto do documento (raw content).
2. O JSON já extraído no primeiro passo, seguindo o schema estruturado esperado.

Sua tarefa:
- Releia o texto bruto do zero, campo a campo do schema, e garanta que TODA informação relevante do texto bruto que tenha um campo correspondente no schema esteja presente no JSON final — nenhum dado do texto bruto que caiba no schema pode ficar de fora.
- Preencha campos do schema que estão faltando, vazios ou nulos no JSON, mas cuja informação existe no texto bruto.
- Corrija campos que estão errados (valor diferente do que está escrito no texto bruto), incompletos, truncados ou mal formatados.
- Corrija informação que foi extraída para o campo ERRADO do schema — por exemplo, um dado que caiu num campo genérico (tipo "informações adicionais"/"observações") quando existe um campo mais específico pra ele no schema, ou um valor que foi colocado no campo de outro dado parecido. Mova o valor pro campo correto e remova a duplicata do campo errado.
- Preste atenção especial (sem se limitar a) a estas categorias, que costumam ser esquecidas ou mal posicionadas na primeira extração:
  - Datas e horários de check-in/check-out (hospedagem), embarque/desembarque (passagens/experiências), retirada/devolução (aluguel de carro) ou início/fim (circuito/passeio de vários dias). Para qualquer par desses, a data de início NUNCA pode ser posterior à data de fim — se o JSON extraído tiver isso invertido (ex.: "check-out" antes de "check-in"), é quase certeza que as duas datas foram trocadas de campo na primeira extração: volte ao texto bruto, confirme qual data está de fato associada a qual rótulo (check-in/check-out, ida/volta, embarque/desembarque etc. conforme escrito no documento) e corrija a troca — não apenas inverta os valores cegamente sem checar o texto bruto.
  - Ordem de arrays com múltiplos trechos/eventos datados (ex.: "segments" de passagem aérea com ida e volta, trechos de um circuito, diárias de aluguel de carro): sistemas que consomem este JSON (o app do cliente, por exemplo) assumem que o array está em ordem cronológica — primeiro item = evento mais antigo (ida/embarque inicial), último item = mais recente (volta/desembarque final). Confira a data/hora de cada item do array contra o texto bruto e, se os itens estiverem fora de ordem cronológica (ex.: o trecho de volta aparece antes do trecho de ida no array), reordene o array e corrija qualquer campo de índice/ordem ("segment_index" ou equivalente) pra refletir a nova ordem. Isso vale mesmo que cada item individualmente esteja com os dados corretos — o erro aqui é a ORDEM do array, não o conteúdo de cada item.
  - Contatos: telefones, e-mails, endereços, nomes de empresas/fornecedores/agências.
  - Valores monetários: preço total, taxas, valores por pessoa, moeda, forma de pagamento.
  - Informações adicionais, observações, políticas (cancelamento, bagagem, documentos exigidos) e condições especiais.
  - Localizadores, códigos de reserva, números de voucher/bilhete, números de confirmação.
  - Nomes completos de passageiros/hóspedes e quantidade de pessoas.
- Mantenha inalterado tudo que já está correto e já no campo certo — não reescreva nem reformate sem necessidade.
- Não invente informação que não esteja no texto bruto. Se o dado não existir no texto, deixe o campo como está (vazio/nulo/omitido, conforme o schema permitir).
- Não remova campos válidos que já estavam presentes no JSON extraído, a menos que estejam duplicados num campo errado (aí remova a duplicata errada, mantendo o valor só no campo correto).

Retorne o JSON revisado seguindo exatamente o schema estruturado fornecido, com o máximo de completude e posicionamento correto possível em relação ao texto bruto.`;
}

// Passo de revisão pós-extração ("processor" pós-extração pedido no pipeline): não é um
// `Processor` do Mastra porque o `structuredOutput` final (o objeto já parseado) não fica
// acessível dentro de `processOutputResult`/`processOutputStep` — só `text`/`usage`/`steps` (ver
// `step-schema.d.ts` do `@mastra/core`). Em vez disso, é um segundo `Agent`, chamado logo após
// `extractStructuredVoucherData`, que recebe o `raw_content` + o JSON já extraído e devolve a
// versão enriquecida/corrigida usando o mesmo schema — o extractor só retorna depois desse passo.
export const voucherReviewAgent = new Agent({
  id: 'voucher-review',
  name: 'Voucher Review',
  description: 'Revisa os dados estruturados extraídos de um voucher, comparando com o texto bruto e enriquecendo/corrigindo campos faltantes ou errados.',
  instructions: buildReviewInstructions(),
  model: ({ requestContext }) => requestContext.get<string, string>('review_model') ?? 'openai/gpt-4.1-mini',
});

export async function reviewExtractedVoucherData(
  rawContent: string,
  extractedData: Record<string, unknown>,
  voucherType: VoucherTypeFull,
): Promise<Record<string, unknown>> {
  if (!voucherType.schema) {
    throw new Error(`voucher_type "${voucherType.slug}" não tem "structured_output" cadastrado no Supabase — não é possível revisar.`);
  }

  const modelString = `${toModelRouterProvider(voucherType.aiProvider)}/${voucherType.aiModel ?? 'gpt-4.1-mini'}`;

  const { object } = await voucherReviewAgent.generate(
    `Texto bruto do documento:\n${rawContent}\n\nJSON extraído no primeiro passo:\n${JSON.stringify(extractedData)}`,
    {
      requestContext: new RequestContext([['review_model', modelString]]),
      structuredOutput: {
        schema: voucherType.schema,
      },
    },
  );

  return object as Record<string, unknown>;
}
