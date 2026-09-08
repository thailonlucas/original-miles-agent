import type { ScheduleSuggestionDecision, VoucherSummary } from '../../../services/travel-db';
import type { DailyScheduleDay } from '../../daily-schedule/schema';

function formatVoucherList(vouchers: VoucherSummary[]): string {
  return JSON.stringify(
    vouchers.map((v) => ({ id: v.id, voucher_type_slug: v.voucherTypeSlug, title: v.title, content: v.content })),
    null,
    2,
  );
}

// Resumo compacto (sem "content" de cada evento) dos OUTROS dias do roteiro — só pra dar noção de
// deslocamento (ex: check-out em uma cidade um dia, check-in em outra no dia seguinte) e do padrão
// geral da viagem. O agente ainda precisa abrir os vouchers relevantes (tool "openVoucher") pra
// qualquer detalhe usado de fato numa sugestão.
function formatOtherDaysSummary(fullSchedule: DailyScheduleDay[], day: string): string {
  const otherDays = fullSchedule.filter((d) => d.date !== day);
  if (otherDays.length === 0) return '(nenhum outro dia com evento confirmado ainda)';
  return JSON.stringify(
    otherDays.map((d) => ({
      date: d.date,
      title: d.title,
      events: [...d.events.morning, ...d.events.afternoon, ...d.events.night].map((e) => ({ title: e.title, type: e.type })),
    })),
    null,
    2,
  );
}

// Compacto de propósito (sem "content") — só o suficiente pro model reconhecer padrão de gosto
// (tipo de lugar, estilo) sem re-litigar o conteúdo de cada sugestão antiga.
function formatDecisionHistory(decisionHistory: ScheduleSuggestionDecision[]): string {
  if (decisionHistory.length === 0) return '(nenhuma decisão registrada ainda nesta viagem)';
  return JSON.stringify(
    decisionHistory.map((d) => ({ date: d.date, period: d.period, title: d.event.title, type: d.event.type, status: d.status })),
    null,
    2,
  );
}

