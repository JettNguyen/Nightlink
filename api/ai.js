const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const Astronomy = require('astronomy-engine');
const billing = require('./_lib/billing');

// Vercel is free to freeze the instance the moment the response is sent, which
// killed the dream memory update mid-flight most of the time, because it starts a
// second OpenAI call that takes longer than the response it trails. waitUntil
// keeps the instance alive until that work lands. Absent locally, where the
// express dev server stays up on its own.
let vercelWaitUntil = null;
try { ({ waitUntil: vercelWaitUntil } = require('@vercel/functions')); }
catch { /* not on Vercel */ }

const deferWork = (promise) => {
  if (!vercelWaitUntil) return;
  try { vercelWaitUntil(promise); } catch { /* outside a request context */ }
};

const cache = new Map();
const MAX_LEN = 5000;
// Same as MAX_PROMPT_LENGTH in src/pages/Settings.jsx.
const MAX_CUSTOM_PROMPT = 400;
// The analysis is what the user is waiting on, so it gets a tight ceiling. The
// memory rewrite runs after the response and can take the rest of the budget.
const ANALYSIS_TIMEOUT_MS = 25_000;
const MEMORY_TIMEOUT_MS = 40_000;
// The match check, its second look, and the memory rewrite. These are yes or no
// and bookkeeping jobs, tested on this model.
const MODEL = 'gpt-4o-mini';
// The model that writes each style's reading. Compared on 11/23/2026 over 108
// readings: gpt-4.1-mini did each style's one job every time where gpt-4o-mini
// missed 6 of 48, and walked the dream image by image about half as often. Two
// styles stay on gpt-4o-mini because the newer model was worse at them in both
// rounds: as the comedian it explains why a dream is funny instead of telling a
// joke, and as the mystic it stacks four to six archetypes into every reading.
// Custom prompts go to gpt-4.1-mini, which follows written instructions better.
const READING_MODEL = 'gpt-4.1-mini';
const STYLES_ON_CHECK_MODEL = new Set(['comedian', 'mystical']);
const readingModelFor = (style) => (STYLES_ON_CHECK_MODEL.has(style) ? MODEL : READING_MODEL);
const API_URL = 'https://api.openai.com/v1/chat/completions';
const PROMPT_ID_ALIASES = { investigator: 'director' };
const FREE_ALLOWED_PROMPT_STYLES = new Set(['balanced', 'coach', 'therapist']);
// For an 18+ app we only block content that Apple explicitly prohibits:
// CSAM, content that promotes or glorifies real-world violence/terrorism,
// self-harm encouragement, and content that sexualises minors.
// General adult themes, mild profanity, and dream-context violence are allowed.
const TEEN_UNSAFE_PATTERNS = [
  /\bkill yourself\b/i,
  /\bkys\b/i,
  /\bself[-\s]?harm\b/i,
  /\bcut(?:ting)? myself\b/i,
  /\bsuicide\s+(method|how|guide|plan)\b/i,
  /\bchild porn\b/i,
  /\bc\.s\.a\.m\b/i,
  /\bcsam\b/i,
  /\bunderage\s+sex\b/i,
  /\bchild\s+(?:sexual|sex)\b/i,
  /\bminor\s+(?:sexual|sex|nude|naked)\b/i,
  /\bterroris(?:t|m)\s+(?:attack|manifesto|recruit)\b/i,
  /\bwhite\s+supremac(?:y|ist)\b/i,
  /\bgenocide\s+(?:is\s+)?(?:good|great|right|justified)\b/i,
];

const SAFE_AI_TITLE_FALLBACK = 'Reflective Dream';
const SAFE_AI_THEMES_FALLBACK = 'Some details were removed from this analysis as they fall outside what the AI can discuss. Use this as a general reflection only. AI output may be inaccurate and is not medical, mental health, legal, or safety advice.';

// The one thing each voice has to actually do. This rides in the "themes" field
// contract rather than in the persona, because a requirement stated next to the
// field is followed and the same sentence inside the persona was not: balanced
// kept dropping both its question and its action.
const STYLE_REQUIREMENT = {
  balanced:  'Two symbols at most, but go deep on those two, then one reflection question with a question mark in it, then one small thing to try today.',
  coach:     'End on the one thing to do tonight.',
  therapist: 'Open on the feeling, not on a symbol.',
  scientist: 'Name at least two brain systems or REM mechanisms outright, each tied to a detail of this dream. Writing around them in plain psychology language is the one way to get this wrong.',
  mystical:  'Name the archetypes you find by their names.',
  creative:  'End on the writing prompt.',
  director:  'Write it in the vocabulary of production: the shot, the lens, the palette, the cut, the score. It is a pitch, so no psychological reading of the dreamer.',
  comedian:  'Land one actual joke. Describing what would be funny about the dream is not the same thing.',
  astrology: 'Name at least two placements from the sky block outright.',
};
const DEFAULT_STYLE_REQUIREMENT = STYLE_REQUIREMENT.balanced;

// The persona goes first and the contract second, on purpose. With the app
// identity and the JSON rules on top, gpt-4o-mini locked onto "dream analysis
// assistant" and answered every style in the same "this dream may suggest"
// voice, with the assigned lens showing up as nothing but word choice.
const buildOutputRules = (lengthRule, requirement) => `You are writing for NightLink, an 18+ dream journaling app. Hold the voice above from the first sentence to the last: a reading that could have come from any other reader on this app is a failed reading.

Return ONLY minified JSON: {"title":"string","themes":"string"}

- "title": a poetic, evocative 2 to 4 word phrase that names this specific dream (never generic)
- "themes": ${lengthRule}, written as one flowing paragraph of plain text. The app shows it as a single paragraph, so no markdown, no headings, no bullets, no line breaks. ${requirement}
- Read this dream only. Never say something is back, keeps happening, or has come up in your earlier dreams unless the dream itself says so or a block below lists it
- Never open with "This dream may suggest" or a variant of it, and never walk the dream image by image handing each one a meaning. Work the details your lens actually cares about
- Anchor what you say to something the dreamer described. A reading that would fit any dream is a failed reading
- The dreamer reads this, so write to them as "you". Never call them "the dreamer" or write about them in the third person
- No em dashes and no en dashes. Use a comma, a colon, or a new sentence
- Keep claims about the dreamer's inner life speculative ("may suggest", "could reflect"). Never hedge your own craft: a shot, a joke, a story premise, or a named brain system is stated plainly, not qualified into mush
- Engage thoughtfully with mature content as it naturally appears in dreams; never encourage self-harm or glorify real-world violence
- If the dream touches on self-harm or suicidal themes, respond with warm, grounded support`;

// Per-style persona and interpretive methodology, with no format instructions here.
const STYLE_DELTAS = {
  balanced:
    "You are a thoughtful, grounded dream interpreter. No mysticism, no jargon, just honest insight. Go deep on the symbols that actually carry the dream and what they may reveal about where the dreamer is right now, rather than cataloguing every image. The question you ask should be one that could genuinely unlock something, and the thing you suggest should be small enough to do today. Warm, clear, never condescending.",

  coach:
    "You are a performance and recovery coach who specializes in sleep quality and stress physiology. Scan this dream for signals of cognitive overload, unresolved pressure, or avoidance patterns, and name what you find specifically. Explain what the nervous system may be processing during this REM content. Deliver one targeted, practical suggestion the dreamer can implement tonight to reduce whatever stress this dream is mirroring. Supportive and direct, zero fluff.",

  therapist:
    "You are an attachment-informed, trauma-aware therapist. Your first move is always emotional validation. Name what this dream likely felt like in the body without assuming the worst. Gently surface the core emotional need or fear the imagery may be expressing. Offer one grounding reframe or hopeful perspective rooted in the specific imagery, not platitudes. Close with a brief, compassionate observation about what this dream may be asking the dreamer to hold more gently. Soft, precise, never clinical.",

  scientist:
    "You are a cognitive neuroscientist specializing in sleep and memory. Explain which brain systems were likely active during this specific dream content, whether that is the default mode network, limbic circuits, prefrontal suppression, memory consolidation, or emotional regulation, and why this particular scenario emerged. Connect it to documented REM mechanisms: threat simulation, emotional memory replay, predictive modeling, or social cognition processing. Smart and specific, grounded in real neuroscience, but readable, not a journal abstract.",

  mystical:
    "You are a depth-psychology-informed mystic fluent in Jungian archetypes, cross-cultural mythology, and universal symbol systems. Identify which archetypal figures or threshold symbols are actually present, whether shadow, anima/animus, trickster, death-rebirth, the void, or the guide, and speak to what the psyche is negotiating at a soul level. Name only the ones the imagery earns. Use language that honors the numinous without being vague. End with a single oracular sentence that names the deeper invitation this dream is extending. Poetic, precise, spiritually grounded.",

  creative:
    "You are a working fiction writer and story architect. Identify the latent narrative structure in this dream: the inciting wound, the archetypal character roles, the genre this world belongs to. Surface the story this dream is already telling and show the dreamer how it could become something real: a first scene, a character study, a world with its own rules. Give one sharp, specific writing prompt pulled directly from the dream's most vivid or strange detail. Energizing, craft-focused, never generic.",

  director:
    "You are an auteur film director with a singular visual grammar. Write the pitch: open with the exact establishing shot, name the cinematographic style and emotional register, describe one pivotal image with sensory specificity, and state the thematic question this film would pose. This is a treatment, not a summary, so make bold aesthetic choices. Visually precise, tonally committed, occasionally unhinged in the best way.",

  comedian:
    "You are a sharp observational comedian who finds the genuine absurdity in how the subconscious works. Identify the most surreal, contradictory, or structurally ridiculous element of this dream and land a joke on it, the kind of humor that makes someone feel seen, not mocked. Still acknowledge the real emotional texture underneath; the best dream comedy is always at least a little true. Funny in a way that lands: warm, specific, never punching down.",

  astrology:
    "You are a practicing astrologer who reads dreams through the lens of the sky. Use the planetary positions in the sky context block, meaning the moon phase and sign, the sun, and the visible planets, as your source material. Don't work through each planet in sequence; instead, let the sky tell a coherent story. Lead with what feels most alive in the chart that night and connect it to what's most alive in the dream. Name specific planets and signs when they illuminate something, skip them when they don't. End with a brief, grounded sense of what this sky was asking of the dreamer, not a directive, just an honest read. Precise where the chart is interesting, quiet where it isn't."
};

