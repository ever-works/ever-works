import { SharedView } from '../../entities/shared-view.entity';
import { generateShareToken, hashShareToken, isShareTokenShaped } from '../shared-view-token';

describe('share token', () => {
    it('is 43 URL-safe characters carrying 256 bits', () => {
        const token = generateShareToken();
        expect(token).toHaveLength(43);
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    });

    it('never repeats', () => {
        const seen = new Set(Array.from({ length: 200 }, () => generateShareToken()));
        expect(seen.size).toBe(200);
    });

    it('hashes to a stable lowercase sha256 hex digest', () => {
        const token = generateShareToken();
        const hash = hashShareToken(token);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(hashShareToken(token)).toBe(hash);
        expect(hashShareToken(generateShareToken())).not.toBe(hash);
        expect(hash).not.toContain(token);
    });

    it('accepts only the exact token shape', () => {
        expect(isShareTokenShaped(generateShareToken())).toBe(true);
        for (const value of [
            '',
            'short',
            'a'.repeat(42),
            'a'.repeat(44),
            `${'a'.repeat(42)}=`,
            `${'a'.repeat(42)}/`,
            `${'a'.repeat(42)} `,
            null,
            undefined,
            42,
            { token: 'a'.repeat(43) },
        ]) {
            expect(isShareTokenShaped(value)).toBe(false);
        }
    });

    it('keeps the raw token out of the lookup column of a serialised row', () => {
        const token = generateShareToken();
        const row = Object.assign(new SharedView(), {
            id: 'view-1',
            tokenHash: hashShareToken(token),
            tokenEncrypted: { token },
        });
        const { tokenEncrypted, ...withoutEnvelope } = row;
        expect(tokenEncrypted.token).toBe(token);
        expect(JSON.stringify(withoutEnvelope)).not.toContain(token);
    });
});
