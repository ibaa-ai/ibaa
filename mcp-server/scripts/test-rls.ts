/**
 * RLS verification: connects via the Supabase JS client using the ANON key
 * and asserts that:
 *   - allowed public reads succeed
 *   - restricted reads return empty / forbidden
 *   - writes are denied
 *
 * Exits non-zero on any unexpected outcome. Intended for CI.
 */
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from '../src/env.js';

function fail(message: string): never {
  process.stderr.write(`RLS verification FAILED: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    process.stderr.write(
      'SUPABASE_URL and SUPABASE_ANON_KEY are required for RLS verification.\n' +
        'Add them to .env and re-run.\n',
    );
    process.exit(1);
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });

  process.stdout.write('RLS verification (anon role)\n');
  process.stdout.write('─────────────────────────────\n');

  // 1) locals SELECT should succeed
  {
    const { data, error } = await supabase.from('locals').select('id, number, name');
    if (error) fail(`locals SELECT errored: ${error.message}`);
    if (!data || data.length < 20)
      fail(`locals SELECT returned ${data?.length ?? 0} rows; expected ≥ 20`);
    process.stdout.write(`  ok: locals SELECT — ${data.length} rows\n`);
  }

  // 2) members public_card=true SELECT should succeed (may be 0 rows if no members)
  {
    const { error } = await supabase.from('members').select('id').limit(1);
    if (error) fail(`members SELECT errored: ${error.message}`);
    process.stdout.write('  ok: members SELECT — allowed (RLS policy admits public_card rows)\n');
  }

  // 3) dues_payments SELECT must be denied (no anon policy)
  {
    const { data, error } = await supabase.from('dues_payments').select('id').limit(1);
    if (error) {
      process.stdout.write(`  ok: dues_payments SELECT denied — ${error.message}\n`);
    } else if (data && data.length === 0) {
      process.stdout.write('  ok: dues_payments SELECT returned 0 rows (RLS empty)\n');
    } else {
      fail(`dues_payments SELECT returned ${data?.length ?? 0} rows; expected denial or empty`);
    }
  }

  // 4) keystore_backups SELECT must be denied
  {
    const { data, error } = await supabase.from('keystore_backups').select('member_id').limit(1);
    if (error) {
      process.stdout.write(`  ok: keystore_backups SELECT denied — ${error.message}\n`);
    } else if (data && data.length === 0) {
      process.stdout.write('  ok: keystore_backups SELECT returned 0 rows (RLS empty)\n');
    } else {
      fail(`keystore_backups SELECT returned ${data?.length ?? 0} rows; expected denial`);
    }
  }

  // 5) INSERT into locals must fail
  {
    const { error } = await supabase
      .from('locals')
      .insert({ number: 'TEST999', name: 'rls-test should-be-rejected' });
    if (!error) {
      // Try to clean up the unexpected insert
      await supabase.from('locals').delete().eq('number', 'TEST999');
      fail('anon INSERT into locals SUCCEEDED — policy is missing/wrong');
    }
    process.stdout.write(`  ok: anon INSERT denied — ${error.message}\n`);
  }

  process.stdout.write('─────────────────────────────\n');
  process.stdout.write('RLS verification passed.\n');
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  fail(detail);
});