// Per-style temperature: higher for expressive/generative styles, lower for analytical ones.
const STYLE_TEMPERATURE = {
  balanced:  0.70,
  coach:     0.60,
  therapist: 0.60,
  scientist: 0.50,
  mystical:  0.85,
  creative:  0.88,
  director:  0.90,
  comedian:  0.85,
  astrology: 0.75,
};

// How long each voice runs. Asking for a word count is what actually sets the
// length; MAX_TOKENS is only a ceiling, kept well clear of the longest target so
// a style is never cut off mid-JSON.
//
// The story and the film treatment ask for less than they want. gpt-4.1-mini
// writes past the top of those two: asked for 150 to 200 words, the story came
// back at 207 to 224 in 5 of 6 tries, and the treatment past 160 in 3 of 6. With
// the lower ask the story landed in 150 to 200 in 8 of 9 tries and the treatment
// in 120 to 160 in 6 of 6.
const STYLE_LENGTH = {
  balanced:  '130 to 170 words',
  coach:     '140 to 180 words',
  therapist: '140 to 180 words',
  scientist: '150 to 200 words',
  mystical:  '140 to 180 words',
  creative:  '120 to 160 words',
  director:  '110 to 145 words',
  comedian:  '100 to 140 words',
  astrology: '150 to 200 words',
};
const DEFAULT_STYLE_LENGTH = '150 to 190 words';  // custom prompts, which have no beat structure to fit
const MAX_TOKENS = 600;

// Keep PROMPT_TEMPLATES as an alias so the custom-style path and any callers still work.
const PROMPT_TEMPLATES = STYLE_DELTAS;

const ZODIAC_SIGNS = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo','Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
const eclipticToSign = (lon) => ZODIAC_SIGNS[Math.floor((((lon % 360) + 360) % 360) / 30)];
const moonPhaseName = (phase) => {
  if (phase < 45)  return 'new moon';
  if (phase < 90)  return 'waxing crescent';
  if (phase < 135) return 'first quarter';
  if (phase < 180) return 'waxing gibbous';
  if (phase < 225) return 'full moon';
  if (phase < 270) return 'waning gibbous';
  if (phase < 315) return 'last quarter';
  return 'waning crescent';
};

const buildAstrologyContext = (dateStr) => {
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return '';
    const phase    = Astronomy.MoonPhase(date);
    const sun      = Astronomy.SunPosition(date);
    const moonLon  = (sun.elon + phase) % 360;
    const illum    = Math.round((1 - Math.cos(phase * Math.PI / 180)) / 2 * 100);
    const moonSign = eclipticToSign(moonLon);
    const sunSign  = eclipticToSign(sun.elon);
    const phaseName = moonPhaseName(phase);
    const planetSigns = ['Mercury','Venus','Mars','Jupiter','Saturn'].map((body) => {
      try {
        const ecl = Astronomy.Ecliptic(Astronomy.GeoVector(body, date, true));
        return `${body} in ${eclipticToSign(ecl.elon)}`;
      } catch { return null; }
    }).filter(Boolean);
    const label = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    return `[Sky context for ${label}: Moon in ${moonSign} (${phaseName}, ${illum}% illuminated), Sun in ${sunSign}. ${planetSigns.join(', ')}.]`;
  } catch {
    return '';
  }
};

const setCors = (res, origin) => {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
};

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const currentMonthYear = () => new Date().toISOString().slice(0, 7);
const normalizePromptStyle = (style) => PROMPT_ID_ALIASES[style] || style || 'balanced';
const containsTeenUnsafeText = (text = '') => {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  return TEEN_UNSAFE_PATTERNS.some((pattern) => pattern.test(normalized));
};
const isPromptStyleLockedForTier = (tier, style) => (
  tier !== 'premium' && !FREE_ALLOWED_PROMPT_STYLES.has(normalizePromptStyle(style))
);

const createSupabaseAdmin = () => createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Tests swap this, so nothing reaches Supabase.
const deps = { getSupabaseAdmin: createSupabaseAdmin };
const getSupabaseAdmin = () => deps.getSupabaseAdmin();

// Verify user token and return the user it belongs to
const verifyToken = async (token) => {
  const admin = getSupabaseAdmin();
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) throw new Error('Invalid or expired session.');
  return user;
};

// Atomically check and increment AI quota via Postgres function
const checkAndIncrementQuota = async (uid) => {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.rpc('check_and_increment_ai_quota', {
    p_user_id:    uid,
    p_month_year: currentMonthYear(),
    p_free_limit: 1
  });
  if (error) throw error;
  return data;
};

const checkAndIncrementQuotaFallback = async (uid, tier) => {
  const admin = getSupabaseAdmin();
  const { data: profile, error } = await admin
    .from('profiles')
    .select('ai_usage')
    .eq('id', uid)
    .single();

  // If the column doesn't exist or profile is missing, treat as a fresh user
  // rather than hard-failing. A schema gap shouldn't block all AI usage.
  if (error) {
    console.error('Fallback quota load failed (treating as new user):', error.message);
  }

  const usage = (error ? null : profile?.ai_usage) || {};
  const monthYear = currentMonthYear();
  const storedMonth = typeof usage.monthYear === 'string' ? usage.monthYear : '';
  const isNewMonth = storedMonth !== monthYear;
  const monthlyCount = isNewMonth ? 0 : Number(usage.monthlyCount || 0);
  const creditBalance = Number(usage.creditBalance || 0);
  const limit = tier === 'premium' ? 30 : 1;

  let allowed = false;
  let usedCredit = false;
  let nextMonthlyCount = monthlyCount;
  let nextCreditBalance = creditBalance;

  if (monthlyCount < limit) {
    allowed = true;
    nextMonthlyCount = monthlyCount + 1;
  } else if (creditBalance > 0) {
    allowed = true;
    usedCredit = true;
    nextCreditBalance = creditBalance - 1;
  }

  if (!allowed) {
    return {
      allowed: false,
      tier,
      remainingFree: 0,
      creditBalance: Math.max(0, creditBalance)
    };
  }

  const nextUsage = {
    ...usage,
    monthYear,
    monthlyCount: nextMonthlyCount,
    creditBalance: Math.max(0, nextCreditBalance)
  };

  const { error: updateError } = await admin
    .from('profiles')
    .update({ ai_usage: nextUsage })
    .eq('id', uid);

  if (updateError) {
    // Log but don't hard-fail, because if ai_usage column is missing the request still goes through
    console.error('Fallback quota update failed:', updateError.message);
  }

  return {
    allowed: true,
    usedCredit,
    tier,
    remainingFree: Math.max(0, limit - nextMonthlyCount),
    creditBalance: Math.max(0, nextCreditBalance)
  };
};

// The plan's tier, or premium for the comp list (see billing.isComped).
const getUserTier = async (user) => {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('profiles')
    .select('subscription')
    .eq('id', user.id)
    .single();
  if (error) {
    throw new Error(`Could not load subscription: ${error.message}`);
  }
  if (data?.subscription?.tier === 'premium') return 'premium';
  return billing.isComped(user) ? 'premium' : 'free';
};

