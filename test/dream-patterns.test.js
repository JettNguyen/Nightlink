import { test } from 'node:test';
import assert from 'node:assert/strict';
import aiRoute from '../api/ai.js';

// Pattern recognition against a fake Supabase and a fake OpenAI. The fake model
// is told what to answer, including the wrong answers a real one gives, and the
// tests check what reaches the person. Nothing leaves this machine.

const {
  reconcileMemory, updateDreamMemory, memoryEntries, verifyMatches, quoteFound, namesTheThing,
  MEMORY_PROMPT, MATCH_PROMPT, SAME_THING_PROMPT,
} = aiRoute.internals;

const SAM = '6b0f8f8e-2d4c-4b8a-9f43-1c2d3e4f5a61';

const MEMORY = `## Recurring symbols
- water: ~3 times; calm in early entries, rough recently

## Recurring figures & people
- Mom: ~2 times; always just out of reach

## Seen once
- a black Tesla
- a locked greenhouse`;

const NO_TESLA = 'I was at the grocery store with Mom and the aisles kept getting longer. The water fountain was overflowing onto the floor.';
const TESLA = 'A black Tesla pulled up outside my old apartment and nobody got out. I just stood there in the rain.';

const entryId = (memory, name) => memoryEntries(memory).find((e) => e.name === name).id;
const answer = (matches) => JSON.stringify({ matches });

test('the prompts carry no example the model could hand back as a real match', () => {
  for (const prompt of [MEMORY_PROMPT, MATCH_PROMPT, SAME_THING_PROMPT]) {
    assert.doesNotMatch(prompt, /tesla|water|stairwell|high school|\bdad\b/i);
  }
});

test('a match on something the dream never mentions is dropped', () => {
  const entries = memoryEntries(MEMORY);
  const tesla = entryId(MEMORY, 'a black Tesla');
  // The quote is invented, the way the model writes "the black Tesla is back".
  assert.deepEqual(verifyMatches(answer([{ id: tesla, quote: 'the black Tesla', note: 'The black Tesla is back' }]), entries, NO_TESLA), []);
  // The quote is real, but it shows something else in the dream.
  assert.deepEqual(verifyMatches(answer([{ id: tesla, quote: 'at the grocery store with Mom', note: 'The black Tesla is back' }]), entries, NO_TESLA), []);
});

test('a quote taken from the list instead of the dream is replaced with the dream\'s own words', () => {
  const entries = memoryEntries(MEMORY);
  const dream = 'The car was locked. I walked into a greenhouse full of dead tomato plants. The door was wide open.';
  const [kept] = verifyMatches(answer([
    { id: entryId(MEMORY, 'a locked greenhouse'), quote: 'a locked greenhouse', note: 'The greenhouse is back, open this time' },
  ]), entries, dream);
  assert.equal(kept.quote, 'I walked into a greenhouse full of dead tomato plants');
  // A described thing may come back changed: no second look needed.
  assert.equal(kept.unsure, false);
});

test('a particular one named only in part goes to the second look', () => {
  const memory = `${MEMORY}\n- your childhood dog`;
  const dream = 'A big black dog followed me through a parking lot.';
  const [kept] = verifyMatches(answer([{ id: entryId(memory, 'your childhood dog'), quote: 'A big black dog followed me', note: 'Your childhood dog is back' }]), memoryEntries(memory), dream);
  assert.equal(kept.unsure, true);
  const [mom] = verifyMatches(answer([{ id: entryId(memory, 'Mom'), quote: 'my mother waved', note: 'Mom is back, waving this time' }]), memoryEntries(memory), 'Then my mother waved at me.');
  assert.equal(mom.unsure, false, 'every word of it is there');
});

