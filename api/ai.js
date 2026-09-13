const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const Astronomy = require('astronomy-engine');

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
// The analysis is what the user is waiting on, so it gets a tight ceiling. The
// memory rewrite runs after the response and can take the rest of the budget.
const ANALYSIS_TIMEOUT_MS = 25_000;
const MEMORY_TIMEOUT_MS = 40_000;
const MODEL = 'gpt-4o-mini';
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

Return ONLY minified JSON: {"title":"string","themes":"string","connections":[]}

- "title": a poetic, evocative 2 to 4 word phrase that names this specific dream (never generic)
- "themes": ${lengthRule}, written as one flowing paragraph of plain text. The app shows it as a single paragraph, so no markdown, no headings, no bullets, no line breaks. ${requirement}
- "connections": [], unless a memory block below tells you otherwise
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
const STYLE_LENGTH = {
  balanced:  '130 to 170 words',
  coach:     '140 to 180 words',
  therapist: '140 to 180 words',
  scientist: '150 to 200 words',
  mystical:  '140 to 180 words',
  creative:  '150 to 200 words',
  director:  '120 to 160 words',
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

const getSupabaseAdmin = () => createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Verify user token and return uid
const verifyToken = async (token) => {
  const admin = getSupabaseAdmin();
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) throw new Error('Invalid or expired session.');
  return user.id;
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

const getUserTier = async (uid) => {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('profiles')
    .select('subscription, email')
    .eq('id', uid)
    .single();
  if (error) {
    throw new Error(`Could not load subscription: ${error.message}`);
  }
  const tier = data?.subscription?.tier === 'premium' ? 'premium' : 'free';
  if (tier === 'premium') return 'premium';
  
  // Check if user's email is in the premium_emails env whitelist
  const premiumEmailsEnv = (process.env.PREMIUM_EMAILS || '').trim();
  if (premiumEmailsEnv) {
    const userEmail = (data?.email || '').toLowerCase();
    const premiumEmails = premiumEmailsEnv
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e);
    if (userEmail && premiumEmails.includes(userEmail)) {
      return 'premium';
    }
  }
  
  return 'free';
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

// Read the user's persistent dream memory file
const getDreamMemory = async (uid) => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('profiles')
    .select('dream_memory')
    .eq('id', uid)
    .single();
  return data?.dream_memory || null;
};

// Has this dream already contributed to the memory file? Read it rather than
// trusting the client's `isMemoryIndexed`, which the caller could set either way
// to suppress indexing or pay for it twice. Scoped by owner so a borrowed dream
// id can't touch someone else's row.
const isDreamMemoryIndexed = async (uid, dreamId) => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('dreams')
    .select('memory_indexed')
    .eq('id', dreamId)
    .eq('user_id', uid)
    .maybeSingle();
  // Missing or not ours: treat as indexed so nothing is written.
  return data ? !!data.memory_indexed : true;
};

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
- "Seen once" is the log. One line for each thing that has turned up in exactly one dream, written as a bare noun phrase and nothing else: "a black Tesla", "a flooded stairwell", "your old high school". No meaning, no reading, no count
- Every section above "Seen once" is for patterns, and a pattern is something that has turned up in two or more separate dreams. Every line there carries its count, and that count is never 1

Working a new dream into the file:
- Something you have no record of: add one line to "Seen once" and nothing anywhere else. Writing it above "Seen once" with a count of 1 is always wrong, however striking it was
- Something already sitting under "Seen once": this is its second appearance. Take it out of "Seen once", put it in the section where it belongs as "2 times", and only now say what it may mean
- Something already recorded as a pattern: raise its count and sharpen the reading
- Moods, themes and narratives work the same way. One dream's dread is not an emotional pattern
- An entry above "Seen once" carrying a count of 1, or no count at all, came from an older version of this file. Move it down to "Seen once" and strip its reading
- Keep "Seen once" to about 25 entries. When it overflows, drop the oldest

