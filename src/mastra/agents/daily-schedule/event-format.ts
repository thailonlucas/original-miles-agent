// Formato único de um evento do dia a dia — usado por todo caminho que escreve um: o gerador
// (`schema.ts`, `prompts/system-prompt.ts`), as sugestões (`agents/schedule-suggestion/`) e as tools
// do Ori que incluem/alteram eventos. Assim um evento gerado, uma sugestão aprovada e um evento
// criado no chat ficam com a mesma cara no kanban — e seguem as mesmas regras de escrita. Mude o
// formato padrão só aqui. Cada caminho só acrescenta DE ONDE os dados podem vir (`EVENT_SOURCE_*`).
//
// É o PADRÃO: o formato que o consultor pedir (memória dele, kind "cards", `formatCardPreferences`)
// vale acima disto em todo caminho que escreve card — o pedido do consultor é lei. Dois formatos
// padrão: evento logístico (voo, hotel, transfer...) é
// dado de consulta rápida, em rótulos; experiência (passeio, restaurante, evento) é contada num
// parágrafo curto — em rótulos virava "Ocasião: Casamento / Local: Lago Maggiore", repetindo o título.

export const EVENT_TITLE_FORMAT =
  'Título curto, sem data nem período, no mesmo padrão dos eventos do dia a dia: "Voo TP 0824 Lisboa → Milão Malpensa", ' +
  '"Check-in no Urban Hive Milano", "Check-out do Urban Hive Milano", ' +
  '"Retirada do carro Movida em BPS", "Devolução do carro Movida em BPS", "Jantar no Maní", "Casamento de Ana e Pedro".';

// Título do DIA (subtítulo da coluna no kanban), não do evento. Escrito pela LLM no gerador do zero e
// no modo "encaixar"; sem LLM (evento à mão/chat/sugestão num dia novo), `fallbackDayTitle` monta um
// no mesmo formato a partir dos cards.
export const DAY_TITLE_FORMAT =
  'Título do dia: sempre "Cidade | breve descrição do dia" — a cidade onde o cliente está naquele dia e, depois da barra, o que ' +
  'marca o dia em poucas palavras (ex: "Paris | Visita aos pontos turísticos", "Milão | Chegada e check-in"). Mais de uma cidade ' +
  'no mesmo dia (viagem, voo, passeio em outra cidade): as cidades na ordem do dia, separadas por " - " (ex: "Paris - Orlando | ' +
  'Dia no parque de diversões"). A cidade sai do "place" dos eventos, dos aeroportos/cidades dos voos ou da hospedagem em andamento.';

export const EVENT_CONTENT_FORMAT =
  'Markdown curto, resumo do que vai acontecer. Siga o formato que o consultor pediu, se houver (seção "Como o consultor quer os cards"); senão, o formato padrão do tipo (seção "Como escrever o conteúdo de um evento"). ' +
  'No formato padrão, a primeira linha é sempre o horário (no do consultor, a ordem é a dele). Nunca repita no conteúdo o que o título (ou o "place") já diz — nome da ocasião, da experiência, ' +
  'do restaurante, do hotel, do lugar —, nem numa linha própria ("**Ocasião:** ...", "**Local:** ...") nem dentro das frases. ' +
  'Só entra o que veio da fonte permitida; nunca assuma nem estime nada (duração, horário, deslocamento, traje, quem vai).';