test('a shared color or size is not the same thing', () => {
  assert.equal(namesTheThing('a black Tesla', 'a black dog ran past'), false);
  assert.equal(namesTheThing('a black Tesla', 'my black Tesla'), true);
  assert.equal(namesTheThing('Mom', 'my mother was there'), true);
  assert.equal(namesTheThing('water', 'the lake was frozen'), true);
  assert.equal(namesTheThing('a lake', 'there was water everywhere'), false);
});

test('a real match holds up, with a slip in the quote, and keeps its note', () => {
  const entries = memoryEntries(MEMORY);
  const kept = verifyMatches(answer([
    { id: entryId(MEMORY, 'a black Tesla'), quote: 'A black Tesla pulled up outside my apartment', note: 'The black Tesla is back, and this time no one gets out' },
    { id: entryId(MEMORY, 'water'), quote: 'stood there in the rain', note: 'Water again, falling on you instead of rising' },
  ]), entries, TESLA);
  assert.deepEqual(kept.map((k) => k.note), [
    'The black Tesla is back, and this time no one gets out',
    'Water again, falling on you instead of rising',
  ]);
});

test('a quote has to be the dream\'s own words, in order', () => {
  assert.equal(quoteFound('the water fountain was overflowing', NO_TESLA), true);
  assert.equal(quoteFound('the fountain overflowed', NO_TESLA), true, 'a change of tense is a slip');
  assert.equal(quoteFound('the fountain was dry', NO_TESLA), false);
  assert.equal(quoteFound('Mom and the overflowing fountain', NO_TESLA), false);
  assert.equal(quoteFound('the and was', NO_TESLA), false);
});

test('a second sighting is never called long-running', () => {
  const entries = memoryEntries(MEMORY);
  const [kept] = verifyMatches(answer([
    { id: entryId(MEMORY, 'a black Tesla'), quote: 'A black Tesla pulled up', note: 'The black Tesla keeps showing up for you' },
  ]), entries, TESLA);
  assert.equal(kept.note, 'The black Tesla is back, the second time it has shown up');
});

