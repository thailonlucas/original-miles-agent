import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { appendTravelSummary } from '../../../services/travel-db';

// "Anotar no Contexto da Viagem" — acrescenta UMA informação ao fim do Contexto da Viagem
// (`travel.summary`, o campo "Contexto da Viagem" do front), sem tocar no que já está escrito.
// Automático: tudo que o consultor conta sobre o cliente/viagem é relevante e fica guardado — por
// isso sem confirmação. O texto é concatenado no SQL (`appendTravelSummary`), então o model nunca
// reescreve o contexto inteiro e não tem como apagar algo por engano.
export const noteTravelContextTool = createTool({
  id: 'anotarContextoViagem',
  description:
    'Guarda no Contexto da Viagem UMA informação que o consultor contou sobre o cliente ou a viagem (perfil, gostos, restrições, ' +
    'ocasião, orçamento, quem viaja...). Ex: "o cliente gosta de vinho" → "Cliente gosta de vinho". Chame na hora, sem perguntar e ' +
    'sem anunciar — tudo que o consultor conta é relevante. Não repita o que já está no Contexto da Viagem. Acrescenta ao fim, ' +
    'nunca apaga nada; pra corrigir ou reorganizar o texto todo, use "atualizarContextoViagem".',
  inputSchema: z.object({
    note: z.string().min(1).max(300).describe('A informação, curta e objetiva, em terceira pessoa (ex: "Casal em lua de mel; evita frutos do mar").'),
  }),
  outputSchema: z.unknown(),
  execute: async ({ note }, { requestContext }) => {
    const tenantId = requestContext.get<string, string>('tenant_id');
    const travelId = requestContext.get<string, string>('travel_id');
    const userId = requestContext.get<string, string>('user_id');
    if (!tenantId || !travelId || !userId) {
      throw new Error('anotarContextoViagem: requestContext "tenant_id"/"travel_id"/"user_id" são obrigatórios.');
    }

    const summary = await appendTravelSummary(tenantId, travelId, userId, note);
    if (summary === null) {
      return { error: 'O Contexto da Viagem está cheio. Consolide o texto com "atualizarContextoViagem" e tente de novo.' };
    }
    return { saved: true };
  },
});
