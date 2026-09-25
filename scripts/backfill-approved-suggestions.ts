// Migração única: transforma em eventos do dia a dia as sugestões aprovadas antes de aprovar passar a
// inserir o evento (ver `backfillApprovedSuggestions`, `src/mastra/services/travel-db.ts`).
//
//   bun run scripts/backfill-approved-suggestions.ts                 # simula, todas as viagens
//   bun run scripts/backfill-approved-suggestions.ts --travel=03055  # simula, uma viagem
//   bun run scripts/backfill-approved-suggestions.ts --apply         # grava
//
// Sem `--apply` nada é gravado. Seguro rodar de novo: sugestão que já virou evento é pulada.
import pg from 'pg';
import { backfillApprovedSuggestions } from '../src/mastra/services/travel-db';

const apply = process.argv.includes('--apply');
const onlyTravel = process.argv.find((arg) => arg.startsWith('--travel='))?.split('=')[1];

const pool = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 1 });
const { rows } = await pool.query<{ tenant_id: string; id: string }>(
  `select tenant_id, id from travel
   where suggestions @> '[{"status":"approved"}]'::jsonb ${onlyTravel ? 'and id = $1' : ''}
   order by id`,
  onlyTravel ? [onlyTravel] : [],
);
await pool.end();

console.log(`${apply ? 'GRAVANDO' : 'SIMULAÇÃO (use --apply pra gravar)'} — ${rows.length} viagem(ns) com sugestão aprovada\n`);
let totalInserted = 0;
let totalDuplicates = 0;
for (const { tenant_id: tenantId, id: travelId } of rows) {
  const { inserted, duplicates } = await backfillApprovedSuggestions(tenantId, travelId, apply);
  if (inserted.length === 0 && duplicates.length === 0) continue;
  totalInserted += inserted.length;
  totalDuplicates += duplicates.length;
  console.log(`viagem ${travelId}: ${inserted.length} vira(m) evento, ${duplicates.length} duplicada(s)`);
  for (const e of inserted) console.log(`  + ${e.date} ${e.period.padEnd(9)} ${e.title}`);
  for (const e of duplicates) console.log(`  = ${e.date} ${e.period.padEnd(9)} ${e.title}  (já existe — sugestão repetida apagada)`);
}
console.log(`\nTotal: ${totalInserted} evento(s) novo(s), ${totalDuplicates} duplicada(s).`);
process.exit(0);
