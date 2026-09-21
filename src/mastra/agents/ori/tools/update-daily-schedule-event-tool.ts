import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { schedulePeriodSchema } from '../../schedule-suggestion/schema';
import { updateDailyScheduleEvent } from '../../../services/travel-db';

// "Atualizar Evento do Roteiro" — corrige título/conteúdo de UM evento já confirmado do roteiro
// (originado de voucher), localizado por (date, period, index) — mesmo contrato de
// `routes/daily-schedule-event-routes.ts` (PATCH /travel_agent/daily-schedule/event), só que
// disparado pelo chat em vez do app. `tenant_id`/`travel_id`/`user_id` vêm do `requestContext`,
// mesmo contrato das outras tools deste agente.
export const updateDailyScheduleEventTool = createTool({
  id: 'atualizarEventoRoteiro',
  description:
    'Corrige o título e/ou conteúdo de um evento já existente no roteiro (daily_schedule), localizado por data, período ' +
    '("morning", "afternoon" ou "night") e índice dentro daquele período — use "buscarRoteiro" primeiro para saber a posição exata ' +
    'do evento. Use quando o consultor apontar que uma informação do roteiro está errada ou desatualizada e informar qual é o valor ' +
    'correto. Só envie os campos que realmente precisam mudar. Nunca chame esta tool para "corrigir" algo que você mesmo suspeita ' +
    'estar errado sem o consultor ter confirmado isso na conversa.',
  inputSchema: z
    .object({
      date: z.string().describe('Data do dia do evento, no formato YYYY-MM-DD (de "buscarRoteiro").'),
      period: schedulePeriodSchema.describe('Período do dia do evento: "morning", "afternoon" ou "night".'),
      index: z
        .number()
        .int()
        .min(0)
        .describe('Posição (0-based) do evento dentro do array daquele dia/período, vinda de "buscarRoteiro".'),
      title: z.string().optional().describe('Novo título do evento, se precisar mudar.'),
      content: z.string().optional().describe('Novo conteúdo (markdown) do evento, se precisar mudar.'),
    })
    .refine((value) => value.title !== undefined || value.content !== undefined, {
      message: 'Informe ao menos um campo para atualizar (title ou content).',
    }),
  outputSchema: z.unknown(),
  execute: async ({ date, period, index, title, content }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('atualizarEventoRoteiro: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    const updated = await updateDailyScheduleEvent(tenantId, travelId, userId, date, period, index, { title, content });
    if (!updated) {
      return { error: `evento não encontrado nesse dia/período/índice (${date}/${period}/${index}).` };
    }
    return updated;
  },
});
