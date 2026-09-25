// Formato único de um evento do dia a dia — usado por todo caminho que escreve um: o gerador
// (`schema.ts`), as sugestões (`agents/schedule-suggestion/schema.ts`) e as tools do Ori que
// incluem/alteram eventos. Assim um evento gerado, uma sugestão aprovada e um evento criado no chat
// ficam com a mesma cara no kanban. Cada lugar só acrescenta DE ONDE os dados podem vir.
//
// Os exemplos vêm dos eventos que o gerador já grava hoje (padrão "**Rótulo:** valor", uma
// informação por linha) — é isso que o kanban mostra, então é isso que todo evento novo copia.

export const EVENT_TITLE_FORMAT =
  'Título curto, sem data nem período, no mesmo padrão dos eventos do dia a dia: "Voo TP 0824 Lisboa → Milão Malpensa", ' +
  '"Check-in no Urban Hive Milano", "Hospedagem no Urban Hive Milano", "Check-out do Urban Hive Milano", ' +
  '"Retirada do carro Movida em BPS", "Jantar no Maní", "Casamento de Ana e Pedro".';

export const EVENT_CONTENT_FORMAT =
  'Markdown no mesmo padrão dos eventos do dia a dia: uma informação por linha, no formato "**Rótulo:** valor", só com o que ' +
  'existir. Primeiro o horário (ex: "**Check-in:**", "**Partida:**", "**Horário:**"), depois o local/endereço, reserva ou ' +
  'localizador, pessoas (passageiros/hóspedes), contatos e observações. Exemplo:\n' +
  '**Horário:** 19h\n' +
  '**Local:** Villa Necchi Campiglio\n' +
  '**Endereço:** Via Mozart 14, Milão, Itália\n' +
  '**Traje:** black tie\n' +
  'Nunca invente uma informação que não foi dada.';

export const EVENT_TYPE_FORMAT =
  'Categoria do evento: flight, accommodation, transfer, restaurant_reservation, car_rental, ferry_boat, experience ou other.';

const LIST_ITEM = /^\s*([-*+]|\d+\.)\s/;

// O kanban renderiza o `content` com ReactMarkdown, que junta numa linha só duas linhas separadas
// por uma quebra simples — "**Horário:** 19h\n**Local:** X" aparecia corrido. Markdown só mantém a
// quebra se a linha terminar com dois espaços. Em vez de depender do model lembrar disso, todo
// evento gravado passa por aqui. Linhas em branco e itens de lista já quebram sozinhos.
export function normalizeEventContent(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  return lines
    .map((line, i) => {
      const next = lines[i + 1];
      if (!line.trim() || next === undefined || !next.trim() || LIST_ITEM.test(next)) return line.trimEnd();
      return `${line.trimEnd()}  `;
    })
    .join('\n')
    .trim();
}
