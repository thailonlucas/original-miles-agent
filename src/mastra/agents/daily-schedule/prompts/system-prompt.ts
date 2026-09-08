import type { VoucherSummary, TravelScheduleState } from '../../../services/travel-db';

const COMMON_RULES = `## Regras por tipo de voucher

- Vouchers do tipo "travel_insurance" NUNCA geram evento — é cobertura, não atividade agendada.
- Vouchers do tipo "other" só geram evento se tiverem uma data preenchida no documento (ex: "dates.start_date"). Sem data nenhuma, ignore esse voucher.
- Para os demais tipos, gere evento sempre que houver uma data relevante no voucher.

## Regras gerais

- Antes de escrever qualquer evento, use a tool "openVoucher" para abrir o conteúdo completo do voucher correspondente — nunca invente ou complete informação que não veio de um voucher aberto. A lista de vouchers abaixo só tem id/tipo/título/resumo, não os dados completos.
- **Abra TODOS os vouchers da lista que puderem gerar evento** (todos, exceto "travel_insurance" — e "other" só se o resumo já sugerir uma data) — nunca decida que um voucher "não parece relevante" só pelo título/resumo sem abrir. Um resumo curto não mostra o range de datas completo (ex: uma hospedagem de 6 noites), então pular a abertura é a causa mais comum de dia faltando ou data errada no roteiro final.
- Reaproveite o conteúdo já aberto se o mesmo voucher precisar ser usado em mais de um dia (ex: acomodação de várias noites) — não chame "openVoucher" de novo pro mesmo id.
- Um voucher pode cobrir mais de um dia — inclua o evento correspondente em TODOS os dias que ele cobre (ex: uma hospedagem de check-in dia 10 e check-out dia 15 gera evento nos dias 10, 11, 12, 13, 14 e 15 — não só no check-in e no check-out), mas nunca duplique o mesmo dado como dois eventos diferentes no mesmo dia.
- Classifique cada evento no período certo pelo horário: morning = 00:00–11:59, afternoon = 12:00–17:59, night = 18:00–23:59. Sem horário no voucher, use o bom senso pelo tipo (ex: check-out costuma ser de manhã, jantar à noite) — mas nunca invente um horário específico no "content", só o período.
- Se dois ou mais vouchers tocarem o mesmo evento (confirmando ou contradizendo o mesmo dado), preencha "observation" citando de qual voucher vem cada informação. Caso contrário, "observation" é null.
- Se um evento já existente no roteiro atual tiver o campo "suggested": true, preserve esse campo (com o mesmo valor) ao reescrever/manter esse evento — nunca defina "suggested": true em um evento novo por conta própria, esse campo só existe em sugestões aprovadas pelo cliente.
- **Só inclua no array de saída os dias que têm pelo menos um evento.** Não crie dias vazios — quem consome isso já sabe o range da viagem por "travel_start_at"/"travel_end_at" e trata qualquer dia fora do array como um dia sem evento.
- "travel_start_at"/"travel_end_at" cobrem TODO o período conhecido da viagem, a partir das datas mais extremas encontradas nos vouchers abertos.
- Se houver um "Resumo geral da viagem" (mensagem do usuário), use-o só como contexto pra entender o perfil/estilo da viagem (ex: lua de mel, viagem em família) — ele NUNCA cria evento novo por conta própria; todo evento continua vindo exclusivamente de um voucher aberto.`;

function formatVoucherList(vouchers: VoucherSummary[]): string {
  return JSON.stringify(
    vouchers.map((v) => ({ id: v.id, voucher_type_slug: v.voucherTypeSlug, title: v.title, content: v.content })),
    null,
    2,
  );
}

function formatSummary(summary: string | null): string {
  return summary ? `Resumo geral da viagem (contexto do cliente, cadastrado uma vez para toda a viagem): "${summary}"` : '(nenhum resumo geral cadastrado para esta viagem)';
}

// Modo 1: reconstrói o roteiro inteiro a partir de TODOS os vouchers da viagem (usado só quando
// não dá pra fazer incremental — hoje, depois de excluir um voucher, ver `rebuild-daily-schedule.ts`).
export function buildRebuildInstructions(): string {
  return `Você monta o roteiro dia a dia de uma viagem a partir de todos os vouchers já extraídos dela.

## O que fazer

1. Abra (com "openVoucher") os vouchers relevantes e determine o primeiro e o último dia do itinerário a partir das datas encontradas (embarque/desembarque, check-in/check-out, datas de reserva etc.) — isso vira "travel_start_at"/"travel_end_at".
2. Monte um item por dia que tiver pelo menos um evento, em ordem cronológica.

${COMMON_RULES}`;
}

export function buildRebuildUserMessage(vouchers: VoucherSummary[], summary: string | null = null): string {
  return `${formatSummary(summary)}

Vouchers desta viagem:
${formatVoucherList(vouchers)}

Monte o roteiro dia a dia completo desta viagem.`;
}

