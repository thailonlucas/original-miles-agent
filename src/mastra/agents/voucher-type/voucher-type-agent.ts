import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import type { FilePart, ImagePart } from 'ai';
import { getActiveVoucherTypes } from '../../services/travel-db';
import { buildSystemPrompt } from './prompts/system-prompt';
import { voucherTypeClassificationSchema, type VoucherTypeClassification } from './schema';

export const voucherTypeAgent = new Agent({
  id: 'voucher-type',
  name: 'Voucher Type',
  description: 'Classifica o tipo de um voucher de viagem (voo, hospedagem, transfer, seguro, etc.) a partir do documento enviado.',
  // Lista de tipos vem da tabela `voucher_type` (Supabase), escopada por tenant — refletindo
  // qualquer tipo novo cadastrado via o endpoint de CRUD de voucher_type sem precisar de deploy.
  //
  // Fallback (lista vazia) só é usado quando o Mastra introspecciona a lista de agentes sem
  // requestContext (ex.: Studio/playground, endpoint /api/agents via `formatAgentList`) — nas
  // chamadas reais, `classifyVoucherType`/`classifyVoucherTypeFromText` sempre passam `tenant_id`
  // explicitamente. Lançar erro aqui virava um warning/alerta a cada listagem de agentes, mesmo
  // sem nenhuma classificação real acontecer (mesmo padrão do fallback de `model` em
  // `agents/voucher-extractor/extraction-agent.ts`).
  instructions: async ({ requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const voucherTypes = tenantId ? await getActiveVoucherTypes(tenantId) : [];
    return buildSystemPrompt(voucherTypes);
  },
  model: 'openai/gpt-4.1-mini',
  defaultOptions: {
    structuredOutput: {
      schema: voucherTypeClassificationSchema,
    },
  },
});

function buildMediaPart(mediaUrl: string, mediaType: string | undefined): ImagePart | FilePart {
  const url = new URL(mediaUrl);
  if (mediaType?.startsWith('image/')) {
    return { type: 'image', image: url, mediaType };
  }
  return { type: 'file', data: url, mediaType: mediaType ?? 'application/pdf' };
}

export async function classifyVoucherType(mediaUrl: string, mediaType: string | undefined, tenantId: string): Promise<VoucherTypeClassification> {
  const { object } = await voucherTypeAgent.generate(
    [
      {
        role: 'user',
        content: [buildMediaPart(mediaUrl, mediaType), { type: 'text', text: 'Classifique o tipo deste voucher de viagem.' }],
      },
    ],
    { requestContext: new RequestContext([['tenant_id', tenantId]]) },
  );

  return object;
}

// Variante usada pelo pipeline de extração (`agents/voucher-extractor/`): classifica a partir do
// texto já extraído do documento (`raw_content`), em vez de mandar a imagem/PDF de novo pro
// model — mesmo texto que alimenta a extração estruturada em seguida.
export async function classifyVoucherTypeFromText(rawContent: string, tenantId: string): Promise<VoucherTypeClassification> {
  const { object } = await voucherTypeAgent.generate(`Classifique o tipo deste voucher de viagem a partir do texto extraído abaixo:\n\n${rawContent}`, {
    requestContext: new RequestContext([['tenant_id', tenantId]]),
  });

  return object;
}
