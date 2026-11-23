// Runs made-up dreams through the real analysis route and the real OpenAI
// model, against a fake database, and checks the pattern recognition a person
// would see. Run it after changing any prompt or check in api/ai.js:
//
//   node scripts/dream-patterns-check.cjs
//
// It needs OPENAI_API_KEY in .env or .env.local, and it costs a few cents.
// Nothing but OpenAI is called, and every dream and memory entry is made up.
const path = require('node:path');
const root = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env.local'), quiet: true });
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
const ai = require(path.join(root, 'api/ai.js'));

const MEMORY = `## Recurring symbols
- water: ~4 times; calm lakes in early entries, flooding and rising recently
- elevators: ~3 times; always stalling between floors

## Recurring figures & people
- Mom: ~3 times; always in another room, just out of reach
- Todd (your old manager): ~2 times; watching you work, never speaking

## Emotional patterns
- running late: ~4 times; panic that builds as the dream goes on

## Seen once
- a black Tesla
- a locked greenhouse
- your childhood dog
- a phone with no signal`;

// What each dream should and should not be linked to. A pattern line has to
// mention every word in `want` and none of the words in `never`.
const CASES = [
  { dream: 'I was driving my old Honda down a highway at night and the exits kept disappearing before I could take them.', want: [], never: ['tesla'] },
  { dream: 'A black Tesla pulled into my driveway and just sat there with its lights on. Nobody was inside, but the seat was warm.', want: ['tesla'] },
  { dream: 'I was riding in the back of a white Tesla and the driver would not tell me where we were going.', want: ['tesla'] },
  { dream: 'My mother was standing in the kitchen of the house I grew up in, but the floor was covered in water up to my ankles.', want: ['water', 'mom'] },
  { dream: 'I was trying to get to a meeting on the 40th floor and the elevator stopped at every single floor. I was so late my heart was pounding.', want: ['elevator', 'late'] },
  { dream: 'A big black dog followed me through a parking lot. It just walked next to me until I reached a gate.', want: [], never: ['dog', 'tesla'] },
  { dream: 'Max, the dog I had when I was a kid, was running around my apartment like he never left.', want: ['dog'] },
  { dream: 'My manager Sarah was yelling at me in a conference room about a report I never wrote.', want: [], never: ['todd', 'manager'] },
  { dream: 'I walked into a greenhouse full of dead tomato plants. The door was wide open and wind was blowing through.', want: ['greenhouse'] },
  { dream: 'I was on a boat made of paper crossing a desert, and Emily from work was steering it with a spoon.', want: [] },
];

const admin = (state) => ({
  auth: { getUser: async () => ({ data: { user: { id: 'dana', email: 'dana@example.com' } }, error: null }) },
  rpc: async (name, args) => {
    if (name === 'check_and_increment_ai_quota') return { data: { allowed: true, tier: 'premium', remainingFree: 29, creditBalance: 0 }, error: null };
    if (name === 'get_dream_memory') return { data: state.memory, error: null };
    if (name === 'save_dream_memory') { state.memory = args.p_memory; return { data: null, error: null }; }
    return { data: null, error: { code: 'PGRST202', message: 'missing' } };
  },
  from: () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { subscription: { tier: 'premium' } }, error: null }),
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }),
  }),
});

const analyze = async (dreamText, state) => {
  ai.deps.getSupabaseAdmin = () => admin(state);
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } };
  await ai({ method: 'POST', headers: {}, body: { dreamText, idToken: 'token', promptStyle: 'balanced' } }, res);
  return res;
};

(async () => {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Put OPENAI_API_KEY in .env or .env.local first.');
    process.exit(1);
  }
  let failed = 0;
  for (const { dream, want, never = [] } of CASES) {
    const res = await analyze(dream, { memory: MEMORY });
    const lines = res.body?.connections || [];
    const text = lines.join(' | ').toLowerCase();
    const problems = [];
    if (res.code && res.code !== 200) problems.push(`HTTP ${res.code}: ${res.body?.error}`);
    for (const word of want) if (!text.includes(word)) problems.push(`missing "${word}"`);
    for (const word of never) if (text.includes(word)) problems.push(`should not say "${word}"`);
    if (!want.length && lines.length) problems.push('expected no links');
    if (problems.length) failed += 1;
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${dream.slice(0, 60)}...\n     ${JSON.stringify(lines)}${problems.length ? `\n     ${problems.join('; ')}` : ''}`);
  }

  // Three dreams merged into the memory in a row: what came back is counted
  // once, nothing else moves, and nothing is lost.
  const state = { memory: MEMORY };
  ai.deps.getSupabaseAdmin = () => admin(state);
  for (const dream of [CASES[0].dream, CASES[1].dream, CASES[3].dream]) {
    await ai.internals.updateDreamMemory('dana', dream, 'A Title', 'A short reading of this dream.', process.env.OPENAI_API_KEY, null);
  }
  const memoryProblems = [
    [/water: ~5 times/, 'water at 5'], [/Mom: ~4 times/, 'Mom at 4'], [/black Tesla: ~2 times/, 'the Tesla at 2'],
    [/elevators: ~3 times/, 'elevators kept at 3'], [/Todd[^\n]*~2 times/, 'Todd kept at 2'], [/running late: ~4 times/, 'running late kept at 4'],
  ].filter(([pattern]) => !pattern.test(state.memory)).map(([, label]) => label);
  if (memoryProblems.length) failed += 1;
  console.log(`${memoryProblems.length ? 'FAIL' : 'ok  '} memory after three dreams${memoryProblems.length ? `: expected ${memoryProblems.join(', ')}` : ''}`);
  if (memoryProblems.length || process.argv.includes('--show')) console.log(state.memory);

  console.log(failed ? `\n${failed} of ${CASES.length + 1} checks failed.` : `\nAll ${CASES.length + 1} checks passed.`);
  process.exit(failed ? 1 : 0);
})();
