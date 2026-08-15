import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every password rule the UI states must match the one the API enforces.
 *
 * The API requires 8 characters — `@MinLength(8)` on RegisterDto,
 * ResetPasswordDto and ClaimAccountDto in apps/api/src/auth/dto/auth.dto.ts,
 * whose own field description reads "min 8 chars".
 *
 * The reset-password flow told users 6. Its helper text said "Must be at least
 * 6 characters…" and its unused minLength error said the same, while the form
 * did no length check at all — so a 6-character password reached the server and
 * came back as a generic failure, with the on-screen hint still insisting 6 was
 * enough. A user resetting a password they had already lost could not read
 * their way out of it.
 *
 * This pins the CLASS of defect rather than the instance: any locale, any flow,
 * any future copy edit that states a different minimum will fail here.
 */
const MESSAGES_DIR = join(process.cwd(), 'messages');
const API_MIN_LENGTH = 8;

/**
 * Collect "at least N characters" claims that are about PASSWORDS.
 *
 * The path filter matters: Missions, Ideas and work prompts legitimately state
 * their own "at least 10 characters" minimums, and an unscoped sweep flags all
 * nine of them. Keying on the message path keeps this about the one policy the
 * API pins.
 */
function passwordLengthClaims(node: unknown, path = ''): Array<{ path: string; n: number }> {
    if (typeof node === 'string') {
        if (!/password/i.test(path)) return [];
        const m = node.match(/at least (\d+) characters/i);
        return m ? [{ path, n: Number(m[1]) }] : [];
    }
    if (node && typeof node === 'object') {
        return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
            passwordLengthClaims(v, path ? `${path}.${k}` : k),
        );
    }
    return [];
}

const localeFiles = readdirSync(MESSAGES_DIR).filter((f) => f.endsWith('.json'));

describe('password policy is stated consistently', () => {
    it('control: the locale corpus is actually being read', () => {
        // Guards against the whole suite passing because the glob found nothing
        // — a green run over zero files would look identical to a clean one.
        expect(localeFiles.length).toBeGreaterThan(0);
        const en = JSON.parse(readFileSync(join(MESSAGES_DIR, 'en.json'), 'utf-8'));
        expect(passwordLengthClaims(en).length).toBeGreaterThan(0);
    });

    it.each(localeFiles)('%s never promises a minimum other than the API-enforced 8', (file) => {
        const messages = JSON.parse(readFileSync(join(MESSAGES_DIR, file), 'utf-8'));
        const wrong = passwordLengthClaims(messages).filter((c) => c.n !== API_MIN_LENGTH);
        expect(
            wrong,
            `these strings state a password minimum the API does not enforce (@MinLength(${API_MIN_LENGTH})): ${wrong
                .map((w) => `${w.path}=${w.n}`)
                .join(', ')}`,
        ).toEqual([]);
    });
});
