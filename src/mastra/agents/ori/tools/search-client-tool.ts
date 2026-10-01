import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { CLIENT_FIELDS, OriginalMilesPlatformError, searchPlatformClient } from '../../../services/original-miles-platform';

// "Buscar Cliente" — ficha do cliente na plataforma Original Miles (`GET /api/v1/clientes`, ver
// `services/original-miles-platform.ts`). Só leitura, sem confirmação. O model escolhe as seções
// (`fields`) pra não trazer histórico/financeiro inteiro quando só precisa do cadastro.
export const searchClientTool = createTool({
  id: 'buscarCliente',
  description:
    'Busca um cliente na plataforma Original Miles pelo id, email ou CPF (pelo menos um; se vier mais de um, vale id > email > cpf) ' +
    'e devolve as seções pedidas em "fields": "dados_cadastrais" (ficha: documentos, contato, endereço, preferências de viagem — ' +
    'assento, cia aérea, cartão de milhas, estilo —, observações, última viagem), "hospedagens" (hotéis em que já ficou, com datas e ' +
    'valores aprovados), "destinos_visitados" (países/cidades já visitados), "itinerarios_realizados" (atividades já feitas, por ' +
    'cidade e data) e "resumo_financeiro" (quanto já gastou por tipo de serviço, em BRL). Sem "fields", vem só "dados_cadastrais". ' +
    'Peça só as seções que a pergunta precisa. Use para conhecer o histórico e o perfil do cliente (ex: não sugerir um lugar onde ele ' +
    'já foi, saber o padrão de hotel que costuma escolher). `data: null` = cliente não encontrado — diga isso ao consultor, não ' +
    'invente. Dados pessoais (documentos, endereço, valores): só repita o que o consultor pediu.',
  inputSchema: z
    .object({
      id: z.number().int().positive().optional().describe('id do cliente na plataforma (busca exata).'),
      email: z.string().email().optional().describe('email do cliente (busca exata).'),
      cpf: z.string().min(11).optional().describe('CPF do cliente, com ou sem pontuação.'),
      fields: z
        .array(z.enum(CLIENT_FIELDS))
        .optional()
        .describe('Seções a trazer. Omitido = só "dados_cadastrais".'),
    })
    .refine((input) => input.id !== undefined || input.email || input.cpf, {
      message: 'Informe id, email ou cpf.',
    }),
  outputSchema: z.unknown(),
  execute: async ({ id, email, cpf, fields }) => {
    try {
      const { data, meta } = await searchPlatformClient({ id, email, cpf }, fields);
      return { data, meta };
    } catch (error) {
      // Erros de negócio da API (400) voltam pro model se corrigir; o resto (401, rede) sobe.
      if (error instanceof OriginalMilesPlatformError && error.status === 400) {
        return { error: error.code, message: error.message };
      }
      throw error;
    }
  },
});
