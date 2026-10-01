import { z } from 'zod';

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

const optionalString = () => z.preprocess(emptyToUndefined, z.string().min(1).optional());
const optionalUrl = () => z.preprocess(emptyToUndefined, z.string().url().optional());
const optionalEmail = () => z.preprocess(emptyToUndefined, z.string().email().optional());

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_MODEL: optionalString(),
  // Token exigido no header Authorization (Bearer <token>) pra acessar qualquer rota da API,
  // exceto o webhook do Zendesk (que não manda esse header).
  ORIGINAL_MILES_API_KEY: z.string().min(1, 'ORIGINAL_MILES_API_KEY is required'),
  OPENAI_EMBEDDING_MODEL: optionalString(),
  // Chave (header X-API-Key) da API da plataforma Original Miles, usada pela tool `buscarCliente` do
  // Ori — ver `services/original-miles-platform.ts`. A URL tem default (app.originalmiles.net/api/v1).
  ORIGINAL_MILES_PLATFORM_API_KEY: optionalString(),
  ORIGINAL_MILES_PLATFORM_API_URL: optionalUrl(),
  GOOGLE_GENERATIVE_AI_API_KEY: optionalString(),

  SUPABASE_URL: optionalUrl(),
  SUPABASE_SERVICE_ROLE_KEY: optionalString(),
  // Chave publishable/anon (não secreta) — usada só para validar o access_token do usuário
  // (Supabase Auth) que o frontend manda em `Authorization: Bearer <token>`, ver
  // `services/supabase-auth.ts`. Não dá acesso a dado nenhum sozinha (RLS continua valendo).
  SUPABASE_ANON_KEY: optionalString(),
  // Connection string do Postgres do Supabase (Project Settings > Database > Connection string).
  // Usada como storage da memória da OriginalMiles (@mastra/pg), separado do client REST acima.
  SUPABASE_DB_URL: optionalUrl(),
  OM_TENANT_ID: optionalString(),
  OM_AGENT_ID: optionalString(),

  PINECONE_API_KEY: optionalString(),
  PINECONE_INDEX_NAME: optionalString(),

  ZENDESK_SUBDOMAIN: optionalString(),
  ZENDESK_EMAIL: optionalEmail(),
  ZENDESK_API_TOKEN: optionalString(),
  ZENDESK_APP_ID: optionalString(),
  ZENDESK_HUMAN_SWITCHBOARD_ID: optionalString(),
  ZENDESK_AI_AGENT_SWITCHBOARD_ID: optionalString(),
  ZENDESK_CONVERSATIONS_API_KEY_ID: optionalString(),
  ZENDESK_CONVERSATIONS_API_KEY: optionalString(),
  // Validam quem pode chamar POST /webhooks/zendesk: o id do webhook (vem no corpo,
  // `webhook.id`) tem que bater com ZENDESK_WEBHOOK_ID, e o header `x-api-key` com
  // ZENDESK_WEBHOOK_SECRET. Ver `routes/zendesk-webhook.ts`.
  ZENDESK_WEBHOOK_ID: optionalString(),
  ZENDESK_WEBHOOK_SECRET: optionalString(),

  OM_MESSAGE_BUFFER_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  // Quantas vezes tentar gerar uma resposta da OriginalMiles antes de desistir e só transferir pra um
  // humano (ver `askOriginalMilesWithFallback` em `routes/zendesk-webhook.ts`).
  OM_ASK_MAX_ATTEMPTS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  OM_BUSINESS_HOURS_START_HOUR: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(23).optional()),
  OM_BUSINESS_HOURS_END_HOUR: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(23).optional()),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);
