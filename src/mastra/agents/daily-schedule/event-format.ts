// Formato único de um evento do dia a dia — usado por todo caminho que escreve um: o gerador
// (`schema.ts`), as sugestões (`agents/schedule-suggestion/schema.ts`) e as tools do Ori que
// incluem/alteram eventos. Assim um evento gerado, uma sugestão aprovada e um evento criado no chat
// ficam com a mesma cara no kanban. Cada lugar só acrescenta DE ONDE os dados podem vir.
//
// Os exemplos vêm dos eventos que o gerador já grava hoje (padrão "**Rótulo:** valor", uma
// informação por linha) — é isso que o kanban mostra, então é isso que todo evento novo copia.

export const EVENT_TITLE_FORMAT =
  'Título curto, sem data nem período, no mesmo padrão dos eventos do dia a dia: "Voo TP 0824 Lisboa → Milão Malpensa", ' +
  '"Check-in no Urban Hive Milano", "Check-out do Urban Hive Milano", ' +
  '"Retirada do carro Movida em BPS", "Devolução do carro Movida em BPS", "Jantar no Maní", "Casamento de Ana e Pedro".';

export const EVENT_CONTENT_FORMAT =
  'Markdown no mesmo padrão dos eventos do dia a dia: uma informação por linha, no formato "**Rótulo:** valor". Detalhado: ' +
  'traga TODOS os itens da lista "Detalhes por tipo de evento" que você tiver, na ordem da lista (horário primeiro). Exemplo:\n' +
  '**Horário:** 19h\n' +
  '**Local:** Villa Necchi Campiglio\n' +
  '**Endereço:** Via Mozart 14, Milão, Itália\n' +
  '**Traje:** black tie\n' +
  'Nunca invente uma informação que não foi dada.';

// Só pro gerador a partir de vouchers (`prompts/system-prompt.ts`, `schema.ts`). O card de um evento
// de voucher é um resumo do que acontece — o voucher continua anexo com endereço, telefone,
// localizador, passageiros etc., então repetir isso no card só deixava o texto longo e igual ao PDF.
// Dois formatos: evento logístico (voo, hotel, transfer...) é dado de consulta rápida, em rótulos;
// experiência (passeio, restaurante, evento) é contada num parágrafo curto — em rótulos virava
// "Experiência: X / Local: X" repetindo o título.
// Sugestões e eventos do chat não têm voucher por trás e seguem com o formato completo acima.
export const VOUCHER_EVENT_CONTENT_FORMAT =
  'Markdown curto, resumo do que vai acontecer — nunca uma cópia do voucher. Siga o formato do tipo (lista "O essencial por tipo de evento"). ' +
  'Nunca repita no "content" o que já está no "title" ou no "place" (nome da experiência, do restaurante, do hotel, do lugar) — ' +
  'nem numa linha própria ("Experiência: ...", "Local: ...") nem dentro das frases. ' +
  'A primeira linha é SEMPRE o horário. Tudo no "content" sai do voucher aberto — nada de conhecimento geral sobre o lugar, ' +
  'nada deduzido, nada do "Resumo geral da viagem".';