// O guia completo, nos prompts do gerador, das sugestões e do Ori. Termina pedindo a fonte — cada
// caminho completa com a sua (`EVENT_SOURCE_*`).
export const EVENT_FORMAT_GUIDE = [
  '### Eventos logísticos — flight, accommodation, transfer, car_rental, ferry_boat',
  '',
  'De 1 a 3 itens de lista "- **Rótulo:** valor" (sempre com o "- " na frente, um item por linha), com valores enxutos (sem frases). O primeiro item é o do horário. Por padrão, estes itens:',
  '- flight: Embarque (horário + aeroporto de partida), Chegada (horário + aeroporto de chegada, e "dia seguinte" se mudar o dia), Conexão (só se houver: aeroporto e horário).',
  '- accommodation: Check-in / Check-out (horário), Regime (só no check-in, ex: "café da manhã incluso").',
  '- transfer: Busca (horário + ponto de encontro), Destino (só se não estiver no título).',
  '- car_rental: Retirada / Devolução (horário), Carro (só na retirada: categoria ou modelo).',
  '- ferry_boat: Embarque (horário + porto), Chegada (horário + porto).',
  '',
  'Exemplo (title "Voo TP 0082 São Paulo → Lisboa"):',
  '- **Embarque:** 22h40 em Guarulhos (GRU)',
  '- **Chegada:** 11h05 em Lisboa (LIS), dia seguinte',
  '',
  '### Experiências — experience, restaurant_reservation, other',
  '',
  'Nesta ordem (o horário sempre; as outras partes só se a fonte tiver o dado):',
  '1. "**Horário:** 12h30" — sempre (ou "**Horário:** 9h, encontro no lobby do hotel").',
  '2. Um parágrafo de 1 a 3 frases, sem rótulo, contando o que acontece e o que torna o momento especial. Comece pelo que acontece, não pelo nome (o nome já está no título).',
  '3. Linhas "**Dica:**", "**Logística:**" ou "**Atenção:**" — só para o que muda o que o cliente faz (traje, levar algo, alternativa em caso de chuva, quem vai). Uma frase cada, sem repetir o parágrafo.',
  '',
  'Se a fonte só tem o horário, o conteúdo é só a linha do horário — não encha com o que o título já diz.',
  '',
  'Exemplo (title "Almoço musical Metzelive no Metzelet", place "Metzelet, Cervinia"):',
  '**Horário:** 12h30',
  '',
  'Almoço especial com apresentação ao vivo de artistas locais. Com tempo bom, a música acontece na varanda com vista para o Cervino e as Grandes Murailles; com mau tempo, no salão do restaurante.',
  '',
  '**Logística:** Julia e Carlos podem interromper o esqui no dia para almoçar com Maria.',
  '',
  'Errado (repete o título e o lugar em rótulos): "**Experiência:** Metzelive — almoço musical semanal" / "**Local:** Metzelet".',
  'Errado (title "Casamento no Lago Maggiore", consultor só informou 18h): "**Horário:** 18h / **Ocasião:** Casamento / **Local:** Lago Maggiore / **Pessoas:** Theo". ' +
    'O título já diz a ocasião e o local, e ninguém informou quem vai. Certo: só "**Horário:** 18h".',
  '',
  '### Horário',
  '',
  'No formato padrão, todo evento tem horário na primeira linha, exatamente como está na fonte (horário local). ' +
    'Sem horário nenhum na fonte, escreva o rótulo do tipo com "a confirmar" (ex: "**Horário:** a confirmar", "**Check-in:** a confirmar") — nunca estime um.',
  '',
  '### Linha sem dado',
  '',
  'Por padrão, omita a linha (nunca "não informado"), menos o horário, que vira "a confirmar". Se o formato do consultor pedir o campo mesmo sem dado, deixe o rótulo em branco pra ele preencher.',
].join('\n');

export const EVENT_TYPE_FORMAT =
  'Categoria do evento: flight, accommodation, transfer, restaurant_reservation, car_rental, ferry_boat, experience ou other.';

// De onde cada caminho pode tirar o conteúdo — vai junto do formato em cada prompt/schema.
export const EVENT_SOURCE_VOUCHER =
  'Fonte permitida: só o voucher aberto. Nada de conhecimento geral sobre o lugar, nada deduzido, nada do "Resumo geral da viagem".';

export const EVENT_SOURCE_CHAT =
  'Fonte permitida: só o que o consultor disse nesta conversa e os vouchers da viagem. Nada de conhecimento geral sobre o lugar, ' +
  'nada deduzido, nada do Contexto da Viagem. Se o consultor disser "só isso", o conteúdo é só isso.';

export const EVENT_SOURCE_SUGGESTION =
  'Fonte permitida (sugestão): o parágrafo pode descrever o que é o lugar/atividade com o que se sabe de um lugar real e conhecido. ' +
  'O horário é uma sugestão e vem marcado assim ("**Horário:** 20h (sugerido)"). Nunca invente duração, reserva, preço ou quem vai.';

// O mínimo que um evento precisa ter, por tipo — só rótulos, pra `eventDetailGaps` (tool
// `detalharEvento` do Ori) apontar o que falta. É a primeira linha de cada formato do guia acima: o
// horário. O resto do card (parágrafo, dicas) não é "falta" — só entra se a fonte tiver.
export interface EventDetail {
  label: string;
  // Outros rótulos que contam como este item já preenchido (ex: "Partida" conta como embarque).
  aliases: string[];
}

const detail = (label: string, ...aliases: string[]): EventDetail => ({ label, aliases: [label, ...aliases] });

