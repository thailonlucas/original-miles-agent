import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { suggestDayActivities } from '../../schedule-suggestion/suggest-day-activities';

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// "Sugerir Atividades" — gera novas sugestões de atividades para um dia específico do roteiro
// (mesmo fluxo de `routes/schedule-suggestion-routes.ts`, disparado pelo chat em vez do app). Pra
// cada período do dia (manhã/tarde/noite): se já houver evento confirmado, sugere atividades
// ADICIONAIS que combinem com ele; se o período estiver livre, sugere opções com base nos
// vouchers/contexto da viagem. Grava as sugestões como "pending" — não insere nada no roteiro.
export const suggestActivitiesTool = createTool({
  id: 'sugerirAtividades',
  description:
    'Gera novas sugestões de atividades para um dia específico do roteiro (manhã/tarde/noite), com base nos vouchers da viagem e, ' +
    'opcionalmente, num pedido em texto livre do consultor/cliente (ex: "passeio no parque", "algo romântico à noite"). Use quando o ' +
    'consultor pedir sugestões/ideias de programação para um dia. As sugestões são gravadas como "pending" (aguardando aprovação) — ' +
    'nunca são inseridas direto no roteiro; use "buscarSugestoes" depois para conferir o que foi gerado, aprovado ou rejeitado.',
  inputSchema: z.object({
    day: z.string().regex(DAY_REGEX, 'formato esperado: YYYY-MM-DD').describe('Dia do roteiro para o qual gerar sugestões, no formato YYYY-MM-DD.'),
    prompt: z
      .string()
      .max(500)
      .optional()
      .describe('Texto livre descrevendo o tipo de recomendação desejada (ex: "passeio no parque", "dia na praia"), se o consultor tiver informado.'),
    quantity: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe('Quantas sugestões gerar por período livre (1 a 5). Default: 3.'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ day, prompt, quantity }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('sugerirAtividades: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    return suggestDayActivities(tenantId, travelId, userId, day, prompt ?? null, quantity ?? 3);
  },
});