// O essencial de um evento de voucher, por tipo — o que o cliente precisa saber pra viver aquele
// momento. Tudo que não está aqui fica no voucher.
export const VOUCHER_EVENT_ESSENTIALS_GUIDE = [
  '### Eventos logísticos — flight, accommodation, transfer, car_rental, ferry_boat',
  '',
  'De 1 a 3 linhas "**Rótulo:** valor", com valores enxutos (sem frases). A primeira linha é a do horário. Só estes itens:',
  '- flight: Embarque (horário + aeroporto de partida), Chegada (horário + aeroporto de chegada, e "dia seguinte" se mudar o dia), Conexão (só se houver: aeroporto e horário).',
  '- accommodation: Check-in / Check-out (horário), Regime (só no check-in, ex: "café da manhã incluso").',
  '- transfer: Busca (horário + ponto de encontro), Destino (só se não estiver no título).',
  '- car_rental: Retirada / Devolução (horário), Carro (só na retirada: categoria ou modelo).',
  '- ferry_boat: Embarque (horário + porto), Chegada (horário + porto).',
  '',
  'Exemplo (voo "Voo TP 0082 São Paulo → Lisboa"):',
  '**Embarque:** 22h40 em Guarulhos (GRU)',
  '**Chegada:** 11h05 em Lisboa (LIS), dia seguinte',
  '',
  '### Experiências — experience, restaurant_reservation, other',
  '',
  'Nesta ordem (o horário sempre; as outras partes só se o voucher tiver o dado):',
  '1. "**Horário:** 12h30" — sempre (ou "**Horário:** 9h, encontro no lobby do hotel").',
  '2. Um parágrafo de 1 a 3 frases, sem rótulo, contando o que acontece e o que torna o momento especial. Comece pelo que acontece, não pelo nome (o nome já está no título).',
  '3. Linhas "**Dica:**", "**Logística:**" ou "**Atenção:**" — só para o que muda o que o cliente faz (traje, levar algo, alternativa em caso de chuva, quem vai). Uma frase cada, sem repetir o parágrafo.',
  '',
  'Exemplo (title "Almoço musical Metzelive no Metzelet", place "Metzelet, Cervinia"):',
  '**Horário:** 12h30',
  '',
  'Almoço especial com apresentação ao vivo de artistas locais. Com tempo bom, a música acontece na varanda com vista para o Cervino e as Grandes Murailles; com mau tempo, no salão do restaurante.',
  '',
  '**Logística:** Julia e Carlos podem interromper o esqui no dia para almoçar com Maria.',
  '',
  'Errado (repete o título e o lugar em rótulos): "**Experiência:** Metzelive — almoço musical semanal" / "**Local:** Metzelet".',
  '',
  '### Horário',
  '',
  'Todo evento tem horário na primeira linha, exatamente como está no voucher (horário local). Procure no voucher inteiro antes de desistir. ' +
    'Se o voucher não trouxer horário nenhum, escreva o rótulo do tipo com "a confirmar" (ex: "**Horário:** a confirmar", "**Check-in:** a confirmar") — nunca estime um.',
  '',
  '### Só o que está no voucher',
  '',
  'Cada frase do "content" precisa estar apoiada no voucher aberto. Nunca assuma nem estime: duração ("cerca de 2h"), horário, ' +
    'distância/tempo de deslocamento, o que o lugar tem ou oferece, clima, traje, preço. Se o voucher não diz, não entra. ' +
    'O "Resumo geral da viagem" é só contexto — nada dele vai pro "content".',
  '',
  '### Nunca no "content"',
  '',
  'Endereço, telefone/contato, localizador/código de reserva, número de quarto, políticas de cancelamento, valores pagos, ' +
    'franquia de bagagem ou qualquer texto institucional — isso já está no voucher. Sem um dado, omita a linha (nunca escreva "não informado") — a única exceção é o horário, que vira "a confirmar".',
].join('\n');

export const EVENT_TYPE_FORMAT =
  'Categoria do evento: flight, accommodation, transfer, restaurant_reservation, car_rental, ferry_boat, experience ou other.';

// O que um evento completo de cada tipo traz, na ordem em que aparece no `content`. É o que separa um
// card "seco" de um card útil pro consultor: o gerador preenche com o voucher, as sugestões com o que
// se sabe do lugar, e o Ori pergunta ao consultor o que só ele sabe (`detalharEvento`).
//
// `from` diz quem pode preencher o item:
// - "reserva": só um voucher ou o consultor sabe (horário marcado, localizador, quem vai) — sem isso,
//   pergunta; nunca deduz.
// - "lugar": informação pública do lugar (endereço, o que é, duração, como chegar) — pode vir do
//   conhecimento geral sobre um lugar real, como aproximação.
export type EventDetailSource = 'reserva' | 'lugar';

export interface EventDetail {
  label: string;
  from: EventDetailSource;
  // Outros rótulos que contam como este item já preenchido (ex: "Partida" conta como horário).
  aliases: string[];
}

const detail = (label: string, from: EventDetailSource, ...aliases: string[]): EventDetail => ({ label, from, aliases: [label, ...aliases] });

