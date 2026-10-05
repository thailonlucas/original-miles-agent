import type { VoucherSummary } from '../../../services/travel-db';
import type { DailyScheduleDay, DailyScheduleEvent } from '../schema';
import { eventVoucherIds } from '../schedule-merge';
import {
  DAY_TITLE_FORMAT,
  EVENT_CONTENT_FORMAT,
  EVENT_FORMAT_GUIDE,
  EVENT_SOURCE_VOUCHER,
  EVENT_TITLE_FORMAT,
  EVENT_TYPE_FORMAT,
  formatCardPreferences,
} from '../event-format';

const COMMON_RULES = `## Regras por tipo de voucher

- Vouchers do tipo "travel_insurance" NUNCA geram evento — é cobertura, não atividade agendada.
- Vouchers do tipo "other" só geram evento se tiverem uma data preenchida no documento (ex: "dates.start_date"). Sem data nenhuma, ignore esse voucher.
- Para os demais tipos, gere evento sempre que houver uma data relevante no voucher.
- "type": ${EVENT_TYPE_FORMAT} É o voucher_type_slug do voucher de origem.
- "title": ${EVENT_TITLE_FORMAT}
- "content": ${EVENT_CONTENT_FORMAT} ${EVENT_SOURCE_VOUCHER}

## Como escrever o conteúdo de um evento

${EVENT_FORMAT_GUIDE}

${EVENT_SOURCE_VOUCHER}

## Regras gerais

- Antes de escrever qualquer evento, abra o voucher com a tool "openVoucher" — nunca invente ou complete informação que não veio de um voucher aberto. A lista de vouchers só tem id/tipo/título/resumo.
- Todo evento tem "voucher_id": o id do voucher de onde ele veio.
- Não chame "openVoucher" duas vezes para o mesmo id — reaproveite o que já abriu.
- Todo voucher que dura vários dias gera evento só no início e no fim — nunca repita o voucher nos dias do meio (nada de "Hospedagem no hotel X" ou "Carro alugado" em cada dia). Hospedagem = "Check-in" e "Check-out"; aluguel de carro = "Retirada" e "Devolução"; cruzeiro = embarque e desembarque; circuito/passeio de vários dias = início e fim. Nos dias do meio, só gere evento se o voucher trouxer uma programação própria daquele dia (ex: a parada do cruzeiro, o roteiro do dia 2 do circuito). O código já mostra, nos dias do meio, onde o cliente está — pelo "place" dos eventos de início e fim.
- "place": onde o evento acontece (nome do lugar e cidade). Preencha sempre que o voucher disser, principalmente nos eventos de início e fim de uma hospedagem ou aluguel.
- Nunca duplique o mesmo dado como dois eventos no mesmo dia.
- Período pelo horário local do voucher: morning = 00:00–11:59, afternoon = 12:00–17:59, night = 18:00–23:59. Sem horário, use o bom senso pelo tipo (check-out de manhã, jantar à noite) — mas nunca invente um horário no "content" (sem horário no voucher, "a confirmar").
- Se dois vouchers tocarem o mesmo acontecimento (confirmando ou contradizendo um dado), preencha "observation" citando de qual voucher vem cada informação. Caso contrário, null.
- Devolva só os dias que têm pelo menos um evento, em ordem cronológica.
- ${DAY_TITLE_FORMAT}
- Um "Resumo geral da viagem" (se houver) é só contexto do perfil do cliente — nunca cria evento.

## Voos de madrugada e voos que chegam em outro dia

Estas duas regras são as únicas exceções a "nunca duplique": o voo continua sendo UM evento no dia e período da partida, e cada regra abaixo acrescenta um evento a mais, com o mesmo "voucher_id" e o mesmo "type" do evento do voo. Em voo com conexão, aplique a regra de madrugada à partida do primeiro trecho e a de chegada à chegada do último — nunca às conexões do meio.

- Voo de madrugada — partida entre 00:00 e 05:59 (horário local da partida): o dia do cliente começa no dia ANTERIOR, porque ele precisa se preparar e ir pro aeroporto na noite antes. Gere, além do voo, um evento na "night" do dia anterior à partida:
  - "title": "Ida ao aeroporto — Voo TP 0824 às 3h10" (voo e horário de partida do voucher).
  - "content": só "- **Embarque:** 3h10 em Guarulhos (GRU)" (horário e aeroporto de partida).
  - "place": o aeroporto de partida.
- Voo que chega em outro dia — data de chegada (horário local da chegada) diferente da data de partida, ex: voo noturno ou longo: gere, além do voo, um evento no dia da chegada, no período do horário de chegada:
  - "title": "Chegada do voo TP 0824 em Milão Malpensa".
  - "content": só "- **Chegada:** 11h05 em Milão Malpensa (MXP)" (horário e aeroporto de chegada).
  - "place": o aeroporto de chegada.
- Só aplique quando o voucher trouxer o horário (madrugada) ou a data/hora de chegada (outro dia) — sem o dado, não deduza.`;