// Reverse a quota increment when the AI call fails, so there is no charge on error
const refundQuota = async (uid, usedCredit) => {
  try {
    const admin = getSupabaseAdmin();
    const { data: profile } = await admin
      .from('profiles')
      .select('ai_usage')
      .eq('id', uid)
      .single();
    if (!profile?.ai_usage) return;
    const usage = profile.ai_usage;
    if (usage.monthYear !== currentMonthYear()) return; // stale month, nothing to undo
    const updated = usedCredit
      ? { ...usage, creditBalance: Number(usage.creditBalance || 0) + 1 }
      : { ...usage, monthlyCount: Math.max(0, Number(usage.monthlyCount || 0) - 1) };
    await admin.from('profiles').update({ ai_usage: updated }).eq('id', uid);
  } catch (e) {
    console.error('Quota refund failed:', e.message);
  }
};

// Read the user's persistent dream memory file. Step 2 of the profile privacy
// rollout moves it where only the server reads it, behind these functions;
// before step 1 they don't exist yet and the column is read directly.
const getDreamMemory = async (uid) => {
  const admin = getSupabaseAdmin();
  const { data: memory, error } = await admin.rpc('get_dream_memory', { p_user_id: uid });
  if (!error) return memory || null;
  if (!billing.isMissingFunction(error)) throw new Error(error.message);
  const { data } = await admin
    .from('profiles')
    .select('dream_memory')
    .eq('id', uid)
    .single();
  return data?.dream_memory || null;
};

// Returns the error message when the write failed, or null.
const saveDreamMemory = async (uid, memory) => {
  const admin = getSupabaseAdmin();
  const { error } = await admin.rpc('save_dream_memory', { p_user_id: uid, p_memory: memory });
  if (!error) return null;
  if (!billing.isMissingFunction(error)) return error.message;
  const { error: updateError } = await admin.from('profiles').update({
    dream_memory: memory,
    dream_memory_updated_at: new Date().toISOString(),
  }).eq('id', uid);
  return updateError ? updateError.message : null;
};

// Has this dream already contributed to the memory file? Read it rather than
// trusting the client's `isMemoryIndexed`, which the caller could set either way
// to suppress indexing or pay for it twice. Scoped by owner so a borrowed dream
// id can't touch someone else's row.
// True or false for a dream of ours, null for one that is missing or not ours.
const readMemoryIndexed = async (uid, dreamId) => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('dreams')
    .select('memory_indexed')
    .eq('id', dreamId)
    .eq('user_id', uid)
    .maybeSingle();
  return data ? !!data.memory_indexed : null;
};
// Missing or not ours: treat as indexed so nothing is written.
const isDreamMemoryIndexed = async (uid, dreamId) => (await readMemoryIndexed(uid, dreamId)) ?? true;

// Rewrites the memory file after each analysis. Lives here with the other
// prompts rather than inside the function that sends it.
const MEMORY_PROMPT = `You maintain a private dream memory file for one dreamer, written for that dreamer to read. After each analyzed dream, update the file.

You have two jobs and the order matters. First, log what this dream held, so a later dream can be matched against it. Second, promote anything that has now happened more than once into a pattern. A detail from a single dream is not a pattern, however striking it was.

Your value is in noticing what the dreamer cannot see from inside a single night: how a symbol changes over time, which figure keeps returning, what pairs with what, and what has quietly stopped appearing. None of that is visible until something happens twice.

Use only the headings that have content (omit empty ones):
## Recurring symbols
## Recurring figures & people
## Emotional patterns
## Life themes (inferred)
## Notable narratives
## Shifts over time
## Open threads
## Seen once

The file has two parts and nothing appears in both:
- "Seen once" is the log. One line for each thing that has turned up in exactly one dream, written as a bare noun phrase of a few words that names the thing the way the dream had it, and nothing else. No meaning, no reading, no count
- Every section above "Seen once" is for patterns, and a pattern is something that has turned up in two or more separate dreams. Every line there carries its count, and that count is never 1

Working a new dream into the file:
- Log what is new in this dream: one line in "Seen once" for each main thing it has that the file doesn't, its objects, places, people and feelings, usually two to five lines. Log only what this dream actually contains, never something it does not mention
- Something you have no record of: add one line to "Seen once" and nothing anywhere else. Writing it above "Seen once" with a count of 1 is always wrong, however striking it was
- Something already sitting under "Seen once" that the checked list says is in this dream: this is its second appearance. Take it out of "Seen once", put it in the section where it belongs as "2 times", and only now say what it may mean
- Something already recorded as a pattern that the checked list says is in this dream: raise its count and sharpen the reading
- Everything already in the file that the checked list does not name keeps the count it has. Copy it into the new file as it is
- Keep each entry's name, the part before the colon, exactly as the file already has it, so later dreams can be matched against it
- Moods, themes and narratives work the same way. One dream's feeling is not an emotional pattern
- An entry above "Seen once" carrying a count of 1, or no count at all, came from an older version of this file. Move it down to "Seen once" and strip its reading
- Keep "Seen once" to about 25 entries. When it overflows, drop the oldest

Rules:
- Keep total length under 900 words
- Use concise note-style writing, not full prose sentences
- Every entry above "Seen once" carries its count, written as "<name>: ~<count> times"
- Note the direction a pattern is moving, not just that it exists, written as "<name>: ~<count> times; <how it was in early entries>, <how it is recently>"
- Record pairings that keep co-occurring, written as "<one thing> appears with <another> in most entries"
- Under "Shifts over time", record changes worth telling the dreamer about: a symbol that has inverted, an emotion that has cooled, a recurring figure that has stopped appearing
- Under "Open threads", record what keeps arriving unresolved across dreams: something that keeps breaking off before it ends
- Relative sequencing only ("early entries", "recently", "the last few"), never dates, months, or dream IDs
- Merge new information into existing entries, never duplicate
- Add new entries only when genuinely novel, and never duplicate an item between "Seen once" and a section above it
- Never drop an entry that has occurred 3 or more times; consolidate wording instead
- When nearing the length limit, trim "Seen once" first, oldest entries going first
- Never include raw dream text, only synthesized patterns and observations
- The dreamer reads this file, so write it to them. Never refer to them in the third person and never call them "the user", "the dreamer", or by name
- Every entry is already about them, so a possessive is redundant: write "<figure>: <what it may stand for>", not "User's <figure>: ...". Where a reference is genuinely unavoidable, use "you" or "your"
- Apply that to entries already in the file: when merging, rewrite any third-person reference you find into this voice
- Never speculate about diagnoses, medical conditions, or the dreamer's safety

Last pass before you answer: read every line above "Seen once". Any of them that does not stand on two or more dreams belongs under "Seen once" instead, as a bare noun phrase.

Return ONLY the whole updated memory file: every section and every entry, whether or not it changed. No preamble or explanation.`;

// Sections where a line is a claim that something recurs, so a line there has
// to prove it. "Shifts over time" and "Open threads" are prose notes with no
// counts to check, and are left alone.
const COUNTED_SECTIONS = new Set([
  'Recurring symbols',
  'Recurring figures & people',
  'Emotional patterns',
  'Life themes (inferred)',
  'Notable narratives',
]);
const SEEN_ONCE = 'Seen once';
const NOTE_SECTIONS = new Set(['Shifts over time', 'Open threads']);

const entryCount = (line) => {
  const m = line.match(/~?\s*(\d+)\s*time/i);
  return m ? parseInt(m[1], 10) : null;
};

// "black Tesla: ~2 times; power and status" -> "black Tesla". A thing logged
// once is a bare noun phrase, because the reading has not been earned yet.
const stripBullet = (line) => line.trim().replace(/^[-•*]\s*/, '');
const toBarePhrase = (line) => stripBullet(line).split(':')[0].replace(/\s*\(.*?\)\s*$/, '').trim();
// Matches "your mom" to "mom" and "a black Tesla" to "black Tesla", so a
// rewording between rewrites is not read as a different thing.
const normalizePhrase = (phrase) => phrase.toLowerCase().replace(/^(?:a|an|the|your|my)\s+/, '').replace(/[^a-z0-9]/g, '');

