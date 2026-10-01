import { env } from '../config/env';
import { requireEnv } from '../config/require-env';

// Client da API da plataforma Original Miles (app.originalmiles.net/api/v1) — hoje só leitura.
// A chave (`X-API-Key`) é vinculada a UMA empresa na plataforma: toda consulta já volta restrita a
// ela. Não confundir com `ORIGINAL_MILES_API_KEY`, que é a chave de entrada DESTE server.

const DEFAULT_BASE_URL = 'https://app.originalmiles.net/api/v1';

export const CLIENT_FIELDS = [
  'dados_cadastrais',
  'hospedagens',
  'destinos_visitados',
  'resumo_financeiro',
  'itinerarios_realizados',
] as const;

export type ClientField = (typeof CLIENT_FIELDS)[number];

export type ClientSearch = { id?: number; email?: string; cpf?: string };

type Envelope<T> =
  | { success: true; data: T; meta?: Record<string, unknown> }
  | { success: false; error: { code: string; message: string } };

export class OriginalMilesPlatformError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`Original Miles API ${status} ${code}: ${message}`);
  }
}

async function platformGet<T>(path: string, params: Record<string, string | undefined>) {
  const { ORIGINAL_MILES_PLATFORM_API_KEY } = requireEnv(
    { ORIGINAL_MILES_PLATFORM_API_KEY: env.ORIGINAL_MILES_PLATFORM_API_KEY },
    'Original Miles platform API',
  );
  const url = new URL(`${env.ORIGINAL_MILES_PLATFORM_API_URL ?? DEFAULT_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: { 'X-API-Key': ORIGINAL_MILES_PLATFORM_API_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => null)) as Envelope<T> | null;
  if (!body) {
    throw new OriginalMilesPlatformError(response.status, 'INVALID_RESPONSE', await response.text().catch(() => ''));
  }
  if (!body.success) {
    throw new OriginalMilesPlatformError(response.status, body.error.code, body.error.message);
  }
  return { data: body.data, meta: body.meta ?? {} };
}

// `GET /clientes` — prioridade da API: id > email > cpf. Cliente não encontrado volta `data: null`.
// Sem `fields`, a API devolve só `dados_cadastrais`.
export async function searchPlatformClient(search: ClientSearch, fields?: ClientField[]) {
  return platformGet<Record<string, unknown> | null>('/clientes', {
    id: search.id !== undefined ? String(search.id) : undefined,
    email: search.email,
    cpf: search.cpf,
    fields: fields?.length ? fields.join(',') : undefined,
  });
}