function formatVoucherList(vouchers: VoucherSummary[]): string {
  return JSON.stringify(
    vouchers.map((v) => ({ id: v.id, voucher_type_slug: v.voucherTypeSlug, title: v.title, content: v.content })),
    null,
    2,
  );
}

function formatSummary(summary: string | null): string {
  return summary ? `Resumo geral da viagem (contexto do cliente): "${summary}"` : '(nenhum resumo geral cadastrado para esta viagem)';
}

const ORIGIN_LABELS = { voucher: 'voucher', suggestion: 'sugestão aprovada', chat: 'adicionado pelo chat', manual: 'adicionado à mão' } as const;

// Dia a dia atual com o conteúdo de cada card — o agente precisa comparar pra saber se o voucher é
// um compromisso que já tem card. `index` é o que ele devolve pra enriquecer; `deste_voucher` marca
// os cards que este voucher já sustenta (numa atualização, é neles que ele mexe).
function formatScheduleCards(days: DailyScheduleDay[], voucherId: string): string {
  if (days.length === 0) return '(nenhum evento ainda)';
  const card = (event: DailyScheduleEvent, index: number) => ({
    index,
    title: event.title,
    content: event.content,
    observation: event.observation,
    place: event.place ?? null,
    type: event.type,
    origem: event.source ? ORIGIN_LABELS[event.source.type] : 'sem origem',
    deste_voucher: eventVoucherIds(event).includes(voucherId),
  });
  return JSON.stringify(
    days.map((day) => ({
      date: day.date,
      title: day.title,
      morning: day.events.morning.map(card),
      afternoon: day.events.afternoon.map(card),
      night: day.events.night.map(card),
    })),
    null,
    2,
  );
}

// Do zero ("refazer o dia a dia"): todos os eventos de voucher. Os cards que não vieram de voucher
// (sugestões aprovadas, chat, à mão) ficam — o código junta depois (`rebuildVoucherEvents`) — e vão
// aqui como contexto, pra não criar de novo um compromisso que um deles já cobre.
// `cardPreferences` (nos dois modos): o formato de card que o consultor pediu — vale acima do padrão.
export function buildFromScratchInstructions(cardPreferences: string[] = []): string {
  return `Você monta os eventos do dia a dia de uma viagem a partir dos vouchers já extraídos dela.

## O que fazer

1. Abra com "openVoucher" TODOS os vouchers da lista que podem gerar evento (todos exceto "travel_insurance"; "other" só se o resumo sugerir uma data). Nunca pule um voucher só pelo título — um resumo curto não mostra o range completo de datas, e pular é a causa mais comum de dia faltando.
2. Monte um item por dia que tiver pelo menos um evento, em ordem cronológica.
3. Os "cards que ficam" (lista na mensagem) continuam no dia a dia sem passar por você. Se um deles já é o compromisso de um voucher (ex: a sugestão "Almoço no Nobu" e a reserva do Nobu, na mesma data), NÃO gere evento pra esse compromisso — ele já tem card. Os outros eventos do mesmo voucher (ex: o check-out, se o card que fica é o check-in) você gera normalmente.

${COMMON_RULES}

${formatCardPreferences(cardPreferences)}`;
}

export function buildFromScratchUserMessage(vouchers: VoucherSummary[], keptDays: DailyScheduleDay[], summary: string | null): string {
  return `${formatSummary(summary)}

Cards que ficam no dia a dia (não vieram de voucher; não gere de novo um compromisso que já está aqui):
${formatScheduleCards(keptDays, '')}

Vouchers desta viagem:
${formatVoucherList(vouchers)}

Monte os eventos do dia a dia desta viagem.`;
}

