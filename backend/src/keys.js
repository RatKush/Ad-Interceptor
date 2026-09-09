// Licence key generation and formatting.
//
// Format: AI3-XXXXX-XXXXX-XXXXX-XXXXX
//
// The alphabet is Crockford base32 minus the ambiguous glyphs, so a key can be
// read down a phone line or copied out of a screenshot without I/1, O/0 or
// U (which Crockford drops to avoid accidental profanity) causing support
// tickets. 20 characters of a 32-symbol alphabet is 100 bits of entropy, which
// makes guessing a valid key hopeless without needing a checksum.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I, L, O, U
const GROUPS = 4;
const GROUP_LEN = 5;
const PREFIX = 'AI3';

/** Cryptographically random licence key. */
export function generateKey() {
  const bytes = new Uint8Array(GROUPS * GROUP_LEN);
  crypto.getRandomValues(bytes);

  const groups = [];
  for (let g = 0; g < GROUPS; g++) {
    let out = '';
    for (let i = 0; i < GROUP_LEN; i++) {
      // Modulo bias over a 32-symbol alphabet from a 256-value byte is exactly
      // zero (256 = 8 * 32), so a plain modulo is uniform here.
      out += ALPHABET[bytes[g * GROUP_LEN + i] % ALPHABET.length];
    }
    groups.push(out);
  }
  return `${PREFIX}-${groups.join('-')}`;
}

/**
 * Normalise user-typed input into canonical form, or null if it cannot be one
 * of our keys.
 *
 * People paste keys with stray spaces, lowercase them, and lose the hyphens.
 * All of that is recoverable and none of it should read as "invalid key" —
 * a rejection here is indistinguishable to the user from not having paid.
 */
export function normalizeKey(input) {
  if (typeof input !== 'string') return null;

  const cleaned = input.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!cleaned.startsWith(PREFIX)) return null;

  const body = cleaned.slice(PREFIX.length);
  if (body.length !== GROUPS * GROUP_LEN) return null;
  if ([...body].some((c) => !ALPHABET.includes(c))) return null;

  const groups = [];
  for (let g = 0; g < GROUPS; g++) {
    groups.push(body.slice(g * GROUP_LEN, (g + 1) * GROUP_LEN));
  }
  return `${PREFIX}-${groups.join('-')}`;
}