const parseSections = (file) => {
  const sections = [];
  let current = null;
  for (const line of (file || '').split('\n')) {
    if (line.startsWith('## ')) {
      current = { heading: line.slice(3).trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      // Anything before the first heading stays where it is.
      sections.push({ heading: null, lines: [line] });
    }
  }
  return sections;
};

// Word checks, used to hold the model to what a dream actually says. They are
// deliberately crude: each one only has to tell a real match from an invented
// one, and a model that has to get past a check on top of its instructions is
// wrong far less often than one that only has the instructions.
const stem = (word) => {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (/(?:ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
};
const stemSet = (words) => new Set(words.split(' ').map(stem));

// Words that say nothing about which thing a line is about.
const FILLER = new Set((
  'a an the and or but nor of to in on at by for with from into onto over under about after before '
  + 'then than that this these those there here was were is are be been being am do did does had has have '
  + 'i me my mine you your yours we our us they them their he him his she her hers it its as so if not no '
  + 'up down out off away very just like some any all one thing things something someone somebody anything '
  + 'everything place time times dream dreams dreamed dreamt feeling feelings felt sense kind sort way lot '
  + 'back again still also really much many more most other same new old seen once'
).split(' '));

// A color or a size says what a thing looks like, not what it is: a black dog
// is not a black Tesla.
const MODIFIERS = stemSet(
  'black white red blue green yellow purple pink orange brown gray grey silver gold golden dark bright light '
  + 'big small little large huge tiny giant tall short long young strange weird empty broken scary creepy different'
);

// Different words for the same thing, so a match doesn't hinge on which one the
// dream used. A word for a kind of thing is not here as a match for a particular
// one: "car" does not stand in for a black Tesla.
const SAME_THING = [
  'mom mother mum mommy mama', 'dad father daddy papa', 'grandma grandmother granny nana',
  'grandpa grandfather granddad', 'kid child children', 'partner boyfriend girlfriend husband wife spouse',
  'boss manager supervisor', 'teacher professor', 'dog puppy', 'cat kitten', 'house home',
  'school classroom', 'ocean sea', 'teeth tooth', 'fall fell', 'fly flew', 'die died dead death',
  'phone cellphone', 'exam test', 'plane airplane', 'stair staircase stairwell',
  'fear afraid scared terrified frightened dread panic', 'anxious anxiety nervous worried',
  'sad sadness cry cried crying tears grief', 'angry anger furious rage',
].map(stemSet);
// The other direction only: a dream's lake is water, but its water is not a lake.
const BROADER = {
  water: stemSet('ocean sea lake river pool flood wave rain underwater'),
  car: stemSet('tesla truck van suv jeep sedan'),
};

const wordsOf = (text) => String(text || '').toLowerCase()
  // Accents come off first, so a word with an accented letter stays one word.
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/'s\b/g, '')
  .replace(/'/g, '')
  .split(/[^a-z0-9]+/)
  .filter(Boolean);
const contentStems = (text) => wordsOf(text).filter((w) => !FILLER.has(w)).map(stem);
const sameWord = (a, b) => a === b
  || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)))
  || SAME_THING.some((group) => group.has(a) && group.has(b));
const covers = (wanted, said) => sameWord(wanted, said) || !!BROADER[wanted]?.has(said);

// Does `text` share a word with `name` that says what the thing is? A shared
// color or size alone doesn't count, unless that is all the name has.
const namesTheThing = (name, text) => {
  const wanted = contentStems(name);
  if (!wanted.length) return false;
  const said = contentStems(text);
  const hits = wanted.filter((w) => said.some((s) => covers(w, s)));
  const things = wanted.filter((w) => !MODIFIERS.has(w));
  return things.length ? hits.some((w) => !MODIFIERS.has(w)) : hits.length > 0;
};

// Does `text` have every word of `name` that says what the thing is? "a big black
// dog" names a dog but not "your childhood dog", and that gap is where a model
// matches the same kind of thing for the same thing. A note in parentheses, like
// who someone is, isn't needed.
const namesAllOfIt = (name, text) => {
  const said = contentStems(text);
  return contentStems(name.replace(/\(.*?\)/g, ' '))
    .filter((w) => !MODIFIERS.has(w))
    .every((w) => said.some((s) => covers(w, s)));
};

// An entry either names a particular one (whose it is, a time of life, a person)
// or only describes a thing. "your childhood dog" is one dog; "a locked
// greenhouse" is any greenhouse that happened to be locked, and a dream with an
// open one has the greenhouse back, changed.
const IDENTITY = /\b(?:your|my|his|her|their|our|childhood|first|former|ex)\b|'s\b/i;
const namesParticularOne = (entry) => IDENTITY.test(entry.name)
  || (entry.section === 'Recurring figures & people' && !/^(?:a|an|some)\s/i.test(entry.name));

// The word a described thing stands on: the last one before any "with", "at",
// "of" and the like. "a phone with no signal" is a phone, "a carnival at night" a
// carnival, "a flooded stairwell" a stairwell.
const HEAD_BREAK = /\s(?:with|without|of|in|on|at|from|near|under|behind|inside|outside|through|that|who|which|where|by|for|to|into|during)\s/i;
const headWord = (name) => {
  const words = contentStems(name.replace(/\(.*?\)/g, ' ').split(HEAD_BREAK)[0]).filter((w) => !MODIFIERS.has(w));
  const nouns = words.filter((w) => !w.endsWith('ing'));
  return (nouns.length ? nouns : words).pop() || null;
};
const namesTheHead = (name, text) => {
  const head = headWord(name);
  if (!head) return namesAllOfIt(name, text);
  return contentStems(text).some((s) => covers(head, s));
};

// The word checks only mean something when the dream and the memory file are in
// the same language, and the file is written in English.
const ENGLISH_MARKERS = new Set('the a an and i was to of in my me it he she we they on at with but that then there were is had'.split(' '));
const readsAsEnglish = (text) => {
  const words = wordsOf(text);
  if (words.length < 6) return true;
  return words.filter((w) => ENGLISH_MARKERS.has(w)).length / words.length >= 0.15;
};

// Is `quote` the dream's own words? Copied text is found as written. A small
// slip, a typo fixed or a word left out, still passes as long as every word that
// names something is there, in order, close together. Invented text fails,
// however close it sounds.
const quoteFound = (quote, dreamText) => {
  const raw = wordsOf(quote);
  if (!raw.length || raw.length > 25 || raw.every((w) => FILLER.has(w))) return false;
  const q = raw.map((w) => ({ stem: stem(w), filler: FILLER.has(w) }));
  const d = wordsOf(dreamText).map(stem);
  const need = Math.ceil(q.length * 0.8);
  const reach = q.length + 3;
  for (let start = 0; start < d.length; start += 1) {
    const end = Math.min(d.length, start + reach);
    let at = start;
    let hits = 0;
    let missedAThing = false;
    for (const word of q) {
      let found = -1;
      for (let i = at; i < end; i += 1) {
        if (d[i] === word.stem) { found = i; break; }
      }
      if (found === -1) {
        if (!word.filler) { missedAThing = true; break; }
        continue;
      }
      hits += 1;
      at = found + 1;
    }
    if (!missedAThing && hits >= need) return true;
  }
  return false;
};

// What the file held before this rewrite, which is the only ground truth there
// is for whether something has happened before. A count of null means the file
// knew the thing but never said how often, which is what older files look like.
//
// Only counted entries and the log are keyed. A note under "Shifts over time"
// like "water: calm early, rough recently" names the same thing as the water
// pattern, carries no count, and would otherwise stand in for it.
const indexMemory = (file) => {
  const entries = new Map();
  const notes = new Map();
  for (const section of parseSections(file)) {
    if (NOTE_SECTIONS.has(section.heading)) {
      notes.set(section.heading, section.lines.filter((line) => line.trim()).map((line) => line.trim()));
      continue;
    }
    const seenOnce = section.heading === SEEN_ONCE;
    if (!seenOnce && !COUNTED_SECTIONS.has(section.heading)) continue;
    for (const line of section.lines) {
      if (!line.trim()) continue;
      const phrase = toBarePhrase(line);
      const key = normalizePhrase(phrase);
      if (!key || (seenOnce && entries.has(key))) continue;
      entries.set(key, {
        seenOnce,
        count: seenOnce ? 1 : entryCount(line),
        section: section.heading,
        line: line.trim(),
        phrase,
      });
    }
  }
  return { entries, notes };
};

// Where a thing from the log goes the moment it happens a second time, when the
// rewrite didn't put it anywhere itself.
const PEOPLE_WORDS = stemSet(
  'mom mother dad father sister brother grandma grandmother grandpa grandfather aunt uncle cousin friend boss '
  + 'manager coworker teacher partner boyfriend girlfriend husband wife ex kid child son daughter baby man woman '
  + 'stranger person girl boy neighbor roommate'
);
const FEELING_WORDS = stemSet('fear dread panic anxiety anxious shame guilt grief sadness anger rage joy relief loneliness lonely embarrassment helpless');
const sectionFor = (phrase) => {
  const words = contentStems(phrase);
  if (words.some((w) => PEOPLE_WORDS.has(w))) return 'Recurring figures & people';
  if (words.some((w) => FEELING_WORDS.has(w))) return 'Emotional patterns';
  return 'Recurring symbols';
};

// The line with its count set to `n`, whatever it said before, or with one
// added where it said none.
const withCount = (line, n) => (entryCount(line) === null
  ? line.replace(/^(\s*[-•*]?\s*[^:\n]+?)(\s*:|$)/, `$1: ~${n} times$2`)
  : line.replace(/~?\s*\d+\s*times?/i, `~${n} times`));

// New things the rewrite logged that share no word with the dream or its
// reading. Those were made up, most often from an example the model was shown.
// When none of the new things match at all, the dream is most likely in another
// language than the file, and nothing is dropped.
const ungroundedPhrases = (phrases, groundText) => {
  if (!groundText || !phrases.length || !readsAsEnglish(groundText)) return new Set();
  const checked = phrases.map((phrase) => ({ key: normalizePhrase(phrase), ok: namesTheThing(phrase, groundText) }));
  if (!checked.some((c) => c.ok)) return new Set();
  return new Set(checked.filter((c) => !c.ok).map((c) => c.key));
};

// The model cannot count. It has this dream and the current file, no way to
// check whether it has seen a parking garage before, and a rule saying nothing
// above "Seen once" may say 1 time. So it writes "2 times" on things that have
// happened once and promotes them on the spot.
//
// Nor can it be trusted to keep the file. Asked to merge one dream in, it has
// handed back only the log, dropped patterns it had seen three times, and left a
// thing it was told had come back sitting in the log. So the model writes the
// words and this keeps the books:
// - Which things this dream has is settled by the match check that ran before
//   the reading (`matchedKeys`). A pattern it found goes up by exactly one, a
//   log entry it found becomes a pattern at exactly 2, and nothing else moves.
//   Without a check (null), a count can rise by at most one and the previous
//   file is the only proof that something happened before.
// - A pattern the rewrite lost comes back as it was, and so does a section of
//   notes that vanished whole.
// - Everything new has to come from `groundText`, the dream and its reading.
const reconcileMemory = (updated, previous, { matchedKeys = null, groundText = '' } = {}) => {
  if (!updated) return updated;
  const { entries: before, notes } = indexMemory(previous);
  const sections = parseSections(updated);
  const demoted = [];
  const found = (key) => !matchedKeys || matchedKeys.has(key);
  const sectionNamed = (heading) => {
    let section = sections.find((s) => s.heading === heading);
    if (!section) {
      section = { heading, lines: [] };
      sections.push(section);
    }
    return section;
  };

  for (const section of sections) {
    if (!COUNTED_SECTIONS.has(section.heading)) continue;
    section.lines = section.lines.filter((line) => {
      const text = line.trim();
      if (!text) return false;
      const phrase = toBarePhrase(text);
      const key = normalizePhrase(phrase);
      const prior = before.get(key);
      // Nothing in the file knew about this, so this dream is its first sighting
      // whatever count the model put on it. One sighting is not a pattern.
      //
      // An entry the old file carried with no count at all is the same story a
      // step back: files written before any of this recorded first sightings as
      // patterns and never said how often. It goes back to the log too, and
      // comes up again on its own the next time it actually appears.
      if (!prior || (!prior.seenOnce && prior.count === null)) {
        if (phrase) demoted.push(phrase);
        return false;
      }
      // Out of the log means it came back in this dream. The check says it
      // didn't, so it goes back to the log.
      if (prior.seenOnce && !found(key)) {
        demoted.push(phrase);
        return false;
      }
      return true;
    });
    section.lines = section.lines.map((line) => {
      const prior = before.get(normalizePhrase(toBarePhrase(line)));
      const held = prior.seenOnce ? 2 : prior.count;
      if (matchedKeys) {
        const key = normalizePhrase(toBarePhrase(line));
        return withCount(line, prior.seenOnce ? 2 : held + (matchedKeys.has(key) ? 1 : 0));
      }
      const stated = entryCount(line);
      if (stated === null) return withCount(line, held);
      const ceiling = prior.seenOnce ? 2 : held + 1;
      return stated <= ceiling ? line : withCount(line, ceiling);
    });
  }

  const kept = new Set(sections.filter((s) => COUNTED_SECTIONS.has(s.heading))
    .flatMap((s) => s.lines.map((line) => normalizePhrase(toBarePhrase(line)))));
  for (const [key, prior] of before) {
    if (kept.has(key)) continue;
    if (!prior.seenOnce && prior.count !== null) {
      // A pattern the rewrite lost.
      sectionNamed(prior.section).lines.push(withCount(prior.line, prior.count + (matchedKeys?.has(key) ? 1 : 0)));
    } else if (!prior.seenOnce) {
      // An uncounted one from an older file goes to the log, as it would have.
      demoted.push(prior.phrase);
    } else if (matchedKeys?.has(key)) {
      // Back for a second time, and the rewrite left it in the log.
      sectionNamed(sectionFor(prior.phrase)).lines.push(`- ${prior.phrase.replace(/^(?:a|an)\s+/i, '')}: ~2 times`);
    }
  }
  for (const [heading, lines] of notes) {
    const now = sections.find((s) => s.heading === heading);
    if (lines.length && !now?.lines.some((line) => line.trim())) sectionNamed(heading).lines.push(...lines);
  }

  // Everything new has to come from this dream.
  const newPhrases = [
    ...demoted.filter((phrase) => !before.has(normalizePhrase(phrase))),
    ...(sections.find((s) => s.heading === SEEN_ONCE)?.lines || [])
      .filter((line) => line.trim() && !before.has(normalizePhrase(toBarePhrase(line))))
      .map(toBarePhrase),
  ];
  const invented = ungroundedPhrases(newPhrases, groundText);

  return serializeMemory(sections, demoted, invented);
};

const SECTION_ORDER = [...COUNTED_SECTIONS, ...NOTE_SECTIONS, SEEN_ONCE];
const sectionRank = (heading) => {
  if (heading === null) return -1;
  const at = SECTION_ORDER.indexOf(heading);
  // A heading of the model's own goes just above the log.
  return at === -1 ? SECTION_ORDER.length - 1.5 : at;
};

const serializeMemory = (sections, demoted, invented) => {
  const promoted = new Set(
    sections.filter((s) => COUNTED_SECTIONS.has(s.heading))
      .flatMap((s) => s.lines.map((line) => normalizePhrase(toBarePhrase(line))))
  );
  let seenOnce = sections.find((section) => section.heading === SEEN_ONCE);
  if (!seenOnce && demoted.length) {
    seenOnce = { heading: SEEN_ONCE, lines: [] };
    sections.push(seenOnce);
  }
  if (seenOnce) {
    // Anything that just became a pattern leaves the log, and so does anything
    // new this dream doesn't have. A demotion joins it as a bare phrase unless
    // the log already has it, and a thing is logged once however it was worded.
    const logged = new Set();
    seenOnce.lines = seenOnce.lines.filter((line) => {
      const key = normalizePhrase(toBarePhrase(line));
      if (!line.trim() || promoted.has(key) || invented.has(key) || logged.has(key)) return false;
      logged.add(key);
      return true;
    });
    for (const phrase of demoted) {
      const key = normalizePhrase(phrase);
      if (promoted.has(key) || invented.has(key) || logged.has(key)) continue;
      logged.add(key);
      seenOnce.lines.push(`- ${phrase}`);
    }
  }

  return sections
    // A heading the rewrite emptied, and the "- none" the model writes instead
    // of leaving a heading out, both go.
    .filter((section) => section.lines.some((line) => line.trim() && !/^[-•*]?\s*none\.?$/i.test(line.trim())))
    .sort((a, b) => sectionRank(a.heading) - sectionRank(b.heading))
    .map((section) => (section.heading
      ? `## ${section.heading}\n${section.lines.filter((l) => l.trim() && !/^[-•*]?\s*none\.?$/i.test(l.trim())).join('\n')}`
      : section.lines.join('\n')))
    .join('\n\n');
};

// Matching a dream against the memory file.
//
// This used to be the reading's job: it got the whole file and was asked to list
// what this dream shared with it. That is a creative call at a high temperature
// holding a list of things from other dreams, and it named them whether or not
// this dream had them: "the black Tesla is back" in a dream with no Tesla in it.
// So matching is now its own call at temperature 0, every match has to quote this
// dream, and the quote is checked against the dream before anything uses it. The
// reading only ever sees the matches that held up.
const MATCH_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 3;
const MATCH_PROMPT = `You compare one new dream with a list of things recorded from the same person's earlier dreams, and report only what is clearly in both.

Return ONLY minified JSON: {"matches":[{"id":number,"quote":"string","note":"string"}]}

An entry matches only when this new dream has the same thing: the same object, person, place, event or feeling the entry names.
- Related is not the same. When an entry names something specific, the dream has to have that specific thing, not something of the same kind
- An entry ending in [this dream says "..."] shares a word with the new dream. Look at each of those closely: it is often a match, but only when it is the same thing
- "quote": the words from the new dream that show the thing, copied exactly as the new dream wrote them, one stretch of 2 to 15 words that names it, with no ellipsis. Quote the new dream, never the list. If you can't quote the new dream showing it, it is not a match
- "note": under 15 words, written to the person as "you". Start with the thing's name, then say what is the same or what changed this time, set against how the entry describes the earlier dreams. "It is back" alone says nothing the list doesn't. Something marked "seen once before" is back for its second time: say it is back, and never call it a pattern, a habit, or long-running. If you give a number of times, use the one in the entry
- No em dashes or en dashes
- Most dreams share nothing, or one or two things, with earlier ones, and {"matches":[]} is a normal answer. A wrong match is worse than a missed one`;

// The second look, for a particular one (someone's, from a time of life, a
// person) that the quote names only in part. The matcher is asked to tell "the
// same kind of thing" from "the same one" and doesn't reliably: it matched a
// stray black dog to "your childhood dog". Asked on its own, with nothing else
// to do, the model gets that question right. It is not asked about described
// things ("a locked greenhouse"), where it holds every detail to the letter.
const SAME_THING_PROMPT = `Each item pairs someone or something particular from a person's earlier dreams (theirs, from a time of their life, or a person they know) with words from their new dream. For each one, decide whether the new dream has that same one, or a different one of the same kind.

Return ONLY minified JSON: {"answers":[{"id":number,"same":boolean}]}

- "same" is true when the new dream shows it is that one, even if it looks or acts differently this time
- "same" is false when it is a different one of the same kind. A stranger's house is not your grandmother's house, and a new coworker is not the friend from summer camp
- When the dream doesn't settle which one it is, answer false`;

// One JSON answer from the model at temperature 0. Throws on any failure, so a
// caller decides what "couldn't check" means for it.
const askForJson = async ({ system, user, apiKey, maxTokens, timeoutMs }) => {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      max_tokens: maxTokens,
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}`);
  const data = await res.json();
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('The answer ran long and was cut off.');
  return choice?.message?.content || '';
};

// Where a line is about a particular thing, a match has to name it.
const CONCRETE_SECTIONS = new Set(['Recurring symbols', 'Recurring figures & people', SEEN_ONCE]);
const MATCHABLE_SECTIONS = new Set([...COUNTED_SECTIONS, 'Shifts over time', 'Open threads', SEEN_ONCE]);
const SECTION_LABEL = {
  'Recurring symbols': 'recurring symbol',
  'Recurring figures & people': 'recurring person',
  'Emotional patterns': 'recurring feeling',
  'Life themes (inferred)': 'recurring theme',
  'Notable narratives': 'recurring storyline',
  'Shifts over time': 'a change across your dreams',
  'Open threads': 'left unresolved in earlier dreams',
};

// Every line of the file a dream could match. A counted line with no count came
// from an older file and is treated as seen once, the way reconcileMemory does.
const memoryEntries = (file) => {
  const entries = [];
  for (const section of parseSections(file)) {
    if (!MATCHABLE_SECTIONS.has(section.heading)) continue;
    for (const line of section.lines) {
      const text = stripBullet(line);
      if (!text) continue;
      const counted = COUNTED_SECTIONS.has(section.heading);
      const count = section.heading === SEEN_ONCE ? 1 : (counted ? (entryCount(text) ?? 1) : null);
      entries.push({
        id: entries.length + 1,
        section: section.heading,
        text,
        name: text.split(':')[0].replace(/\*/g, '').trim(),
        key: normalizePhrase(toBarePhrase(line)),
        count,
        once: count === 1,
      });
    }
  }
  return entries;
};

// What the entry's history is. A dream that is already in the file was counted
// when it went in, so its counts include it.
const describeEntry = (entry, alreadyIndexed) => {
  if (entry.once) return 'seen once before';
  const label = SECTION_LABEL[entry.section] || 'from earlier dreams';
  if (entry.count === null) return label;
  return alreadyIndexed
    ? `${label}, in about ${entry.count} dreams counting this one`
    : `${label}, in about ${entry.count} earlier dreams, so ${entry.count + 1} with this one`;
};

const LONG_RUNNING = /\b(?:keeps?|kept|always|often|usual(?:ly)?|habit|pattern|recurr\w*|long[-\s]running|again and again|every time|so many|many times)\b/i;
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const fallbackNote = (entry, alreadyIndexed) => {
  const name = capitalize(entry.name.replace(/^(?:a|an)\s+/i, 'the '));
  if (entry.once) return `${name} is back, the second time it has shown up`;
  if (entry.count) return `${name} again, in ${alreadyIndexed ? entry.count : entry.count + 1} dreams now`;
  return `${name} comes up again`;
};
// The model's note, unless it overreaches: too long, calling a second sighting
// a habit, or never saying what came back.
const cleanNote = (note, entry, alreadyIndexed, checkWords) => {
  // No closing period, so every line of the list reads the same.
  const text = capitalize(stripDashes(typeof note === 'string' ? note.trim() : '').replace(/\.$/, ''));
  const words = text.split(/\s+/).filter(Boolean).length;
  if (!words || words > 20) return fallbackNote(entry, alreadyIndexed);
  if (entry.once && LONG_RUNNING.test(text)) return fallbackNote(entry, alreadyIndexed);
  // The list's own wording read back ("seen once before") says nothing.
  if (/\bseen once\b|\bearlier dreams?\b/i.test(text)) return fallbackNote(entry, alreadyIndexed);
  if (checkWords && !namesTheThing(entry.name, text)) return fallbackNote(entry, alreadyIndexed);
  return text;
};

// Keeps the matches that hold up: an entry that exists, a quote that is really
// in the dream, and, for a thing rather than a feeling, a quote that names it
// rather than something else in the dream.
//
// A described thing ("a locked greenhouse") holds up when the quote names the
// thing itself, whatever its details. A particular one ("your childhood dog")
// holds up outright only when the quote has every word of it; when it names
// only part ("dog"), the match comes back marked `unsure`, for the second look.
// In a dream the word checks can't read, every thing goes to the second look.
const verifyMatches = (raw, entries, dreamText, { alreadyIndexed = false } = {}) => {
  let list = null;
  try { list = JSON.parse(raw || '')?.matches; } catch { return []; }
  if (!Array.isArray(list)) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const checkWords = readsAsEnglish(dreamText);
  const kept = [];
  for (const match of list) {
    const entry = byId.get(Number(match?.id));
    if (!entry || kept.some((k) => k.entry.id === entry.id || k.entry.key === entry.key)) continue;
    const particular = CONCRETE_SECTIONS.has(entry.section);
    let quote = typeof match.quote === 'string' ? match.quote.trim().replace(/^["']|["']$/g, '') : '';
    let recovered = false;
    if (!quoteFound(quote, dreamText)) {
      quote = particular && checkWords ? quoteFromDream(entry.name, dreamText) : null;
      if (!quote) continue;
      recovered = true;
    }
    let unsure = particular && !checkWords;
    if (checkWords && particular) {
      if (namesParticularOne(entry)) {
        if (!namesTheThing(entry.name, quote)) continue;
        unsure = recovered || !namesAllOfIt(entry.name, quote);
      } else if (!namesTheHead(entry.name, quote)) {
        continue;
      }
    }
    kept.push({ entry, quote, note: cleanNote(match.note, entry, alreadyIndexed, checkWords), unsure });
    if (kept.length >= MAX_CONNECTIONS * 2) break;
  }
  return kept;
};

// The model sometimes quotes the list instead of the dream ("a locked greenhouse"
// for a dream with an open one). When the dream does name the thing, its own
// words around that name stand in, and the match goes to the second look. When
// it doesn't, there is nothing to recover and the match was invented.
const quoteFromDream = (name, dreamText) => {
  // The thing itself first, so "locked" somewhere else in the dream isn't what
  // stands in for "a locked greenhouse".
  const head = headWord(name);
  const rest = contentStems(name.replace(/\(.*?\)/g, ' ')).filter((w) => !MODIFIERS.has(w) && w !== head);
  const sentences = dreamText.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim().split(/\s+/).filter(Boolean));
  for (const wanted of [head, ...rest].filter(Boolean)) {
    for (const words of sentences) {
      const at = words.findIndex((word) => {
        const [w] = wordsOf(word);
        return w && !FILLER.has(w) && covers(wanted, stem(w));
      });
      if (at !== -1) return words.slice(Math.max(0, at - 6), at + 8).join(' ').replace(/[.!?,;:]+$/, '');
    }
  }
  return null;
};

// The second look: which unsure matches are the same particular thing. A failed
// call confirms none of them.
const confirmSameThing = async (unsure, dreamText, apiKey) => {
  if (!unsure.length) return new Set();
  const items = unsure.map(({ entry, quote }) => `[${entry.id}] Recorded earlier: "${entry.name}". In the new dream: "${quote}"`).join('\n');
  try {
    const raw = await askForJson({
      system: SAME_THING_PROMPT,
      user: `New dream:\n"""${dreamText}"""\n\nItems:\n${items}`,
      apiKey,
      maxTokens: 200,
      timeoutMs: MATCH_TIMEOUT_MS,
    });
    const answers = JSON.parse(raw)?.answers;
    if (!Array.isArray(answers)) return new Set();
    return new Set(answers.filter((a) => a?.same === true).map((a) => Number(a.id)));
  } catch (e) {
    console.error('The same-thing check failed; dropping the matches it was for:', e.message);
    return new Set();
  }
};

// The dream's own word for a thing the entry names, when it has one: "mother"
// for "Mom". In a long list the matcher misses things, and a pointer to the word
// is enough for it to look. Only a word that names all of a particular one
// counts, so "dog" is no pointer to "your childhood dog".
const dreamWordFor = (entry, dreamText) => {
  if (!CONCRETE_SECTIONS.has(entry.section)) return null;
  const particular = namesParticularOne(entry);
  if (particular && !namesAllOfIt(entry.name, dreamText)) return null;
  const wanted = particular
    ? contentStems(entry.name.replace(/\(.*?\)/g, ' ')).filter((w) => !MODIFIERS.has(w))
    : [headWord(entry.name)].filter(Boolean);
  return wordsOf(dreamText).find((word) => !FILLER.has(word) && wanted.some((w) => covers(w, stem(word)))) || null;
};

// What this dream shares with the memory file, checked. Throws when the match
// call fails, so the caller can tell "nothing matched" from "couldn't check".
//
// When the dream is already in the file, everything it added is in there too,
// and would match itself. Its "Seen once" items are left out, since most of them
// came from this very dream, and the counts are read as including it.
const findMemoryMatches = async (dreamText, memory, { alreadyIndexed = false, apiKey }) => {
  const entries = memoryEntries(memory).filter((entry) => !(alreadyIndexed && entry.once));
  if (!entries.length) return [];
  const hints = readsAsEnglish(dreamText);
  const list = entries.map((entry) => {
    const word = hints ? dreamWordFor(entry, dreamText) : null;
    return `[${entry.id}] (${describeEntry(entry, alreadyIndexed)}) ${entry.text}${word ? ` [this dream says "${word}"]` : ''}`;
  }).join('\n');
  const raw = await askForJson({
    system: MATCH_PROMPT,
    user: `Recorded from earlier dreams:\n${list}\n\nNew dream:\n"""${dreamText}"""`,
    apiKey,
    maxTokens: 500,
    timeoutMs: MATCH_TIMEOUT_MS,
  });
  const kept = verifyMatches(raw, entries, dreamText, { alreadyIndexed });
  const confirmed = await confirmSameThing(kept.filter((m) => m.unsure), dreamText, apiKey);
  return kept
    .filter((m) => !m.unsure || confirmed.has(m.entry.id))
    .slice(0, MAX_CONNECTIONS)
    .map(({ entry, quote, note }) => ({ entry, quote, note }));
};

// The only history the reading is given. It never sees the rest of the file, so
// it has nothing else to borrow from.
const buildPatternBlock = (matches, alreadyIndexed) => {
  if (!matches?.length) return null;
  const lines = matches.map(({ entry, quote }) => `- ${entry.text} (${describeEntry(entry, alreadyIndexed)}). In this dream: "${quote}"`);
  return `[What this dream shares with your earlier dreams. Each line was checked against your dream memory and found in this dream.]
${lines.join('\n')}

PATTERN DIRECTIVE:
- These are the only links to earlier dreams that are known to be real. In "themes", bring in the one or two that matter most to this dream, and say what is the same or different this time.
- Something seen once before is back for its second time. Say that plainly, and never call it a pattern, a habit, or long-running.
- Mention no other earlier dream, symbol, person or feeling, and add no history the list doesn't give.`;
};