Rules:
- Keep total length under 900 words
- Use concise note-style writing, not full prose sentences
- Every entry above "Seen once" carries its count (e.g. "water: ~8 times")
- Note the direction a pattern is moving, not just that it exists (e.g. "water: ~8 times; still and calm in early entries, turbulent recently")
- Record pairings that keep co-occurring (e.g. "the house appears with the absent father in most entries")
- Under "Shifts over time", record changes worth telling the dreamer about: a symbol that has inverted, an emotion that has cooled, a recurring figure that has stopped appearing
- Under "Open threads", record what keeps arriving unresolved, such as a chase never resolved, a door never opened, or a conversation never finished
- Relative sequencing only ("early entries", "recently", "the last few"), never dates, months, or dream IDs
- Merge new information into existing entries, never duplicate
- Add new entries only when genuinely novel, and never duplicate an item between "Seen once" and a section above it
- Never drop an entry that has occurred 3 or more times; consolidate wording instead
- When nearing the length limit, trim "Seen once" first, oldest entries going first
- Never include raw dream text, only synthesized patterns and observations
- The dreamer reads this file, so write it to them. Never refer to them in the third person and never call them "the user", "the dreamer", or by name
- Every entry is already about them, so a possessive is redundant: write "Dad: represents a desire for emotional backing", not "User's dad: ...". Where a reference is genuinely unavoidable, use "you" or "your"
- Apply that to entries already in the file: when merging, rewrite any third-person reference you find into this voice
- Never speculate about diagnoses, medical conditions, or the dreamer's safety

Last pass before you answer: read every line above "Seen once". Any of them that does not stand on two or more dreams belongs under "Seen once" instead, as a bare noun phrase.

Return ONLY the updated memory file. No preamble or explanation.`;

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

// What the file held before this rewrite, which is the only ground truth there
// is for whether something has happened before. A count of null means the file
// knew the thing but never said how often, which is what older files look like.
const indexMemory = (file) => {
  const index = new Map();
  for (const section of parseSections(file)) {
    for (const line of section.lines) {
      if (!line.trim()) continue;
      const key = normalizePhrase(toBarePhrase(line));
      if (!key) continue;
      index.set(key, {
        seenOnce: section.heading === SEEN_ONCE,
        count: section.heading === SEEN_ONCE ? 1 : entryCount(line),
      });
    }
  }
  return index;
};

// The model cannot count. It has this dream and the current file, no way to
// check whether it has seen a parking garage before, and a rule saying nothing
// above "Seen once" may say 1 time. So it writes "2 times" on things that have
// happened once and promotes them on the spot. The previous file settles it
// instead: something is a pattern here only if the file already knew it, and a
// count can only go up by the one dream being merged in.
const reconcileMemory = (updated, previous) => {
  if (!updated) return updated;
  const before = indexMemory(previous);
  const sections = parseSections(updated);
  const demoted = [];

  for (const section of sections) {
    if (!COUNTED_SECTIONS.has(section.heading)) continue;
    section.lines = section.lines.filter((line) => {
      const text = line.trim();
      if (!text) return false;
      const phrase = toBarePhrase(text);
      const prior = before.get(normalizePhrase(phrase));
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
      return true;
    });
  }

  return serializeMemory(sections, demoted, before);
};

const serializeMemory = (sections, demoted, before) => {
  // A promotion out of "Seen once" is real and lands on a count of exactly 2.
  // Anything else is capped at what it had plus this one dream, the most a
  // single merge can honestly add. An entry the old file never counted stays
  // uncounted unless the model committed to a number, and then only to 2.
  for (const section of sections) {
    if (!COUNTED_SECTIONS.has(section.heading)) continue;
    section.lines = section.lines.map((line) => {
      const prior = before.get(normalizePhrase(toBarePhrase(line)));
      if (!prior) return line;
      const stated = entryCount(line);
      const held = prior.seenOnce ? 2 : (prior.count ?? 2);
      const ceiling = prior.seenOnce ? 2 : held + 1;
      // A rewrite that leaves the count off keeps the one the file already had,
      // since there is nothing to say the thing turned up again this time.
      if (stated === null) return line.replace(/^(\s*[-•*]\s*[^:\n]+?)(\s*:|$)/, `$1: ~${held} times$2`);
      if (stated <= ceiling) return line;
      return line.replace(/~?\s*\d+\s*times?/i, `~${ceiling} times`);
    });
  }

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
    // Anything that just became a pattern leaves the log, and a demotion joins
    // it as a bare phrase unless the log already has it.
    seenOnce.lines = seenOnce.lines.filter((line) => line.trim() && !promoted.has(normalizePhrase(toBarePhrase(line))));
    for (const phrase of demoted) {
      const key = normalizePhrase(phrase);
      if (promoted.has(key)) continue;
      if (seenOnce.lines.some((line) => normalizePhrase(toBarePhrase(line)) === key)) continue;
      seenOnce.lines.push(`- ${phrase}`);
    }
  }

  return sections
    // A heading the rewrite emptied, and the "- none" the model writes instead
    // of leaving a heading out, both go.
    .filter((section) => section.lines.some((line) => line.trim() && !/^[-•*]?\s*none\.?$/i.test(line.trim())))
    .map((section) => (section.heading
      ? `## ${section.heading}\n${section.lines.filter((l) => l.trim() && !/^[-•*]?\s*none\.?$/i.test(l.trim())).join('\n')}`
      : section.lines.join('\n')))
    .join('\n\n');
};