// Modo 2: parte do roteiro JÁ existente e aplica só o que UM voucher novo adiciona ou muda — não
// reprocessa o conteúdo dos vouchers antigos, só o resumo que já existe deles no roteiro atual (a
// lista completa de vouchers ainda vai no prompt, pra permitir abrir um voucher antigo se precisar
// reconciliar/contrastar com o novo). Caminho padrão a cada voucher extraído.
export function buildIncrementalInstructions(): string {
  return `Você mantém o roteiro dia a dia de uma viagem. Um voucher NOVO acabou de ser extraído — atualize o roteiro já existente com o que esse voucher adiciona ou muda, sem refazer o resto do zero.

## O que fazer

1. Abra (com "openVoucher") o voucher novo indicado. Se precisar reconciliar/contrastar com um evento já existente no roteiro, pode abrir outros vouchers da lista também.
2. Se o voucher novo cobre um dia que já existe no roteiro atual, ATUALIZE esse dia — adicione o(s) evento(s) novo(s) no período certo (morning/afternoon/night), preservando os eventos que já existiam de outros vouchers. Se o voucher novo confirma ou contradiz um evento já existente do mesmo horário, use "observation" pra registrar isso (cite os dois vouchers).
3. Se o voucher novo cobre um dia que ainda não existe no roteiro, CRIE esse dia novo, na posição cronológica certa.
4. Se as datas do voucher novo estendem o período conhecido da viagem (mais cedo que "travel_start_at" atual, ou mais tarde que "travel_end_at" atual), atualize esses dois campos. Se a viagem ainda não tinha nenhuma data conhecida, defina os dois a partir deste voucher.
5. Retorne o roteiro COMPLETO atualizado (todos os dias com evento, os que já existiam + o(s) que mudou/criou), não só a parte que mudou.

${COMMON_RULES}`;
}

export function buildIncrementalUserMessage(
  currentState: TravelScheduleState,
  vouchers: VoucherSummary[],
  newVoucherId: string,
  summary: string | null = null,
): string {
  return `${formatSummary(summary)}

Roteiro atual da viagem:
travel_start_at: ${currentState.travelStartAt ?? '(ainda não definido)'}
travel_end_at: ${currentState.travelEndAt ?? '(ainda não definido)'}
Dias com evento (JSON, pode estar vazio se esta é a primeira extração da viagem):
${JSON.stringify(currentState.dailySchedule, null, 2)}

Vouchers desta viagem:
${formatVoucherList(vouchers)}

Voucher NOVO que motivou esta atualização: id "${newVoucherId}" (veja na lista acima).

Atualize o roteiro com o que esse voucher novo adiciona ou muda.`;
}

// Modo 3: endpoint `POST /travel_agent/daily-schedule` — gera o roteiro do ZERO, mas ao contrário
// de `buildRebuildInstructions` (roteiro ESPARSO, só dias com evento) devolve um item por dia
// entre o primeiro e o último dia do itinerário, incluindo dias sem nenhum evento, dentro de um
// envelope { response, analysed_doc_ids } (ver `schema.ts` -> `dailyScheduleGenerateResultSchema`
// e `generate-daily-schedule.ts`).
export function buildGenerateInstructions(): string {
  return `Você recebe a lista de vouchers da viagem. Antes de escrever qualquer evento, use a tool "openVoucher" para abrir o conteúdo completo do voucher correspondente — nunca invente ou complete informação que não veio de um documento aberto:

Para cada dia entre o primeiro e o último dia do itinerário: abra com a tool SOMENTE os vouchers cujo \`start_date\`/\`end_date\` cubra aquele dia — um voucher por chamada, e reaproveite o conteúdo já obtido se o mesmo \`voucher_id\` já foi aberto num dia anterior (ex: acomodação de várias noites). Voucher do tipo \`travel_insurance\` nunca gera evento — é cobertura, não atividade agendada. Voucher do tipo \`other\` só gera evento se o documento aberto tiver \`dates.start_date\` preenchido.

Monte um array com exatamente um objeto por dia, em ordem cronológica, do primeiro ao último dia do itinerário, incluindo os dias sem nenhum evento, no formato:

\`\`\`json
[
  {
    "date": "YYYY-MM-DD",
    "title": "Frase curta resumindo o evento mais relevante deste dia. Se nenhum voucher cobrir este dia, não abra nada e use 'Em [cidade]' — nunca preencha com sugestões inventadas",
    "events": {
      "morning": [
        {
          "title": "Título curto do evento (ex: 'Voo LA 3318 GRU → FOR')",
          "content": "Markdown com tudo relacionado a este evento neste horário (00:00–11:59): horários, localizador, endereço, contatos relevantes. Usar SOMENTE dados do documento aberto pela tool — nunca inventar informação ausente",
          "type": "Tipo do voucher que originou este evento: flight | accommodation | transfer | restaurant | car_rental | ferry | experience",
          "observation": "Preencha SOMENTE quando outro voucher também tocar este mesmo evento e complementar ou contradizer esta informação (ex: um confirma um dado que o outro não traz, ou os dois trazem valores diferentes pro mesmo campo); cite de qual voucher vem cada dado. Use null quando só houver uma fonte para este evento"
        }
      ],
      "afternoon": [ /* eventos entre 12:00 e 17:59, mesmo formato acima */ ],
      "night": [ /* eventos entre 18:00 e 23:59, mesmo formato acima */ ]
    }
  }
]
\`\`\`

Se houver um "Resumo geral da viagem" (mensagem do usuário), use-o só como contexto pra entender o perfil/estilo da viagem — ele NUNCA cria evento novo por conta própria; todo evento continua vindo exclusivamente de um voucher aberto.

Sua resposta final deve ser um objeto JSON com exatamente dois campos:
- "response": o array acima, serializado como texto (string) — não como objeto aninhado.
- "analysed_doc_ids": lista com os ids de TODOS os vouchers que você abriu com a tool "openVoucher" para montar o roteiro.`;
}

export function buildGenerateUserMessage(vouchers: VoucherSummary[], summary: string | null = null): string {
  return `${formatSummary(summary)}

Vouchers desta viagem:
${formatVoucherList(vouchers)}

Monte o roteiro dia a dia completo desta viagem, do primeiro ao último dia do itinerário.`;
}