// Rewrites the memory file from the current one. Returns whether it persisted.
// The caller must not mark the dream indexed unless it did, or the dream is lost
// from the memory permanently.
//
// `matched` is what the match check found of the file in this dream, as
// { name, key } pairs, or null when the check didn't run or failed. Then it runs
// again here, on the file as it is now. If it fails again, nothing counts as
// matched: a repeat goes unseen this once, which is better than a count raised on
// a guess.
const updateDreamMemory = async (uid, dreamText, aiTitle, aiInsights, apiKey, matched = null) => {

  // Re-read instead of using the copy fetched at the top of the request: this
  // rewrites the whole file, so building on a stale read would silently discard
  // whatever an overlapping analysis wrote in the meantime.
  // A failed read isn't an empty file: rewriting from nothing would replace
  // the whole memory with this one dream.
  let currentMemory;
  try { currentMemory = await getDreamMemory(uid); }
  catch (e) { console.error('Dream memory read failed; leaving it as it is:', e.message); return false; }

  let found = matched;
  if (!found && currentMemory) {
    try {
      found = (await findMemoryMatches(dreamText, currentMemory, { apiKey }))
        .map(({ entry }) => ({ name: entry.name, key: entry.key }));
    } catch (e) {
      console.error('Dream memory match check failed; counting nothing as matched:', e.message);
      found = [];
    }
  }
  found = found || [];

  const checked = found.length
    ? `Checked against this dream, these entries already in the file appear in it again: ${found.map((m) => m.name).join('; ')}. Only these may gain a count or move up out of "Seen once".`
    : 'Checked against this dream: nothing already in the file appears in it again. No count goes up and nothing moves up out of "Seen once". Log what is new.';

  const userContent = [
    `Current memory:\n${currentMemory || '(empty, this is the first entry)'}`,
    `---`,
    `New dream title: ${aiTitle}`,
    `Dream content: ${dreamText.slice(0, 2000)}`,
    `AI analysis: ${aiInsights}`,
    `---`,
    checked,
  ].join('\n');

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(MEMORY_TIMEOUT_MS),
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: MEMORY_PROMPT },
          { role: 'user', content: userContent },
        ],
        // The file is capped at 900 words, which is roughly 1200 tokens. The
        // old ceiling of 1200 tokens meant a full file was cut off mid-entry
        // and saved that way, and the next update built on the truncation.
        max_tokens: 2000,
        temperature: 0.3,
      }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    const choice = data.choices?.[0];
    if (choice?.finish_reason === 'length') {
      console.error('Dream memory update hit the token ceiling; keeping the previous file.');
      return false;
    }
    const updatedMemory = reconcileMemory(choice?.message?.content?.trim(), currentMemory, {
      matchedKeys: new Set(found.map((m) => m.key)),
      groundText: `${dreamText}\n${aiInsights || ''}`,
    });
    if (!updatedMemory) return false;
    // A file that comes back less than half its old size is a failed rewrite,
    // not a consolidation. Trimming rare entries never costs that much.
    if (currentMemory && updatedMemory.length < currentMemory.length * 0.5) {
      console.error('Dream memory update came back truncated; keeping the previous file.');
      return false;
    }
    const writeError = await saveDreamMemory(uid, updatedMemory);
    if (writeError) { console.error('Dream memory write failed:', writeError); return false; }
    return true;
  } catch (e) {
    console.error('Dream memory update failed:', e.message);
    return false;
  }
};

