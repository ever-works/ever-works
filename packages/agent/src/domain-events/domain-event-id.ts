import { randomBytes } from 'node:crypto';

/** Crockford base32, the ULID alphabet (no I, L, O, U). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A new event id, `evt_<ULID>` (26 Crockford base32 characters: 48-bit
 * millisecond timestamp + 80 random bits). Lexically sortable by creation time
 * to the millisecond, which keeps ids readable in logs; ordering guarantees
 * come from `seq`, never from the id.
 */
export function newDomainEventId(now: number = Date.now()): string {
    let time = '';
    let remaining = now;
    for (let i = 0; i < 10; i++) {
        time = ALPHABET[remaining % 32] + time;
        remaining = Math.floor(remaining / 32);
    }
    const bytes = randomBytes(10);
    // 80 random bits → 16 base32 characters, 5 bits at a time.
    let bits = 0;
    let value = 0;
    let random = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            random += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    return `evt_${time}${random}`;
}

/** The shape every event id has. */
export const DOMAIN_EVENT_ID_PATTERN = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;
