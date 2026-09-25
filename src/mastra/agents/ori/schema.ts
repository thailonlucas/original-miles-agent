import { z } from 'zod';

// Mesmo envelope hoje vinculado ao node de IA do n8n (`response` + `analysed_doc_ids`) — ver
// `prompts/system-prompt.ts` sobre por que o formato de dentro de `response` varia (texto livre
// pra pergunta pontual/confirmação, JSON serializado quando o pedido é montar o dia a dia
// completo). Edições pontuais (ex: `atualizarEventoDiaADia`) NÃO reserializam o dia a dia inteiro
// aqui de propósito — isso obrigaria o model a "reescrever" todo o array na resposta, gastando
// tokens de saída à toa (ver `updated_data` abaixo pro sinal que o front usa em vez disso).
export const oriResultSchema = z.object({
  response: z.string().describe('Resposta gerada para o consultor.'),
  analysed_doc_ids: z.array(z.string()).describe('Lista com os ids dos documentos (vouchers) analisados (abertos pela tool "buscarDocumento") para gerar esta resposta.'),
});

export type OriResult = z.infer<typeof oriResultSchema>;

// `updated_data`: NÃO faz parte de `oriResultSchema` de propósito — não é preenchido pela LLM
// (custaria tokens de saída e dependeria dela "lembrar" corretamente), é calculado em código por
// `askOri` (`ori-agent.ts`) a partir de quais tools de escrita foram chamadas nesta resposta (ver
// `WRITE_TOOL_IDS` lá). `true` só diz "alguma coisa mudou, o front pode estar desatualizado" — não
// diz o quê; é um sinal pra disparar um refresh (ex: rebuscar voucher/dia a dia/sugestões), não um
// diff do que mudou.
//
// `pending_approval`: presente só quando a geração pausou numa tool marcada `requireApproval: true`
// (ver `decidirSugestao`/`adicionarSugestaoAoDiaADia`, `tools/`) — o Mastra intercepta a chamada
// ANTES do `execute()` rodar. Quando presente, `response` já vem com uma pergunta de confirmação
// pro consultor (montada em código, não pela LLM — ver `describePendingApproval` em
// `ori-agent.ts`), `analysed_doc_ids` vem vazio e `updated_data` vem `false` (nada foi escrito
// ainda). O front resolve a pausa chamando `POST /travel_agent/ori/approval` com `run_id`/
// `tool_call_id` e a decisão — ver `routes/ori-routes.ts`.
export interface PendingApproval {
  run_id: string;
  tool_call_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  // Pergunta de confirmação montada em código (o QUÊ vai ser feito). Separada de `response`, que
  // traz o que o próprio agente escreveu antes de chamar a tool (quando escreveu algo).
  question: string;
}

export interface OriResponse extends OriResult {
  updated_data: boolean;
  pending_approval?: PendingApproval;
}
