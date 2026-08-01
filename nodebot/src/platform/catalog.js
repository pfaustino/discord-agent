// The product, server-side: the tier ladder and which tier each capability
// needs. This is what an order is validated against.
//
// `site/js/catalog.js` is the customer-facing copy — it also carries the
// marketing prose, the pricing matrix and the builder toggles, none of which
// belongs in the bot. test/platform.test.js asserts the two agree on every
// capability's id and required tier, so a capability cannot be sold at one
// tier on the pricing page and validated at another here.

/** Lowest to highest. Index is the comparison — a tier includes every
 *  capability at or below its own position. */
export const TIERS = [
  { id: 'hobby', name: 'Hobby', price: 0 },
  { id: 'core', name: 'Core', price: 19 },
  { id: 'voice', name: 'Voice', price: 49 },
  { id: 'autonomy', name: 'Autonomy', price: 99 },
];

export const TIER_INDEX = Object.fromEntries(TIERS.map((t, i) => [t.id, i]));

/** capability id → the lowest tier that includes it. */
export const CAPABILITY_TIER = {
  'mod-commands': 'hobby',
  'roles-channels': 'hobby',
  automod: 'hobby',
  welcome: 'hobby',
  modlog: 'hobby',
  dashboard: 'hobby',
  'nl-admin': 'core',
  'access-levels': 'core',
  chat: 'hobby',
  models: 'core',
  persona: 'core',
  documents: 'core',
  search: 'core',
  'repo-analysis': 'core',
  'repo-review': 'autonomy',
  'working-memory': 'core',
  'durable-memory': 'core',
  profiles: 'core',
  'chat-log': 'core',
  'cross-channel': 'core',
  knowledge: 'autonomy',
  manuscript: 'autonomy',
  'voice-join': 'voice',
  transcription: 'voice',
  wake: 'voice',
  followup: 'voice',
  tts: 'voice',
  'voice-clone': 'voice',
  'voice-automod': 'voice',
  'transcript-console': 'voice',
  pressure: 'autonomy',
  gate: 'autonomy',
  deescalation: 'autonomy',
  'proactive-voice': 'autonomy',
  state: 'hobby',
  logs: 'core',
  breaker: 'core',
  priority: 'autonomy',
  dedicated: 'autonomy',
};

/* Capabilities that cannot stand on their own. Kept separate from the tier
   ladder because they are a different kind of impossible: `wake` at the Voice
   tier is affordable but meaningless without `voice-join`, and an order that
   asks for it is a misunderstanding to catch at submission rather than a
   surprise for whoever runs the onboarding call. */
export const CAPABILITY_REQUIRES = {
  wake: ['voice-join'],
  followup: ['voice-join', 'wake'],
  transcription: ['voice-join'],
  tts: ['voice-join'],
  'voice-clone': ['tts'],
  'voice-automod': ['transcription'],
  'transcript-console': ['transcription'],
  'proactive-voice': ['voice-join', 'pressure'],
  gate: ['pressure'],
  'repo-review': ['repo-analysis'],
  persona: ['chat'],
  documents: ['chat'],
  search: ['chat'],
  'durable-memory': ['chat'],
  knowledge: ['chat'],
  manuscript: ['chat'],
};

export function isTier(id) {
  return Object.hasOwn(TIER_INDEX, String(id));
}

/** The lowest tier that covers every capability in `modules`. */
export function requiredTier(modules = []) {
  let highest = 0;
  for (const id of modules) {
    const tier = CAPABILITY_TIER[id];
    if (tier) highest = Math.max(highest, TIER_INDEX[tier]);
  }
  return TIERS[highest].id;
}

/**
 * Check an order's module set against its tier.
 *
 * Runs synchronously at submission so the customer sees the result
 * immediately rather than being told two days later, on the call, that what
 * they picked was never possible.
 *
 * @returns {{ok: boolean, errors: string[], requiredTier: string}}
 */
export function validateOrder({ tier, modules = [] }) {
  const errors = [];
  if (!isTier(tier)) {
    errors.push(`Unknown tier: ${tier}`);
    return { ok: false, errors, requiredTier: requiredTier(modules) };
  }
  const selected = new Set(modules);
  for (const id of selected) {
    if (!CAPABILITY_TIER[id]) {
      errors.push(`Unknown capability: ${id}`);
      continue;
    }
    if (TIER_INDEX[CAPABILITY_TIER[id]] > TIER_INDEX[tier]) {
      errors.push(`${id} needs the ${CAPABILITY_TIER[id]} tier or higher`);
    }
    for (const dep of CAPABILITY_REQUIRES[id] || []) {
      if (!selected.has(dep)) errors.push(`${id} needs ${dep} switched on too`);
    }
  }
  return { ok: errors.length === 0, errors, requiredTier: requiredTier(modules) };
}