test('the memory rewrite can only raise or promote what the check found', () => {
  const rewrite = `## Recurring symbols
- water: ~4 times; rough recently
- black Tesla: ~2 times; status and arrival

## Recurring figures & people
- Mom: ~3 times; always just out of reach

## Seen once
- a locked greenhouse
- a grocery store`;
  const groundText = NO_TESLA;
  // The check found only Mom and water in this dream.
  const matchedKeys = new Set(['mom', 'water']);
  const out = reconcileMemory(rewrite, MEMORY, { matchedKeys, groundText });
  assert.match(out, /water: ~4 times/);
  assert.match(out, /Mom: ~3 times/);
  assert.doesNotMatch(out, /Tesla: ~2 times/);
  assert.match(out, /## Seen once[\s\S]*- black Tesla/);

  // Now the check found nothing: no count may go up.
  const none = reconcileMemory(rewrite, MEMORY, { matchedKeys: new Set(), groundText });
  assert.match(none, /water: ~3 times/);
  assert.match(none, /Mom: ~2 times/);
});

test('a rewrite that hands back only the log loses nothing', () => {
  const rewrite = `## Seen once
- a black Tesla
- a locked greenhouse
- driving an old Honda`;
  const out = reconcileMemory(rewrite, MEMORY, { matchedKeys: new Set(), groundText: 'I was driving my old Honda down a highway.' });
  assert.match(out, /## Recurring symbols\n- water: ~3 times; calm in early entries, rough recently/);
  assert.match(out, /## Recurring figures & people\n- Mom: ~2 times/);
  assert.match(out, /- driving an old Honda/);
  assert.ok(out.indexOf('## Recurring symbols') < out.indexOf('## Seen once'));
});

test('the check, not the model, says what goes up', () => {
  // The model leaves everything as it was, though the check found the Tesla and Mom.
  const out = reconcileMemory(MEMORY, MEMORY, { matchedKeys: new Set(['blacktesla', 'mom']), groundText: TESLA });
  assert.match(out, /## Recurring symbols\n- water: ~3 times[^\n]*\n- black Tesla: ~2 times/);
  assert.match(out, /- Mom: ~3 times/);
  assert.doesNotMatch(out.split('## Seen once')[1], /Tesla/);
});

test('a note about a pattern is not mistaken for the pattern', () => {
  const memory = `## Recurring symbols
- water: ~3 times; calm early

## Shifts over time
- water: calm in early entries, rough recently`;
  const out = reconcileMemory(memory, memory, { matchedKeys: new Set(), groundText: NO_TESLA });
  assert.match(out, /## Recurring symbols\n- water: ~3 times/);
  assert.doesNotMatch(out, /## Seen once/);
});

test('a new log entry the dream has no word for is dropped, a real one stays', () => {
  const rewrite = `## Recurring symbols
- water: ~3 times; calm in early entries, rough recently

## Seen once
- a black Tesla
- a locked greenhouse
- a flooded stairwell
- a grocery store
- an overflowing fountain`;
  const out = reconcileMemory(rewrite, MEMORY, { matchedKeys: new Set(), groundText: NO_TESLA });
  assert.match(out, /- a grocery store/);
  assert.match(out, /- an overflowing fountain/);
  assert.doesNotMatch(out, /stairwell/);
  // Already in the file before this dream, so not this dream's to prove.
  assert.match(out, /- a black Tesla/);
});

// A Supabase with one premium account, a memory file, and a fake OpenAI that
// answers each of the three calls the way it's told to.
const withFakes = (t, { memory = MEMORY, matchAnswer, sameAnswer = '{"answers":[]}', memoryAnswer = null } = {}) => {
  const state = { memory, prompts: [] };
  const admin = {
    auth: { getUser: async () => ({ data: { user: { id: SAM, email: 'sam@example.com' } }, error: null }) },
    rpc: async (name, args) => {
      if (name === 'check_and_increment_ai_quota') return { data: { allowed: true, tier: 'premium', remainingFree: 29, creditBalance: 0 }, error: null };
      if (name === 'get_dream_memory') return { data: state.memory, error: null };
      if (name === 'save_dream_memory') { state.memory = args.p_memory; return { data: null, error: null }; }
      return { data: null, error: { code: 'PGRST202', message: 'missing' } };
    },
    from: (table) => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { subscription: { tier: 'premium' } }, error: null }),
          eq: () => ({ maybeSingle: async () => ({ data: table === 'dreams' ? { memory_indexed: false } : null, error: null }) }),
        }),
      }),
    }),
  };
  t.mock.method(aiRoute.deps, 'getSupabaseAdmin', () => admin);
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    const system = body.messages[0].content;
    state.prompts.push({ system, user: body.messages[1].content, model: body.model });
    let content;
    if (system === MATCH_PROMPT) content = matchAnswer;
    else if (system === SAME_THING_PROMPT) content = sameAnswer;
    else if (system === MEMORY_PROMPT) content = memoryAnswer;
    else content = JSON.stringify({ title: 'Long Aisles', themes: 'A reading of this dream.', connections: ['The black Tesla is back'] });
    return { ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }) };
  });
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  t.after(() => { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved; });
  return state;
};

