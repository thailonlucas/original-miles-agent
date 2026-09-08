import { Mastra } from '@mastra/core/mastra';
import { SimpleAuth } from '@mastra/core/server';
import { PostgresStore } from '@mastra/pg';
import { DuckDBStore } from '@mastra/duckdb';
import { PinoLogger } from '@mastra/loggers';
import { MastraCompositeStore } from '@mastra/core/storage';
import { MastraEditor } from '@mastra/editor';
import {
  MastraStorageExporter,
  MastraPlatformExporter,
  Observability,
  SensitiveDataFilter,
} from '@mastra/observability';
import { env } from './config/env';
import { requireEnv } from './config/require-env';
import { documentAnalysisAgent } from './agents/original-miles-document-analysis/original-miles-document-analysis-agent';
import { imageAnalysisAgent } from './agents/original-miles-image-analysis/original-miles-image-analysis-agent';
import { voucherTypeAgent } from './agents/voucher-type/voucher-type-agent';
import { textExtractionAgent } from './agents/voucher-extractor/text-extraction-agent';
import { voucherExtractionAgent } from './agents/voucher-extractor/extraction-agent';
import { dailyScheduleAgent } from './agents/daily-schedule/daily-schedule-agent';
import { scheduleSuggestionAgent } from './agents/schedule-suggestion/schedule-suggestion-agent';
import { voucherExtractRoute, voucherDeleteRoute } from './routes/voucher-routes';
import { dailyScheduleGenerateRoute } from './routes/daily-schedule-routes';
import { scheduleSuggestionRoute } from './routes/schedule-suggestion-routes';
import { scheduleSuggestionDecisionListRoute, scheduleSuggestionDecisionRoute } from './routes/schedule-suggestion-decision-routes';
import { travelSummaryGetRoute, travelSummaryUpdateRoute } from './routes/travel-summary-routes';
import {
  companyReferenceListRoute,
  companyReferenceGetRoute,
  companyReferenceCreateRoute,
  companyReferenceUpdateRoute,
  companyReferenceDeleteRoute,
} from './routes/company-reference-routes';

// Silencia os warnings do AI SDK sobre o embedding model do Mastra rodar em modo de
// compatibilidade de spec (v2 -> v3) — o fallback automático já cobre, é só ruído no log.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const { SUPABASE_DB_URL } = requireEnv({ SUPABASE_DB_URL: env.SUPABASE_DB_URL }, 'Mastra storage');

export const mastra = new Mastra({
  bundler: {
    externals: ['@duckdb/node-bindings'],
  },
  // prettyPrint tem default `true` no PinoLogger do Mastra (mesmo com NODE_ENV=production) — sem
  // isso, cada log sai formatado em várias linhas em vez de um JSON compacto por entrada, o que
  // infla bastante o log do container (sem rotação configurada no host, isso vira disco sumindo).
  logger: new PinoLogger({ name: 'Mastra', level: 'info', prettyPrint: process.env.NODE_ENV !== 'production' }),
  agents: {
    imageAnalysisAgent,
    documentAnalysisAgent,
    voucherTypeAgent,
    textExtractionAgent,
    voucherExtractionAgent,
    dailyScheduleAgent,
    scheduleSuggestionAgent,
  },
  server: {
    // As rotas de travel_agent/* usam o access_token do Supabase Auth do usuário (requiresAuth:
    // false + verificação própria dentro da rota), não a chave estática abaixo.
    auth: new SimpleAuth({ tokens: { [env.ORIGINAL_MILES_API_KEY]: { id: 'original-miles-api' } } }),
    apiRoutes: [
      voucherExtractRoute,
      voucherDeleteRoute,
      dailyScheduleGenerateRoute,
      scheduleSuggestionRoute,
      scheduleSuggestionDecisionRoute,
      scheduleSuggestionDecisionListRoute,
      travelSummaryGetRoute,
      travelSummaryUpdateRoute,
      companyReferenceListRoute,
      companyReferenceGetRoute,
      companyReferenceCreateRoute,
      companyReferenceUpdateRoute,
      companyReferenceDeleteRoute,
    ],
  },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    // max abaixo do pool_size do Supabase Session Pooler (15), senão o pg.Pool
    // (default max: 20) estoura o pooler com EMAXCONNSESSION sob concorrência.
    default: new PostgresStore({ id: 'mastra-storage', connectionString: SUPABASE_DB_URL, max: 10 }),
    domains: {
      // memoryLimit alto o suficiente pra evitar spill em disco: o container roda com
      // readOnlyRootFilesystem, então um spill (que o DuckDB tenta em ".tmp" relativo ao
      // cwd) falha com "Read-only file system" e invalida o banco :memory: permanentemente
      // até o pod reiniciar.
      observability: await new DuckDBStore({ path: ':memory:', memoryLimit: '512MB' }).getStore('observability'),
    },
  }),
  editor: new MastraEditor(),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [new MastraStorageExporter(), new MastraPlatformExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
        logging: {
          enabled: true,
          level: 'info',
        },
      },
    },
  }),
});
