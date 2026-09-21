import type { StoredSuggestion, VoucherSummary } from '../../../services/travel-db';
import type { DailyScheduleDay } from '../../daily-schedule/schema';
import type { ScheduleSuggestionResult } from '../schema';
import { formatDecisionHistory, formatOtherDaysSummary, formatVoucherList } from './system-prompt';

// Compacto das sugestões geradas (sem "content" completo, só o que basta pro revisor avaliar) —
// mantém a mesma ORDEM em que foram geradas em cada período, porque a resposta do validador
// correlaciona por posição (ver `scheduleSuggestionValidationSchema` em `schema.ts`), não por id
// (as sugestões ainda não têm id nesta etapa, o id só é gerado depois de validadas).
function formatGeneratedSuggestions(result: ScheduleSuggestionResult): string {
  const periods = (['morning', 'afternoon', 'night'] as const).map((period) => ({
    period,
    has_existing_events: result[period].has_existing_events,
    suggestions: result[period].suggestions.map((s) => ({ title: s.title, type: s.type, reason: s.reason, content: s.content })),
  }));
  return JSON.stringify(periods, null, 2);
}

export function buildValidationInstructions(): string {
  return `Você audita as sugestões de atividade que o agente "Schedule Suggestion" acabou de gerar para UM dia do roteiro de uma viagem, ANTES de elas serem mostradas ao cliente. Você não cria sugestões novas — só avalia as que já existem.

Você recebe o mesmo contexto que o agente gerador usou (vouchers, outros dias do roteiro, histórico de decisões, pedido do cliente, resumo da viagem) e a lista de sugestões geradas para os três períodos (morning, afternoon, night). Para CADA sugestão, na mesma ordem em que aparece no período, devolva um veredito:

- "approved": a sugestão está de acordo com todas as regras abaixo, pode ir pro cliente sem alteração.
- "flagged": a sugestão tem um problema real, mas não é grave o bastante pra descartar sozinho o julgamento do revisor — trate como "precisa ser refeita", explique o motivo.
- "rejected": a sugestão viola claramente uma das regras abaixo e não deve ir pro cliente como está.

Regras a checar, por sugestão:

1. **Repetição literal (histórico)**: a sugestão não pode ser essencialmente o MESMO lugar/atividade de uma entrada já "approved" ou "rejected" no histórico de decisões desta viagem — mesmo que o título esteja escrito de forma diferente (tradução, sinônimo, com/sem artigo). Se for, "rejected".
2. **Sinal de gosto ("client_feedback")**: quando uma decisão do histórico tiver motivo explícito da pessoa (ex: "muito caro" numa rejeição, "adoramos vinícolas" numa aprovação), a sugestão não pode contrariar esse motivo específico (ex: sugerir algo do mesmo padrão de preço que foi criticado). Se contrariar, "flagged" ou "rejected" dependendo da gravidade.
3. **Restrição explícita do pedido do cliente**: se houver um "Pedido específico do cliente" com uma restrição clara (ex: "sem X", "evite Y", "nada de W"), qualquer sugestão que viole essa restrição é "rejected" — esta é a regra mais rígida de todas.
4. **Nível/estilo consistente**: a sugestão deve bater com o nível/estilo definido pelo pedido do cliente (se houver), pelo resumo da viagem (se houver) ou pelo padrão "high ticket" da agência (default), e ser compatível com o padrão que os vouchers confirmados mostram (categoria de hotel, tipo de passeio já contratado etc.). Uma sugestão muito abaixo ou muito acima do nível esperado é "flagged" (ou "rejected" se o desvio for grosseiro).
5. **Sem sobreposição com evento já confirmado**: a sugestão não pode repetir, contradizer ou colidir de horário com um evento já confirmado neste dia/período.
6. **Coerência com dia de trânsito**: se o resumo dos outros dias indica que este é um dia de deslocamento (check-out numa cidade / check-in em outra, ou trecho de viagem entre duas datas próximas), as sugestões pro período livre devem fazer sentido em trânsito — não como se o cliente estivesse parado numa cidade só.
7. **Plausibilidade real**: a sugestão deve soar como algo que realmente existe/faz sentido no destino identificado pelos vouchers — desconfie de sugestões genéricas demais ou que pareçam inventadas. Marque "flagged" se parecer pouco crível.
8. **Cobertura de criança/ocasião especial** (regra do CONJUNTO de sugestões do dia, não de uma sugestão isolada): se os vouchers sinalizarem criança(s) viajando ou uma ocasião especial (lua de mel, aniversário etc.), pelo menos UMA sugestão do dia deveria atender isso. Se nenhuma atender e o sinal for claro, marque a sugestão mais genérica de um período livre como "flagged" com esse motivo (não invente esse sinal se os vouchers não deixarem claro).

Não penalize formatação (schema, campos preenchidos) — isso já é garantido antes de chegar até você. Foque só no conteúdo/adequação da sugestão. Preencha "violated_rules" com os números das regras acima que a sugestão violou (array vazio se "approved") e "reason" com uma frase objetiva explicando o veredito.`;
}

export function buildValidationUserMessage(
  day: string,
  existingDay: DailyScheduleDay | null,
  fullSchedule: DailyScheduleDay[],
  vouchers: VoucherSummary[],
  decisionHistory: StoredSuggestion[],
  prompt: string | null,
  summary: string | null,
  generated: ScheduleSuggestionResult,
): string {
  return `Dia consultado: ${day}

Eventos já confirmados neste dia (roteiro atual):
${existingDay ? JSON.stringify(existingDay.events, null, 2) : '(nenhum evento confirmado neste dia — os três períodos estavam livres)'}

Resumo dos OUTROS dias do roteiro (pra identificar dia de deslocamento):
${formatOtherDaysSummary(fullSchedule, day)}

Histórico de sugestões já aprovadas/rejeitadas pelo cliente nesta viagem:
${formatDecisionHistory(decisionHistory)}

Vouchers desta viagem (localização, padrão da viagem, sinais de criança/ocasião especial):
${formatVoucherList(vouchers)}

${summary ? `Resumo geral da viagem: "${summary}"` : '(nenhum resumo geral cadastrado para esta viagem)'}

${prompt ? `Pedido específico do cliente para este dia: "${prompt}"` : '(nenhum pedido específico do cliente para este dia)'}

Sugestões geradas para este dia, pra você auditar (mantenha a mesma ordem e a mesma quantidade por período na sua resposta):
${formatGeneratedSuggestions(generated)}`;
}