const buildSystemPrompt = (styleDelta, contextBlock, lengthRule, requirement) => {
  const parts = [
    styleDelta || STYLE_DELTAS.balanced,
    buildOutputRules(lengthRule || DEFAULT_STYLE_LENGTH, requirement || DEFAULT_STYLE_REQUIREMENT),
  ];
  // Only the checked matches (buildPatternBlock), never the memory file itself.
  if (contextBlock) parts.push(contextBlock);
  return parts.join('\n\n');
};

const callOpenAI = async (text, apiKey, styleDelta, contextBlock, temperature = 0.7, lengthRule = DEFAULT_STYLE_LENGTH, requirement = DEFAULT_STYLE_REQUIREMENT, model = READING_MODEL) => {
  const sys = buildSystemPrompt(styleDelta, contextBlock, lengthRule, requirement);
  // The client has no timeout of its own, so a stalled call would leave the
  // generate button spinning for as long as the platform allows.
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(ANALYSIS_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: `Dream:\n"""${text}"""` }
      ],
      // JSON mode, so the answer is always parseable and the regex fallback in
      // parse() stops being the thing that saves a response.
      response_format: { type: 'json_object' },
      max_tokens: MAX_TOKENS,
      temperature
    })
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`OpenAI error ${res.status}: ${err}`);
  }
  const data = await res.json();
  const choice = data.choices?.[0];
  // A cut-off answer is truncated JSON. The caller refunds the quota on a throw,
  // so name what happened instead of letting it read as an incomplete response.
  if (choice?.finish_reason === 'length') throw new Error('The analysis ran long and was cut off. Try generating it again.');
  const content = choice?.message?.content;
  if (!content) throw new Error('Empty AI response');
  return content;
};

