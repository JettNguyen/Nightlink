import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The app never writes its own plan, AI credits or usage. Step 2 of the profile
// privacy rollout makes the database ignore such writes anyway; this keeps the
// app from trying, so a purchase never looks like it worked when it didn't.

const SRC = fileURLToPath(new URL('../src', import.meta.url));

const sourceFiles = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return sourceFiles(path);
  return /\.(js|jsx)$/.test(name) && !/\.test\.js$/.test(name) ? [path] : [];
});

// An insert, update or upsert whose object names a billing column.
const BILLING_WRITE = /\.(?:insert|update|upsert)\(\s*\{[^)]*?\b(subscription|ai_usage|premium_emails)\s*:/gs;

test('no app code writes a plan, credits or usage', () => {
  const found = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(BILLING_WRITE)) found.push(`${file.slice(SRC.length + 1)}: ${match[1]}`);
    if (/syncCustomerInfoToSupabase|addCreditsToSupabase/.test(text)) found.push(`${file.slice(SRC.length + 1)}: old sync helper`);
  }
  assert.deepEqual(found, []);
});

test('the check above does catch such a write', () => {
  const sample = "await supabase.from('profiles').update({ ai_usage: next }).eq('id', uid);";
  assert.equal([...sample.matchAll(BILLING_WRITE)].length, 1);
  const subscription = "supabase.from('profiles').update({\n  subscription: { tier: 'premium' },\n})";
  assert.equal([...subscription.matchAll(BILLING_WRITE)].length, 1);
  assert.equal([...("supabase.from('profiles').update({ display_name: name })").matchAll(BILLING_WRITE)].length, 0);
});