export const EVENT_DETAILS: Record<string, EventDetail[]> = {
  flight: [detail('Embarque', 'Partida'), detail('Chegada')],
  accommodation: [detail('Check-in', 'Check-out')],
  transfer: [detail('Busca', 'Horário', 'Partida')],
  car_rental: [detail('Retirada', 'Devolução')],
  ferry_boat: [detail('Embarque', 'Partida'), detail('Chegada')],
  experience: [detail('Horário')],
  restaurant_reservation: [detail('Horário')],
  other: [detail('Horário')],
};

export function eventDetailsFor(type: string): EventDetail[] {
  return EVENT_DETAILS[type] ?? EVENT_DETAILS.other;
}

const normalizeText = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

// Aceita a linha solta ("**Rótulo:** valor") e como item de lista ("- **Rótulo:** valor", formato dos logísticos).
const LABEL_LINE = /^\s*(?:[-*+]\s+)?\*\*([^*]+?):\*\*\s*(.*)$/;

// Compara o `content` de um evento com o mínimo do tipo dele. Um item "a confirmar" conta como falta.
export function eventDetailGaps(event: { type: string; content: string }): { filled: string[]; missing: string[] } {
  const values = new Map<string, string>();
  for (const line of event.content.split('\n')) {
    const match = LABEL_LINE.exec(line);
    if (match) values.set(normalizeText(match[1]), normalizeText(match[2]));
  }
  const details = eventDetailsFor(event.type);
  const has = (d: EventDetail) =>
    d.aliases.some((alias) => {
      const value = values.get(normalizeText(alias));
      return value !== undefined && value !== '' && !value.startsWith('a confirmar');
    });
  return { filled: details.filter(has).map((d) => d.label), missing: details.filter((d) => !has(d)).map((d) => d.label) };
}

// Rede de segurança pra regra "nunca repita o título": tira linhas "**Rótulo:** valor" cujo valor
// inteiro já está no título ("**Ocasião:** Casamento" num "Casamento no Lago Maggiore"). O prompt
// já proíbe, mas o model às vezes repete mesmo assim — e o consultor não deveria ter que pedir.
// Rótulos de horário (os de `EVENT_DETAILS`) nunca saem, mesmo que o título cite a hora ("Voo X às 3h10").
const TIME_LABELS = new Set(Object.values(EVENT_DETAILS).flatMap((details) => details.flatMap((d) => d.aliases.map(normalizeText))));

function withoutTitleRepeats(lines: string[], title: string): string[] {
  const normalizedTitle = normalizeText(title);
  if (!normalizedTitle) return lines;
  return lines.filter((line) => {
    const match = LABEL_LINE.exec(line);
    if (!match || TIME_LABELS.has(normalizeText(match[1]))) return true;
    const value = normalizeText(match[2].replace(/[.;]\s*$/, ''));
    return !value || !normalizedTitle.includes(value);
  });
}

const LIST_ITEM = /^\s*([-*+]|\d+\.)\s/;

// O kanban renderiza o `content` com ReactMarkdown, que junta numa linha só duas linhas separadas
// por uma quebra simples — "**Horário:** 19h\n**Local:** X" aparecia corrido. Markdown só mantém a
// quebra se a linha terminar com dois espaços. Em vez de depender do model lembrar disso, todo
// evento gravado passa por aqui. Linhas em branco e itens de lista já quebram sozinhos. Com `title`,
// também tira as linhas que só repetem o título (`withoutTitleRepeats`).
export function normalizeEventContent(content: string, title?: string): string {
  const raw = content.replace(/\r\n/g, '\n').split('\n');
  const lines = title ? withoutTitleRepeats(raw, title) : raw;
  return lines
    .map((line, i) => {
      const next = lines[i + 1];
      if (!line.trim() || next === undefined || !next.trim() || LIST_ITEM.test(next)) return line.trimEnd();
      return `${line.trimEnd()}  `;
    })
    .join('\n')
    .trim();
}

// O formato que o consultor pediu pros cards (memória dele, kind "cards" — `getCardPreferences` em
// `services/ori-memory-db.ts`). Entra no prompt de todo caminho que escreve card (gerador por voucher,
// refazer, sugestões, Ori) e vale ACIMA do formato padrão: o que o consultor pede é lei. Vazio = só o
// padrão.
export function formatCardPreferences(preferences: string[]): string {
  if (preferences.length === 0) return '';
  return `## Como o consultor quer os cards

O consultor pediu este formato. Ele vale ACIMA do formato padrão (rótulos, ordem das linhas, horário na primeira linha, quais itens entram, linha sem dado): siga exatamente, inclusive campos que o padrão deixaria de fora (localizador, documento, bagagem...). Só não invente dado — o que não está na fonte fica em branco ou fora, como ele pediu.

${preferences.map((p) => `- ${p}`).join('\n')}`;
}