const analyze = async (dreamText, extra = {}) => {
  const res = {
    statusCode: 200,
    body: undefined,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
  await aiRoute({ method: 'POST', headers: {}, body: { dreamText, idToken: 'token-sam', promptStyle: 'balanced', ...extra } }, res);
  return res;
};

test('a dream with no Tesla gets no Tesla, whatever the models say', async (t) => {
  const state = withFakes(t, {
    matchAnswer: answer([{ id: entryId(MEMORY, 'a black Tesla'), quote: 'the black Tesla', note: 'The black Tesla is back' }]),
  });
  // A dream of its own text, so the route's cache from another test can't answer.
  const res = await analyze(`${NO_TESLA} Then I woke up.`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.connections, []);
  const reading = state.prompts.find((p) => p.system !== MATCH_PROMPT);
  assert.doesNotMatch(reading.system, /tesla/i, 'the reading never sees the memory file');
});

test('a dream with the Tesla in it says so, and the reading is told', async (t) => {
  const state = withFakes(t, {
    matchAnswer: answer([{ id: entryId(MEMORY, 'a black Tesla'), quote: 'A black Tesla pulled up outside my old apartment', note: 'The black Tesla is back, parked outside your old place' }]),
  });
  const res = await analyze(TESLA);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.connections, ['The black Tesla is back, parked outside your old place']);
  const reading = state.prompts.find((p) => p.system !== MATCH_PROMPT);
  assert.match(reading.system, /a black Tesla \(seen once before\)\. In this dream: "A black Tesla pulled up outside my old apartment"/);
  assert.doesNotMatch(reading.system, /greenhouse/, 'only what matched');
});

test('each style is written by the model it was picked for, and the check stays on the small one', async (t) => {
  const state = withFakes(t, { matchAnswer: answer([]) });
  const readingModel = async (style) => {
    state.prompts.length = 0;
    const res = await analyze(`${NO_TESLA} Read as ${style}.`, { promptStyle: style });
    assert.equal(res.statusCode, 200);
    assert.equal(state.prompts.find((p) => p.system === MATCH_PROMPT).model, 'gpt-4o-mini');
    return state.prompts.find((p) => p.system !== MATCH_PROMPT).model;
  };
  for (const style of ['balanced', 'coach', 'therapist', 'scientist', 'creative', 'director', 'astrology']) {
    assert.equal(await readingModel(style), 'gpt-4.1-mini', style);
  }
  for (const style of ['comedian', 'mystical']) {
    assert.equal(await readingModel(style), 'gpt-4o-mini', style);
  }
});

test('a dog is only your childhood dog when a second look says it is the same one', async (t) => {
  const memory = `${MEMORY}\n- your childhood dog`;
  const dog = entryId(memory, 'your childhood dog');
  const matchAnswer = answer([{ id: dog, quote: 'A big black dog followed me', note: 'Your childhood dog is back' }]);
  const dream = 'A big black dog followed me through a parking lot until I reached a gate.';

  const no = withFakes(t, { memory, matchAnswer, sameAnswer: JSON.stringify({ answers: [{ id: dog, same: false }] }) });
  const first = await analyze(dream);
  assert.deepEqual(first.body.connections, []);
  assert.ok(no.prompts.some((p) => p.system === SAME_THING_PROMPT && p.user.includes('your childhood dog')));

  t.mock.restoreAll();
  withFakes(t, { memory, matchAnswer, sameAnswer: JSON.stringify({ answers: [{ id: dog, same: true }] }) });
  const second = await analyze(`${dream} It was Buster.`);
  assert.deepEqual(second.body.connections, ['Your childhood dog is back']);
});

test('the memory update tells the model what the check found, and holds it to that', async (t) => {
  const state = withFakes(t, {
    // The model promotes the Tesla even though the check found nothing.
    memoryAnswer: `## Recurring symbols
- water: ~4 times; rough recently
- black Tesla: ~2 times; status and arrival

## Recurring figures & people
- Mom: ~2 times; always just out of reach

## Seen once
- a locked greenhouse
- a grocery store`,
  });
  const stored = await updateDreamMemory(SAM, NO_TESLA, 'Long Aisles', 'A reading.', 'test-key', []);
  assert.equal(stored, true);
  const sent = state.prompts.find((p) => p.system === MEMORY_PROMPT).user;
  assert.match(sent, /nothing already in the file appears in it again/);
  assert.match(state.memory, /water: ~3 times/);
  assert.doesNotMatch(state.memory, /Tesla: ~2 times/);
  assert.match(state.memory, /## Seen once[\s\S]*- black Tesla/);
});