export const EVENT_DETAILS: Record<string, EventDetail[]> = {
  flight: [
    detail('Partida', 'reserva'),
    detail('Chegada', 'reserva'),
    detail('Origem', 'reserva'),
    detail('Destino', 'reserva'),
    detail('Voo', 'reserva', 'Companhia'),
    detail('Localizador', 'reserva', 'Reserva'),
    detail('Passageiros', 'reserva', 'Passageiro'),
    detail('Bagagem', 'reserva'),
  ],
  accommodation: [
    detail('Check-in', 'reserva', 'Check-out'),
    detail('Local', 'reserva', 'Hotel'),
    detail('Endereço', 'lugar'),
    detail('Quarto', 'reserva'),
    detail('Regime', 'reserva', 'Café da manhã'),
    detail('Localizador', 'reserva', 'Reserva'),
    detail('Hóspedes', 'reserva', 'Hóspede'),
    detail('Contato', 'lugar', 'Telefone'),
  ],
  transfer: [
    detail('Horário', 'reserva', 'Busca', 'Partida'),
    detail('Origem', 'reserva'),
    detail('Destino', 'reserva'),
    detail('Empresa', 'reserva', 'Motorista'),
    detail('Contato', 'reserva', 'Telefone'),
    detail('Localizador', 'reserva', 'Reserva'),
    detail('Passageiros', 'reserva', 'Passageiro'),
    detail('Duração', 'lugar', 'Duração estimada'),
  ],
  restaurant_reservation: [
    detail('Horário', 'reserva'),
    detail('Restaurante', 'lugar', 'Local', 'Cozinha'),
    detail('Endereço', 'lugar'),
    detail('Reserva', 'reserva', 'Localizador'),
    detail('Pessoas', 'reserva', 'Mesa'),
    detail('Traje', 'lugar', 'Dress code'),
    detail('Preço médio', 'lugar', 'Preço'),
    detail('Logística', 'lugar', 'Como chegar'),
  ],
  car_rental: [
    detail('Retirada', 'reserva'),
    detail('Devolução', 'reserva'),
    detail('Local', 'reserva', 'Loja'),
    detail('Locadora', 'reserva'),
    detail('Categoria', 'reserva', 'Carro'),
    detail('Localizador', 'reserva', 'Reserva'),
    detail('Condutor', 'reserva', 'Motorista'),
  ],
  ferry_boat: [
    detail('Partida', 'reserva'),
    detail('Chegada', 'reserva'),
    detail('Origem', 'reserva'),
    detail('Destino', 'reserva'),
    detail('Companhia', 'reserva'),
    detail('Localizador', 'reserva', 'Reserva'),
    detail('Passageiros', 'reserva', 'Passageiro'),
  ],
  experience: [
    detail('Horário', 'reserva'),
    detail('Experiência', 'lugar', 'O que é', 'Passeio', 'Atividade'),
    detail('Local', 'lugar'),
    detail('Endereço', 'lugar'),
    detail('Duração', 'lugar', 'Duração estimada'),
    detail('Ingressos', 'reserva', 'Reserva', 'Localizador'),
    detail('Pessoas', 'reserva', 'Participantes'),
    detail('Dica', 'lugar', 'Observação', 'Traje'),
    detail('Logística', 'lugar', 'Como chegar'),
  ],
  other: [
    detail('Horário', 'reserva'),
    detail('Ocasião', 'reserva', 'Evento'),
    detail('Local', 'reserva'),
    detail('Endereço', 'lugar'),
    detail('Pessoas', 'reserva', 'Convidados'),
    detail('Traje', 'reserva', 'Dress code'),
    detail('Contato', 'reserva', 'Telefone'),
    detail('Logística', 'lugar', 'Como chegar'),
  ],
};

export function eventDetailsFor(type: string): EventDetail[] {
  return EVENT_DETAILS[type] ?? EVENT_DETAILS.other;
}

// A lista acima em texto, pros prompts (gerador, sugestões e Ori).
export const EVENT_DETAILS_GUIDE = Object.entries(EVENT_DETAILS)
  .map(([type, details]) => `- ${type}: ${details.map((d) => (d.from === 'lugar' ? `${d.label} (do lugar)` : d.label)).join(', ')}`)
  .join('\n');

const normalizeLabel = (label: string) => label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

// Compara o `content` de um evento com a lista do tipo dele: quais itens já estão lá (pelos rótulos
// "**Rótulo:**") e quais faltam.
export function eventDetailGaps(event: { type: string; content: string }): { filled: string[]; missing: EventDetail[] } {
  const labels = new Set([...event.content.matchAll(/\*\*([^*]+?):\*\*/g)].map((m) => normalizeLabel(m[1])));
  const details = eventDetailsFor(event.type);
  const has = (d: EventDetail) => d.aliases.some((alias) => labels.has(normalizeLabel(alias)));
  return { filled: details.filter(has).map((d) => d.label), missing: details.filter((d) => !has(d)) };
}

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