// Index this dream into the memory file unless it already has been. A
// re-generation of an already-indexed dream must not count twice.
const scheduleMemoryIndexing = ({ uid, tier, dreamId, text, title, themes, safetyFiltered, apiKey, matched = null }) => {
  if (tier !== 'premium' || safetyFiltered || !dreamId || !apiKey) return;

  const indexing = (async () => {
    if (await isDreamMemoryIndexed(uid, dreamId)) return;
    const stored = await updateDreamMemory(uid, text, title, themes, apiKey, matched);
    // Only claim the dream once the memory actually holds it. Marking it on a
    // failed update used to retire the dream from indexing forever.
    if (!stored) return;
    const { error } = await getSupabaseAdmin()
      .from('dreams')
      .update({ memory_indexed: true })
      .eq('id', dreamId)
      .eq('user_id', uid);
    if (error) console.error('Marking dream memory-indexed failed:', error.message);
  })().catch((e) => console.error('Dream memory indexing failed:', e?.message || e));

  deferWork(indexing);
};

// House style has no em or en dashes. The prompt asks, this guarantees.
const stripDashes = (text) => (text || '')
  .replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, '$1-$2')
  .replace(/\s*[\u2013\u2014]\s*/g, ', ')
  .replace(/\s*,\s*,/g, ',')
  .replace(/\s+([,.;:!?])/g, '$1');

