import type { VoucherSummary } from '../../../services/travel-db';
import type { DailyScheduleDay } from '../schema';
import { EVENT_CONTENT_FORMAT, EVENT_TITLE_FORMAT, EVENT_TYPE_FORMAT } from '../event-format';

const COMMON_RULES = `## Regras por tipo de voucher

- Vouchers do tipo "travel_insurance" NUNCA geram evento — é cobertura, não atividade agendada.
- Vouchers do tipo "other" só geram evento se tiverem uma data preenchida no documento (ex: "dates.start_date"). Sem data nenhuma, ignore esse voucher.
- Para os demais tipos, gere evento sempre que houver uma data relevante no voucher.
- "type": ${EVENT_TYPE_FORMAT} É o voucher_type_slug do voucher de origem.
- "title": ${EVENT_TITLE_FORMAT}
- "content": ${EVENT_CONTENT_FORMAT}

## Regras gerais

- Antes de escrever qualquer evento, abra o voucher com a tool "openVoucher" — nunca invente ou complete informação que não veio de um voucher aberto. A lista de vouchers só tem id/tipo/título/resumo.
- Todo evento tem "voucher_id": o id do voucher de onde ele veio.
- Não chame "openVoucher" duas vezes para o mesmo id — reaproveite o que já abriu.
- Um voucher pode cobrir vários dias — inclua o evento em TODOS os dias que ele cobre (ex: hospedagem com check-in dia 10 e check-out dia 15 gera evento nos dias 10, 11, 12, 13, 14 e 15), sem duplicar o mesmo dado como dois eventos no mesmo dia.
- Período pelo horário local do voucher: morning = 00:00–11:59, afternoon = 12:00–17:59, night = 18:00–23:59. Sem horário, use o bom senso pelo tipo (check-out de manhã, jantar à noite) — mas nunca invente um horário no "content".
- Se dois vouchers tocarem o mesmo acontecimento (confirmando ou contradizendo um dado), preencha "observation" citando de qual voucher vem cada informação. Caso contrário, null.
- Devolva só os dias que têm pelo menos um evento, em ordem cronológica.
- Um "Resumo geral da viagem" (se houver) é só contexto do perfil do cliente — nunca cria evento.`;

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

// Versão enxuta do dia a dia atual (sem "content") — basta pro agente saber o que já existe em cada
// dia/período, sem gastar contexto com o texto completo de cada evento.
function formatCurrentSchedule(days: DailyScheduleDay[]): string {
  if (days.length === 0) return '(nenhum evento ainda)';
  return JSON.stringify(
    days.map((day) => ({
      date: day.date,
      title: day.title,
      morning: day.events.morning.map((e) => e.title),
      afternoon: day.events.afternoon.map((e) => e.title),
      night: day.events.night.map((e) => e.title),
    })),
    null,
    2,
  );
}

// Do zero: todos os eventos de voucher da viagem. Sugestões aprovadas e eventos manuais não passam
// por aqui — o código junta eles depois (`schedule-merge.ts`).
export function buildFromScratchInstructions(): string {
  return `Você monta os eventos do dia a dia de uma viagem a partir dos vouchers já extraídos dela.

## O que fazer

1. Abra com "openVoucher" TODOS os vouchers da lista que podem gerar evento (todos exceto "travel_insurance"; "other" só se o resumo sugerir uma data). Nunca pule um voucher só pelo título — um resumo curto não mostra o range completo de datas, e pular é a causa mais comum de dia faltando.
2. Monte um item por dia que tiver pelo menos um evento, em ordem cronológica.

${COMMON_RULES}`;
}

export function buildFromScratchUserMessage(vouchers: VoucherSummary[], summary: string | null): string {
  return `${formatSummary(summary)}

Vouchers desta viagem:
${formatVoucherList(vouchers)}

Monte os eventos do dia a dia desta viagem.`;
}

// Um voucher só (criado ou atualizado): devolve apenas os eventos DELE. Os eventos antigos desse
// voucher já foram tirados do dia a dia pelo código antes desta chamada, então não há o que
// "atualizar" — só gerar de novo o que ele contribui.
export function buildForVoucherInstructions(): string {
  return `Você gera os eventos do dia a dia que vêm de UM voucher específico de uma viagem. O dia a dia atual (dos outros vouchers, sugestões aprovadas e eventos manuais) é só contexto — você não pode alterá-lo.

## O que fazer

1. Abra com "openVoucher" o voucher indicado. Se precisar comparar com um evento que já existe, pode abrir outros vouchers da lista.
2. Devolva SOMENTE os eventos que vêm do voucher indicado — nunca repita eventos de outros vouchers que já estão no dia a dia.
3. Se um evento deste voucher for o mesmo acontecimento de um evento que já existe (ex: o mesmo voo em dois vouchers), crie o evento mesmo assim e use "observation" pra dizer que ele confirma ou contradiz o evento já existente.
4. Para cada dia que você devolver, o "title" do dia deve resumir o evento mais relevante daquele dia considerando também os eventos que já existem nele.
5. Se o voucher não gerar nenhum evento (ex: sem data), devolva "days" vazio.

${COMMON_RULES}`;
}

export function buildForVoucherUserMessage(
  currentDays: DailyScheduleDay[],
  vouchers: VoucherSummary[],
  voucherId: string,
  summary: string | null,
): string {
  return `${formatSummary(summary)}

Dia a dia atual (títulos por dia e período — sem os eventos do voucher indicado):
${formatCurrentSchedule(currentDays)}

Vouchers desta viagem:
${formatVoucherList(vouchers)}

Voucher indicado: id "${voucherId}". Gere os eventos do dia a dia que vêm dele.`;
}
