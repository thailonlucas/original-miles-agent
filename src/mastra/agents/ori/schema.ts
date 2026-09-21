import { z } from 'zod';

// Mesmo envelope hoje vinculado ao node de IA do n8n (`response` + `analysed_doc_ids`) — ver
// `prompts/system-prompt.ts` sobre por que o formato de dentro de `response` varia (texto livre
// pra pergunta pontual/confirmação, JSON serializado quando o pedido é montar o roteiro completo).
export const oriResultSchema = z.object({
  response: z.string().describe('Resposta gerada para o consultor.'),
  analysed_doc_ids: z.array(z.string()).describe('Lista com os ids dos documentos (vouchers) analisados (abertos pela tool "buscarDocumento") para gerar esta resposta.'),
});

export type OriResult = z.infer<typeof oriResultSchema>;