// Um voucher só (criado ou atualizado): encaixa no dia a dia que já existe. Nunca recria nem
// substitui um card — enriquece o card do mesmo compromisso ou cria um novo. O código aplica
// (`applyVoucherOperations`, `schedule-merge.ts`).
export function buildVoucherOperationsInstructions(cardPreferences: string[] = []): string {
  return `Você encaixa UM voucher de uma viagem no dia a dia que o consultor já montou. O dia a dia pode ter horas de trabalho do consultor e é a base de referência: você nunca apaga, move nem escreve um card do zero — atualiza o card que já existe a partir do texto dele, ou cria um novo.

## O que fazer

1. Abra com "openVoucher" o voucher indicado. Se precisar comparar com um card que veio de outro voucher, pode abrir esse outro também.
2. Para cada compromisso do voucher (cada evento que ele geraria pelas regras abaixo), procure no dia a dia atual um card do MESMO compromisso, de qualquer origem — sugestão aprovada, chat, à mão ou outro voucher. Ex: a sugestão "Almoço no Nobu" e depois a reserva do Nobu; o passeio combinado no chat e depois o ingresso; o voo lançado à mão e depois o bilhete.
   - Mesmo compromisso NA MESMA DATA → "enrich" com date/period/index desse card. Em "content", devolva o texto ATUAL do card atualizado: mantenha tudo que o consultor escreveu (preferências, dicas, pedidos do cliente, a ordem e o jeito dele), troque o que o voucher comprova diferente ou que estava pendente ("Horário a confirmar" → "**Check-in:** 16h") e acrescente o que o voucher traz de novo (confirmação, localizador). Nunca apague uma informação do consultor que o voucher não contradiz. Se o voucher mudou algo que o consultor tinha escrito (outro horário, outro local), registre em "observation" com o valor antigo (ex: "Horário atualizado pelo voucher Nobu: 20h → 13h"); o que só estava pendente ou é novo não precisa de observação. Título só muda se tiver um dado que o voucher contradiz. Nada muda → não devolva operação nenhuma pra esse card (nunca um "enrich" com tudo null).
   - Parece o mesmo compromisso, mas em OUTRA DATA → não é o mesmo card. "create" do card novo na data do voucher, com "observation" apontando o card parecido (ex: "Pode ser o mesmo compromisso de 'Almoço no Nobu' (dia 12); o voucher indica o dia 13"), E um "enrich" só com "observation" no card parecido (ex: "O voucher Nobu indica o dia 13; foi criado um card lá"), com "content" null.
   - Não existe card desse compromisso → "create", com "index" na posição cronológica dentro do período (entre os cards que já existem), ou null pro fim.
   - Na dúvida se é o mesmo compromisso → "create" (um card a mais o consultor apaga; um card errado enriquecido ele pode nem perceber).
3. Voucher atualizado: os cards com "deste_voucher": true já vieram dele. Compare com o voucher de novo e faça "enrich" só se algo mudou ou é novo, do mesmo jeito (texto atual como base, "observation" com o valor antigo, ex: "Horário atualizado pelo voucher: 13h → 14h"). Nunca crie de novo um compromisso que já tem card "deste_voucher".
4. Se o voucher não gerar nenhum evento (ex: sem data), devolva "operations" vazio.
5. Num "enrich", mantenha o formato que o card já tem (é o do consultor). Num "create", siga o formato que o consultor pediu, se houver (abaixo).
6. Para cada dia em que você fez "create" (inclusive dia novo), devolva em "day_titles" o título do dia considerando todos os cards dele — no formato da regra "Título do dia" abaixo. Dias que você não tocou ficam fora.

${COMMON_RULES}

${formatCardPreferences(cardPreferences)}`;
}

export function buildVoucherOperationsUserMessage(
  currentDays: DailyScheduleDay[],
  vouchers: VoucherSummary[],
  voucherId: string,
  summary: string | null,
): string {
  return `${formatSummary(summary)}

Dia a dia atual (cards por dia e período, com o index de cada um):
${formatScheduleCards(currentDays, voucherId)}

Vouchers desta viagem:
${formatVoucherList(vouchers)}

Voucher indicado: id "${voucherId}". Encaixe ele no dia a dia atual.`;
}
