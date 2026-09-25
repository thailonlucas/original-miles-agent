import { extractVoucher, extractVoucherFromText, type VoucherExtractionResult } from '../agents/voucher-extractor/voucher-extractor';
import { triggerDailyScheduleUpdate } from '../agents/daily-schedule/daily-schedule-trigger';
import { insertVoucher, type VoucherRecord } from './travel-db';

// Quem criou o voucher: "company" (time da agência) ou "customer" (cliente sozinho, self-service).
// Salvo em `metadata.issuer` (não existe coluna própria pra isso na tabela `voucher`).
export type VoucherIssuer = 'company' | 'customer';

export type VoucherSource = { file: Uint8Array; mediaType: string; fileName: string | null } | { text: string };

// Cria UM voucher passando pelo pipeline de extração inteiro: (OCR, se for arquivo) -> classifica o
// tipo -> extrai `ai_extracted_data` com o prompt/schema daquele tipo -> grava -> atualiza os eventos
// dele no dia a dia (em background). É o que faz o voucher aparecer completo no front, que monta a
// tela a partir de `ai_extracted_data`. Função única usada pela rota `POST /travel_agent/extract/vouchers`
// (upload ou texto) e pela tool `criarDocumento` do Ori (texto que o consultor mandou no chat).
export async function createExtractedVoucher(
  tenantId: string,
  travelId: string,
  userId: string,
  source: VoucherSource,
  issuer: VoucherIssuer,
): Promise<VoucherRecord> {
  const extraction: VoucherExtractionResult =
    'file' in source
      ? await extractVoucher(source.file, source.mediaType, tenantId)
      : await extractVoucherFromText(source.text, tenantId);

  const { document_name, content } = extraction.extractedData;
  const voucher = await insertVoucher({
    tenantId,
    travelId,
    title: typeof document_name === 'string' ? document_name : ('fileName' in source && source.fileName) || null,
    content: typeof content === 'string' ? content : null,
    voucherTypeSlug: extraction.voucherTypeSlug,
    aiExtractedData: extraction.extractedData,
    rawContent: extraction.rawContent,
    metadata: { issuer },
    fileUrl: null,
  });

  triggerDailyScheduleUpdate(
    tenantId,
    travelId,
    { id: voucher.id, title: voucher.title, voucherTypeSlug: voucher.voucher_type_slug, content: voucher.content },
    userId,
  );
  return voucher;
}