const parse = (raw) => {
  if (!raw) return { title: null, themes: null, connections: [] };
  const t = raw.trim();
  let title = null, themes = null, connections = [];
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      title = j.title?.trim() || null;
      themes = j.themes?.trim() || null;
      connections = Array.isArray(j.connections)
        ? j.connections.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
        : [];
    } catch (e) { console.error('JSON parse error:', e.message); }
  }
  if (!title) { const m = raw.match(/"title"\s*:\s*"([^"]+)"/i); if (m) title = m[1].trim(); }
  if (!themes) { const m = raw.match(/"themes"\s*:\s*"([^"]+)"/i); if (m) themes = m[1].trim(); }
  return {
    title: title && stripDashes(title),
    themes: themes && stripDashes(themes),
    connections: connections.map(stripDashes),
  };
};

module.exports = async function handler(req, res) {
  setCors(res, req.headers?.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  body = body || {};

  // `isMemoryIndexed` is still accepted in the body for older clients but is
  // deliberately ignored, because indexing is decided from the row itself.
  const { dreamText, idToken, dreamId, customPrompt, promptStyle, dreamDate } = body;
  if (!dreamText || typeof dreamText !== 'string') return res.status(400).json({ error: 'Missing dreamText' });
  if (!idToken) return res.status(401).json({ error: 'Authentication required.' });

  const text = dreamText.trim().slice(0, MAX_LEN);
  if (!text) return res.status(400).json({ error: 'Empty dreamText' });

  // Verify token
  let user;
  try { user = await verifyToken(idToken); }
  catch { return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' }); }
  const uid = user.id;

  let tier = 'free';
  try {
    tier = await getUserTier(user);
  } catch (e) {
    console.error('Loading the plan failed:', e?.message || e);
    return res.status(500).json({ error: 'We could not check your plan. Try again in a minute.' });
  }

  const normalizedStyle = normalizePromptStyle((promptStyle || '').trim() || 'balanced');
  if (isPromptStyleLockedForTier(tier, normalizedStyle)) {
    return res.status(403).json({
      error: 'That insight style is available on Pro only.',
      code: 'style_locked',
      tier
    });
  }

  // Check cache before quota (cached responses are free). A custom prompt is
  // held to the length the settings screen allows, so a hand-made request
  // can't send a novel with every reading.
  const ownPrompt = tier === 'premium' && typeof customPrompt === 'string'
    ? customPrompt.trim().slice(0, MAX_CUSTOM_PROMPT)
    : '';
  let effectivePrompt = normalizedStyle === 'custom'
    ? (ownPrompt || PROMPT_TEMPLATES.balanced)
    : (PROMPT_TEMPLATES[normalizedStyle] || PROMPT_TEMPLATES.balanced);

  if (normalizedStyle === 'astrology' && dreamDate) {
    const skyContext = buildAstrologyContext(dreamDate);
    if (skyContext) effectivePrompt = `${effectivePrompt}\n\n${skyContext}`;
  }

  const cacheKey = hash(text + effectivePrompt + normalizedStyle + uid);
  if (cache.has(cacheKey)) {
    const { result: hit, matched } = cache.get(cacheKey);
    // A cached answer still has to index: if the first attempt's memory write
    // failed, retrying the same dream in the same style would otherwise short
    // circuit here and the dream would never reach the memory file.
    scheduleMemoryIndexing({
      uid,
      tier,
      dreamId,
      text,
      title: hit.title,
      themes: hit.themes,
      safetyFiltered: hit.safetyFiltered,
      apiKey: process.env.OPENAI_API_KEY,
      matched,
    });
    return res.status(200).json({ ...hit, cached: true });
  }

  // Check and increment quota atomically
  let quota;
  try { quota = await checkAndIncrementQuota(uid); }
  catch (e) {
    console.error('Quota check RPC failed, using fallback:', e?.message || e, '| code:', e?.code);
    try {
      quota = await checkAndIncrementQuotaFallback(uid, tier);
    } catch (fallbackError) {
      const detail = fallbackError?.message || String(fallbackError);
      console.error('Quota fallback failed:', detail);
      return res.status(500).json({ error: 'We could not check how many readings you have left. Try again in a minute.' });
    }
  }

  if (!quota.allowed) {
    return res.status(429).json({
      error: 'Monthly limit reached.',
      code: 'quota_exceeded',
      remainingFree: 0,
      creditBalance: quota.creditBalance ?? 0
    });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI not configured.' });

  // Premium accounts: check this dream against the memory file first, and give
  // the reading only the matches that held up. `matched` stays null when the
  // check couldn't run, so the memory update knows to run it again.
  let contextBlock = null;
  let matches = [];
  let matched = null;
  if (quota.tier === 'premium') {
    try {
      const memory = await getDreamMemory(uid);
      if (memory) {
        const alreadyIndexed = dreamId ? (await readMemoryIndexed(uid, dreamId)) === true : false;
        matches = await findMemoryMatches(text, memory, { alreadyIndexed, apiKey });
        contextBlock = buildPatternBlock(matches, alreadyIndexed);
      }
      matched = matches.map(({ entry }) => ({ name: entry.name, key: entry.key }));
    } catch (e) {
      console.error('Checking this dream against dream memory failed:', e.message);
      matches = [];
    }
  }
  const connections = matches.map((m) => m.note).filter((note) => !containsTeenUnsafeText(note));

  const temperature = STYLE_TEMPERATURE[normalizedStyle] ?? 0.7;
  const lengthRule = STYLE_LENGTH[normalizedStyle] ?? DEFAULT_STYLE_LENGTH;
  const requirement = STYLE_REQUIREMENT[normalizedStyle] ?? DEFAULT_STYLE_REQUIREMENT;

  let raw = '';
  try { raw = await callOpenAI(text, apiKey, effectivePrompt, contextBlock, temperature, lengthRule, requirement, readingModelFor(normalizedStyle)); }
  catch (e) {
    refundQuota(uid, quota.usedCredit).catch(() => {});
    console.error('The reading failed:', e?.message || e);
    return res.status(502).json({ error: 'The reading could not be written just now. Try again in a minute.' });
  }

  // The reading's own "connections", if it still writes any, are ignored: the
  // list comes from the checked matches above.
  const { title, themes } = parse(raw);
  if (!title || !themes) {
    refundQuota(uid, quota.usedCredit).catch(() => {});
    return res.status(502).json({ error: 'Incomplete AI response.' });
  }

  const safeTitle = containsTeenUnsafeText(title) ? SAFE_AI_TITLE_FALLBACK : title;
  const safeThemes = containsTeenUnsafeText(themes) ? SAFE_AI_THEMES_FALLBACK : themes;
  const safetyFiltered = safeTitle !== title || safeThemes !== themes;

  const result = { title: safeTitle, themes: safeThemes, connections, safetyFiltered };
  cache.set(cacheKey, { result, matched });

  scheduleMemoryIndexing({ uid, tier: quota.tier, dreamId, text, title: safeTitle, themes: safeThemes, safetyFiltered, apiKey, matched });

  res.status(200).json({
    ...result,
    tier: quota.tier,
    remainingFree: quota.remainingFree,
    creditBalance: quota.creditBalance,
    usedCredit: quota.usedCredit ?? false
  });
};

module.exports.deps = deps;
module.exports.internals = {
  getUserTier,
  getDreamMemory,
  saveDreamMemory,
  reconcileMemory,
  updateDreamMemory,
  memoryEntries,
  verifyMatches,
  quoteFound,
  namesTheThing,
  buildSystemPrompt,
  MEMORY_PROMPT,
  MATCH_PROMPT,
  SAME_THING_PROMPT,
};
