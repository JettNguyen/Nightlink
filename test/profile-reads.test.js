import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// From step 3 of the profile privacy rollout, signed-in people can read only
// the public columns of a profile (src/utils/profileReads.js). A query for any
// other column, or select('*'), fails for everyone. These checks keep the app
// from asking: your own row comes through fetchOwnProfile, other people's
// through the public columns.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

// The same list the rollout grants, read from both files so they can't drift.
const appColumns = readFileSync(join(SRC, 'utils/profileReads.js'), 'utf8')
  .match(/PUBLIC_PROFILE_COLUMNS = ([\s\S]*?);\n/)[1]
  .replace(/['+\s]/g, '')
  .split(',');
const grantedColumns = readFileSync(join(ROOT, 'supabase/rollout/3-profile-privacy-close.sql'), 'utf8')
  .match(/grant select \(([\s\S]*?)\) on public\.profiles to authenticated/)[1]
  .replace(/\s/g, '')
  .split(',');

const sourceFiles = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return sourceFiles(path);
  return /\.(js|jsx)$/.test(name) && !/\.test\.js$/.test(name) ? [path] : [];
});

// Before step 1 these fall back to the old reads; nothing else may.
const ALLOWED = new Set(['utils/profileReads.js']);

/** Every column list the app asks of profiles, with where it is. */
const profileReads = () => {
  const reads = [];
  for (const file of sourceFiles(SRC)) {
    const name = file.slice(SRC.length + 1);
    if (ALLOWED.has(name)) continue;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/from\('profiles'\)\s*\.select\(\s*(['"`])([^'"`]*)\1/g)) {
      reads.push({ name, columns: match[2] });
    }
    for (const match of text.matchAll(/\bprofiles(?:![a-z_]+)?\(([^)]*)\)/g)) {
      reads.push({ name, columns: match[1] });
    }
  }
  return reads;
};

const isPublic = (columns) => columns.split(',').map((c) => c.trim()).every((c) => appColumns.includes(c));

test('the app and the rollout agree on what anyone may read', () => {
  assert.deepEqual([...appColumns].sort(), [...grantedColumns].sort());
});

test('the app reads only public columns of profiles, and never select *', () => {
  const reads = profileReads();
  assert.ok(reads.length > 5, 'found the reads to check');
  assert.deepEqual(reads.filter((read) => !isPublic(read.columns)), []);
});

// The handler after a profiles subscription, and the name it gives the update.
const LIVE_PROFILE_HANDLER = /table: 'profiles'[\s\S]*?\},\s*(?:async\s*)?\(?\s*([A-Za-z_]*)\s*\)?\s*=>/g;

test('a live update to your own profile is only a cue to read it again', () => {
  let handlers = 0;
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(LIVE_PROFILE_HANDLER)) {
      handlers += 1;
      assert.equal(match[1], '', `${file.slice(SRC.length + 1)} reads the update itself, which carries only public columns`);
    }
  }
  assert.equal(handlers, 3, 'Settings, Feed and the activity preview each listen for their own profile');
});

test('the checks above do catch a private read', () => {
  const handler = ".on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${uid}` },\n  (payload) => setProfile(mapProfile(payload.new)))";
  assert.equal([...handler.matchAll(LIVE_PROFILE_HANDLER)][0][1], 'payload');
  assert.equal(isPublic('*'), false);
  assert.equal(isPublic('following_ids, settings'), false);
  assert.equal(isPublic('id, display_name, username'), true);
  const sample = "supabase.from('profiles').select('email').eq('normalized_username', name)";
  assert.equal([...sample.matchAll(/from\('profiles'\)\s*\.select\(\s*(['"`])([^'"`]*)\1/g)][0][2], 'email');
});