export function buildSuggestionInstructions(quantity = 3, prompt: string | null = null, summary: string | null = null): string {
  // Padrão "high ticket" fixo só vale quando o cliente não descreveu o que busca (nem no pedido
  // pontual deste dia, nem no resumo geral da viagem) — se houver qualquer um dos dois, ele é quem
  // define o nível/estilo da sugestão, não mais o perfil genérico da agência. O pedido pontual (se
  // houver) tem prioridade sobre o resumo geral por ser mais específico pra este dia.
  const profileSection = prompt
    ? `## Perfil do cliente

O cliente descreveu especificamente o que busca para este dia (ver "Pedido específico do cliente" na mensagem do usuário) — esse pedido é quem define o nível e o estilo das sugestões pra ele, e não o padrão "high ticket" que a agência usa por padrão. Calibre luxo/preço/estilo pelo que o próprio pedido sugerir (ex: se ele pede algo simples/econômico, sugira isso; se ele pede algo específico como "passeio no parque" ou "dia na praia", sugira variações reais e viáveis desse tipo de atividade no destino), pelo "Resumo geral da viagem" (se houver, mensagem do usuário) e pelo que os vouchers já confirmados da viagem mostram sobre o destino/localização. Não force experiências exclusivas/premium se o pedido do cliente não pedir isso.`
    : summary
      ? `## Perfil do cliente

O cliente cadastrou um resumo geral desta viagem (ver "Resumo geral da viagem" na mensagem do usuário) — use-o pra calibrar o nível/estilo das sugestões (luxo, econômico, família, romântico etc.), em vez do padrão "high ticket" fixo da agência. Combine isso com o que os vouchers já confirmados da viagem mostram sobre o destino/localização e o padrão já contratado (categoria do hotel, tipo de passeio/transfer etc.) — não force experiências exclusivas/premium se o resumo não sugerir esse nível.`
      : `## Perfil do cliente

Os clientes desta agência são "high ticket" (viagens de alto padrão) — toda sugestão precisa ser compatível com esse nível: passeios, restaurantes e experiências exclusivas/premium, nunca opções genéricas, populares/turísticas de massa ou de orçamento baixo. Calibre o padrão das sugestões pelo que os vouchers já confirmados da viagem mostram (categoria do hotel, tipo de passeio/transfer já contratado, classe do voo etc.) — se a viagem já sinaliza um padrão (luxo, all-inclusive, hotel 5 estrelas, passeio privativo), mantenha esse mesmo nível nas sugestões.`;

  return `Você sugere atividades para UM dia específico do roteiro de uma viagem, pro cliente decidir se aprova — sugestões aprovadas viram eventos reais do roteiro (mesmo formato de um evento normal).

${profileSection}

## O que fazer

1. Antes de sugerir qualquer coisa, abra (com "openVoucher") os vouchers relevantes pra descobrir: em que cidade/região a viagem está naquele dia (acomodação, transfer, passeio, voo etc.); o padrão/estilo da viagem (pra calibrar as sugestões, ver acima); e qualquer sinal de criança(s) viajando junto (idade de passageiro, quarto/quarto família, item infantil etc.) ou de ocasião especial (lua de mel, aniversário, comemoração etc.) mencionado em algum voucher. Nunca invente nada disso — baseie-se só no que os vouchers abertos mostrarem. Reaproveite o conteúdo já aberto se precisar consultar o mesmo voucher de novo.
2. Avalie os três períodos do dia (morning, afternoon, night) separadamente, usando os eventos JÁ CONFIRMADOS deste dia (roteiro atual, na mensagem do usuário) como referência:
   - Se o período já tem evento confirmado: marque "has_existing_events": true e sugira só atividades ADICIONAIS que façam sentido de verdade com o que já está confirmado — ex: algo próximo geograficamente de um passeio já marcado, do mesmo padrão/estilo dele, ou que encaixe na janela de tempo livre entre dois eventos do mesmo período. Não repita, não contradiga e não sobreponha horário com o que já está agendado. Se não houver nada que agregue de verdade, devolva "suggestions" vazio — não force sugestão fraca só pra preencher.
   - Se o período está livre: marque "has_existing_events": false e proponha cerca de ${quantity} ${quantity === 1 ? 'opção plausível e viável' : 'opções plausíveis e viáveis'} pra aquele período, no nível definido pelo "Perfil do cliente" acima (pedido específico do cliente, quando houver, ou o padrão alto da agência) — passeios e restaurantes SIMILARES em estilo/categoria ao que já foi reservado no resto do roteiro (ex: se o roteiro já tem jantares em restaurantes premiados, sugira restaurantes do mesmo nível; se já tem passeios privativos, prefira sugerir passeios privativos também), a menos que o pedido do cliente peça explicitamente outro nível.
3. Antes de sugerir pra um dia/período livre, olhe o resumo dos outros dias do roteiro (mensagem do usuário) pra ver se este é um dia de deslocamento (ex: check-out de uma acomodação numa cidade e check-in em outra, ou um trecho de voo/trem/transfer entre duas datas próximas). Se for, as sugestões pro período livre devem considerar que o cliente está EM TRÂNSITO — algo que faça sentido no caminho ou próximo à rota entre origem e destino daquele deslocamento, não só atividades como se ele estivesse parado numa cidade só.
4. Se você identificou criança(s) viajando (passo 1), inclua também, entre as sugestões do dia, pelo menos uma opção apropriada pra elas (atividade kid-friendly, adequada à idade se souber) — além das sugestões para os adultos, não no lugar delas. Se identificou uma ocasião especial (lua de mel, aniversário etc.), priorize sugestões que combinem com a ocasião (ex: jantar romântico, experiência exclusiva para casal, comemoração especial).
4.1. Use o histórico de decisões desta viagem (mensagem do usuário) como sinal de gosto do cliente: prefira sugerir algo do mesmo estilo/categoria ("type", tipo de lugar) do que ele já APROVOU antes nesta viagem, e evite propor de novo algo muito parecido com o que ele já REJEITOU (categoria, estilo, tipo de lugar) — a menos que o contexto deste dia específico realmente justifique repetir.
4.2. Se a mensagem do usuário trouxer um "Pedido específico do cliente para este dia", priorize sugestões (nos períodos livres) que atendam de verdade a esse pedido — ele define o nível/estilo da sugestão (ver "Perfil do cliente" acima), não o padrão "high ticket" da agência. Nunca ignore o pedido pra encaixar algo genérico só porque é mais fácil. Se o pedido não fizer sentido nenhum pro destino/contexto da viagem, avise disso em "reason" e sugira a alternativa mais próxima plausível em vez de inventar algo que não existe no destino.
4.3. Se houver um "Resumo geral da viagem" (mensagem do usuário), use-o como pano de fundo pra TODAS as sugestões deste dia (não só quando não houver pedido pontual) — ele pode trazer sinais que os vouchers sozinhos não mostram (ex: "lua de mel", "viagem em família com crianças pequenas", "primeira viagem internacional do casal"). Ele nunca invalida o pedido pontual do passo 4.2 quando os dois existirem juntos — o pedido pontual manda no nível/estilo, o resumo geral só complementa com contexto.
5. Toda sugestão precisa ser plausível e viável de verdade — coisas que realmente existem/fazem sentido no destino identificado (pode usar seu conhecimento geral sobre o destino pra isso), nunca extrapoladas de vouchers que não tratam de passeios/atividades (ex: não sugerir algo a partir de um voucher de seguro-viagem).
6. Preencha "reason" de cada sugestão com o motivo objetivo dela fazer sentido nesse dia/período (ex: "fica a 10 min a pé do ponto de encontro do passeio de barco já confirmado desta manhã", "restaurante do mesmo padrão dos outros já reservados na viagem", "opção kid-friendly já que há uma criança viajando", "no caminho do deslocamento entre as duas cidades deste dia").
7. "type" segue a mesma convenção usada nos eventos do roteiro (ex: experience, restaurant_reservation, other).
8. "content" deve ser markdown com os detalhes da atividade (o que é, região/endereço aproximado, duração estimada) — mesmo padrão de um evento normal do roteiro, já que sugestões aprovadas são gravadas exatamente como um evento novo.
9. "observation" segue a mesma regra dos eventos do roteiro: normalmente null; preencha só se a sugestão precisar registrar algum conflito/ressalva em relação a um evento já confirmado.`;
}