// Rewrites the memory file from the current one. Returns whether it persisted.
// The caller must not mark the dream indexed unless it did, or the dream is lost
// from the memory permanently.
const updateDreamMemory = async (uid, dreamText, aiTitle, aiInsights, apiKey) => {

  // Re-read instead of using the copy fetched at the top of the request: this
  // rewrites the whole file, so building on a stale read would silently discard
  // whatever an overlapping analysis wrote in the meantime.
  const currentMemory = await getDreamMemory(uid).catch(() => null);

  const userContent = [
    `Current memory:\n${currentMemory || '(empty, this is the first entry)'}`,
    `---`,
    `New dream title: ${aiTitle}`,
    `Dream content: ${dreamText.slice(0, 2000)}`,
    `AI analysis: ${aiInsights}`,
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
    const updatedMemory = reconcileMemory(choice?.message?.content?.trim(), currentMemory);
    if (!updatedMemory) return false;
    // A file that comes back less than half its old size is a failed rewrite,
    // not a consolidation. Trimming rare entries never costs that much.
    if (currentMemory && updatedMemory.length < currentMemory.length * 0.5) {
      console.error('Dream memory update came back truncated; keeping the previous file.');
      return false;
    }
    const admin = getSupabaseAdmin();
    const { error } = await admin.from('profiles').update({
      dream_memory: updatedMemory,
      dream_memory_updated_at: new Date().toISOString(),
    }).eq('id', uid);
    if (error) { console.error('Dream memory write failed:', error.message); return false; }
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
  // The connections rules live here rather than in the base prompt, because
  // without a memory file there is nothing to connect and the whole block is
  // just tokens that invite the model to invent a pattern.
  if (contextBlock) {
    parts.push(`${contextBlock}

MEMORY DIRECTIVE: This dreamer has a recorded history. Use it honestly.
- Fill "connections" only with things the memory file explicitly records that are also clearly present in this dream, each under 15 words. A contrast counts when both halves are real, for example "water recurs, but this is the first time it turns violent". A symbol this dream has that the memory file does not is not recurring. Return [] if nothing overlaps.
- The file's "Seen once" list is things that have happened exactly once. One of those turning up in this dream is its second appearance, which is worth saying plainly ("the black Tesla is back"). Never call it a long-running pattern, and never cite a "Seen once" item that is not in this dream.
- In "themes", mention a remembered pattern only where it genuinely shows up in this dream, for example "Water has come up in your dreams before; here it shifts from still to rushing..."
- Reach for what the dreamer is least likely to have noticed: a symbol that has inverted since earlier entries, two elements that keep arriving together, an emotion missing where the memory says it usually sits.
- Accuracy matters more than fullness. Fewer real connections are better than more invented ones.`);
  }
  return parts.join('\n\n');
};

const callOpenAI = async (text, apiKey, styleDelta, contextBlock, temperature = 0.7, lengthRule = DEFAULT_STYLE_LENGTH, requirement = DEFAULT_STYLE_REQUIREMENT) => {
  const sys = buildSystemPrompt(styleDelta, contextBlock, lengthRule, requirement);
  // The client has no timeout of its own, so a stalled call would leave the
  // generate button spinning for as long as the platform allows.
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(ANALYSIS_TIMEOUT_MS),
    body: JSON.stringify({
      model: MODEL,
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
const scheduleMemoryIndexing = ({ uid, tier, dreamId, text, title, themes, safetyFiltered, apiKey }) => {
  if (tier !== 'premium' || safetyFiltered || !dreamId || !apiKey) return;

  const indexing = (async () => {
    if (await isDreamMemoryIndexed(uid, dreamId)) return;
    const stored = await updateDreamMemory(uid, text, title, themes, apiKey);
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
  let uid;
  try { uid = await verifyToken(idToken); }
  catch { return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' }); }

  let tier = 'free';
  try {
    tier = await getUserTier(uid);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Could not verify subscription tier.' });
  }

  const normalizedStyle = normalizePromptStyle((promptStyle || '').trim() || 'balanced');
  if (isPromptStyleLockedForTier(tier, normalizedStyle)) {
    return res.status(403).json({
      error: 'That insight style is available on Pro only.',
      code: 'style_locked',
      tier
    });
  }

  // Check cache before quota (cached responses are free)
  let effectivePrompt = normalizedStyle === 'custom'
    ? ((tier === 'premium' ? customPrompt : null) || PROMPT_TEMPLATES.balanced)
    : (PROMPT_TEMPLATES[normalizedStyle] || PROMPT_TEMPLATES.balanced);

  if (normalizedStyle === 'astrology' && dreamDate) {
    const skyContext = buildAstrologyContext(dreamDate);
    if (skyContext) effectivePrompt = `${effectivePrompt}\n\n${skyContext}`;
  }

  const cacheKey = hash(text + effectivePrompt + normalizedStyle + uid);
  if (cache.has(cacheKey)) {
    const hit = cache.get(cacheKey);
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
      return res.status(500).json({ error: `Could not verify usage quota: ${detail}` });
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

  // Load dream memory for premium users (used as analysis context)
  let contextBlock = null;
  let currentMemory = null;
  if (quota.tier === 'premium') {
    try {
      currentMemory = await getDreamMemory(uid);
      if (currentMemory) {
        contextBlock = `[Dream memory: this dreamer's recurring symbols, patterns, and themes]\n${currentMemory}`;
      }
    } catch (e) { console.error('Dream memory fetch failed:', e.message); }
  }

  const temperature = STYLE_TEMPERATURE[normalizedStyle] ?? 0.7;
  const lengthRule = STYLE_LENGTH[normalizedStyle] ?? DEFAULT_STYLE_LENGTH;
  const requirement = STYLE_REQUIREMENT[normalizedStyle] ?? DEFAULT_STYLE_REQUIREMENT;

  let raw = '';
  try { raw = await callOpenAI(text, apiKey, effectivePrompt, contextBlock, temperature, lengthRule, requirement); }
  catch (e) {
    refundQuota(uid, quota.usedCredit).catch(() => {});
    return res.status(502).json({ error: e.message || 'AI failed.' });
  }

  const { title, themes, connections } = parse(raw);
  if (!title || !themes) {
    refundQuota(uid, quota.usedCredit).catch(() => {});
    return res.status(502).json({ error: 'Incomplete AI response.' });
  }

  const safeTitle = containsTeenUnsafeText(title) ? SAFE_AI_TITLE_FALLBACK : title;
  const safeThemes = containsTeenUnsafeText(themes) ? SAFE_AI_THEMES_FALLBACK : themes;
  const safetyFiltered = safeTitle !== title || safeThemes !== themes;

  const result = { title: safeTitle, themes: safeThemes, connections, safetyFiltered };
  cache.set(cacheKey, result);

  scheduleMemoryIndexing({ uid, tier: quota.tier, dreamId, text, title: safeTitle, themes: safeThemes, safetyFiltered, apiKey });

  res.status(200).json({
    ...result,
    connections,
    tier: quota.tier,
    remainingFree: quota.remainingFree,
    creditBalance: quota.creditBalance,
    usedCredit: quota.usedCredit ?? false
  });
};
