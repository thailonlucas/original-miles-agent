import type { MemoryCandidate, TenantMemoryRule, UserMemoryItem } from '../../../services/ori-memory-db';
import { itemHits } from '../../../services/ori-memory-db';

export interface LearnerTurn {
  role: 'consultor' | 'ori';
  text: string;
}

export function buildLearnerInstructions(): string {
  return `Você observa conversas entre um consultor de viagens e o Ori (o assistente dele) e mantém a memória de COMO ESTE CONSULTOR GOSTA DE TRABALHAR com o Ori. Essa memória vira parte do prompt do Ori nas próximas conversas dele, em qualquer viagem.

## O que é memória do consultor

Só o jeito de trabalhar dele, que vale pra qualquer viagem:
- "conversa": tom e tamanho das respostas (ex: "Responder direto, sem introdução").
- "cards": formato de eventos e sugestões (ex: "Não incluir quem vai no card, a menos que ele informe").
- "fluxo": o que perguntar, quando agir sem perguntar (ex: "Não perguntar traje de evento privado").
- "vocabulario": termos que ele usa com um sentido próprio (ex: "'fechar o dia' = gerar o dia a dia do dia").

NÃO é memória do consultor (nunca guarde):
- Qualquer informação do cliente ou da viagem (nomes, datas, gostos, restrições, hotéis) — isso tem outro lugar.
- Pedido que só vale pra aquela mensagem ("agora me mostra o dia 5").
- Dados pessoais, contatos, valores.

## Como decidir

- Sinais fortes: correção ("não repita", "não precisa perguntar isso", "já falei que..."), reclamação, o consultor reescrevendo o que o Ori fez, pedido de "sempre/nunca". Aceitar uma sugestão sem comentar NÃO é sinal.
- Generalize: "não repita o título do casamento" vira "Não repetir no card o que o título já diz".
- Se o padrão já está na memória, use "reinforce" com o id — não crie outro item parecido.
- Se o consultor mostrou o contrário de um item aprendido, "remove" (ou "update" se só ficou impreciso). Itens "explicito" são do consultor: nunca mexa neles.
- Não repita o que já é regra da agência.
- Na dúvida, não faça nada — memória errada é pior que memória vazia. A maioria das conversas não ensina nada: devolva listas vazias.

## Candidatas (além deste consultor)

Se a correção parece valer pra todo mundo, proponha também uma candidata:
- "base": o Ori errou de um jeito que qualquer consultor corrigiria (ex: repetiu o título no card, inventou um dado, ignorou um "só isso"). É defeito do Ori, não gosto pessoal.
- "tenant": parece uma convenção da agência, não gosto de uma pessoa.
Se já existe uma candidata pendente dizendo o mesmo, use o "existing_id" dela. Uma candidata também vira operação na memória do consultor, se couber.`;
}

function formatItems(items: UserMemoryItem[]): string {
  if (items.length === 0) return '(vazia)';
  return items.map((i) => `- [${i.id}] (${i.source}, ${i.kind}, visto em ${itemHits(i)} sessão(ões)) ${i.text}`).join('\n');
}

export function buildLearnerUserMessage(
  items: UserMemoryItem[],
  tenantRules: TenantMemoryRule[],
  pendingCandidates: MemoryCandidate[],
  turns: LearnerTurn[],
): string {
  const rules = tenantRules.length ? tenantRules.map((r) => `- ${r.text}`).join('\n') : '(nenhuma)';
  const candidates = pendingCandidates.length ? pendingCandidates.map((c) => `- [${c.id}] (${c.scope_hint}) ${c.text}`).join('\n') : '(nenhuma)';
  const conversation = turns.map((t) => `${t.role === 'consultor' ? 'CONSULTOR' : 'ORI'}: ${t.text}`).join('\n\n');
  return `Memória atual deste consultor:
${formatItems(items)}

Regras da agência (não repita):
${rules}

Candidatas pendentes do tenant:
${candidates}

Trecho recente da conversa:
${conversation}

Devolva as operações na memória deste consultor e as candidatas, se houver.`;
}