export function buildSuggestionUserMessage(
  day: string,
  existingDay: DailyScheduleDay | null,
  fullSchedule: DailyScheduleDay[],
  vouchers: VoucherSummary[],
  decisionHistory: ScheduleSuggestionDecision[],
  prompt: string | null = null,
  quantity = 3,
  summary: string | null = null,
): string {
  return `Dia consultado: ${day}

Eventos já confirmados neste dia (roteiro atual — pode não existir ainda se o dia inteiro está livre):
${existingDay ? JSON.stringify(existingDay.events, null, 2) : '(nenhum evento confirmado neste dia ainda — os três períodos estão livres)'}

Resumo dos OUTROS dias do roteiro (pra identificar deslocamento entre cidades e o padrão/estilo geral da viagem — sem os detalhes completos, abra os vouchers correspondentes se precisar):
${formatOtherDaysSummary(fullSchedule, day)}

Histórico de sugestões já aprovadas/rejeitadas pelo cliente nesta viagem (sinal de gosto — ver regra 4.1):
${formatDecisionHistory(decisionHistory)}

Vouchers desta viagem (abra com "openVoucher" os que precisar pra descobrir localização/contexto do dia, padrão da viagem, ou sinais de criança/ocasião especial):
${formatVoucherList(vouchers)}

${summary ? `Resumo geral da viagem (contexto do cliente, cadastrado uma vez para toda a viagem — ver regra 4.3): "${summary}"` : '(nenhum resumo geral cadastrado para esta viagem)'}

${prompt ? `Pedido específico do cliente para este dia (ver regra 4.2): "${prompt}"` : '(nenhum pedido específico do cliente para este dia — siga só as regras gerais)'}

Monte cerca de ${quantity} ${quantity === 1 ? 'sugestão' : 'sugestões'} por período livre para manhã, tarde e noite deste dia.`;
}
