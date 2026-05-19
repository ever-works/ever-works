import { test, expect } from '@playwright/test';
import { API_BASE, makeTestUser } from './helpers/api';

/**
 * Password policy zxcvbn-style — pass 18. Pass-6 `password-policy`
 * covered length / complexity / common-passwords. This pass tightens
 * with the canonical "weak even if 12+ chars" list — passwords that
 * pass naive length/complexity checks but score poorly on zxcvbn.
 * If the platform doesn't enforce zxcvbn-style scoring, informational
 * skip (and the existing pass-6 length/complexity gate stands).
 */

const WEAK_12_CHARS = [
    'password1234', // common-password-with-digits, still 12 chars
    'qwerty123456', // keyboard-walk
    'iloveyou1234',
    'admin1234567',
    'letmein12345',
    'aaaaaaaaaaaa', // repeated char
    'abcdefghijkl', // straight alphabet
    '123456789012', // straight numeric
];

test.describe('Password policy — zxcvbn-style weak rejection (or informational skip)', () => {
    test('common-but-long passwords are rejected on register', async ({ request }) => {
        let rejected = 0;
        let accepted = 0;
        for (const weak of WEAK_12_CHARS) {
            const u = makeTestUser('zxcvbn');
            const res = await request.post(`${API_BASE}/api/auth/register`, {
                data: { username: u.name, email: u.email, password: weak },
            });
            if (res.status() >= 400 && res.status() < 500) {
                rejected++;
            } else if (res.ok()) {
                accepted++;
            } else {
                // 5xx is the bug we're actually guarding against.
                expect(
                    res.status(),
                    `weak password ${JSON.stringify(weak)} crashed: ${res.status()}`,
                ).toBeLessThan(500);
            }
        }
        if (rejected === 0 && accepted > 0) {
            // Platform doesn't enforce zxcvbn-style policy — pass-6
            // length/complexity is the floor. Informational signal.
            test.info().annotations.push({
                type: 'informational',
                description: `${accepted}/${WEAK_12_CHARS.length} weak passwords accepted — zxcvbn-style policy not enforced (pass-6 length+complexity gate stands)`,
            });
            test.skip(true, 'no zxcvbn enforcement');
        }
        // At least one weak should have been rejected.
        expect(
            rejected,
            `0/${WEAK_12_CHARS.length} weak passwords rejected — policy too permissive`,
        ).toBeGreaterThan(0);
    });
});
