import { createPool } from './client';
import { runMigrations } from './migrate';

async function main() {
  const pool = createPool();
  try {
    const applied = await runMigrations(pool);
    if (applied.length === 0) {
      console.log('Migraciones al día: nada que aplicar.');
    } else {
      for (const m of applied) console.log(`aplicada  ${m.module}/${m.version}`);
      console.log(`${applied.length} migración(es) aplicada(s).`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
