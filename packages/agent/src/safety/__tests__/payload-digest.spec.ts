import { canonicalJson, payloadDigest } from '../payload-digest';

describe('canonicalJson', () => {
    it('sorts object keys, so insertion order cannot change the digest', () => {
        expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    });

    it('sorts nested keys too', () => {
        expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe(
            canonicalJson({ outer: { a: 2, z: 1 } }),
        );
    });

    it('drops undefined rather than writing null for it', () => {
        // JSON.stringify drops an `undefined` value, so keeping it would make
        // an object hash differently from its own round-trip.
        expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    });

    it('keeps array order, because order is meaning in a recipient list', () => {
        expect(canonicalJson(['a', 'b'])).not.toBe(canonicalJson(['b', 'a']));
    });

    it('serialises a Date as an ISO string', () => {
        expect(canonicalJson({ at: new Date('2026-09-16T10:00:00.000Z') })).toBe(
            '{"at":"2026-09-16T10:00:00.000Z"}',
        );
    });

    it('writes null for null and for undefined at the root', () => {
        expect(canonicalJson(null)).toBe('null');
        expect(canonicalJson(undefined)).toBe('null');
    });
});

describe('payloadDigest', () => {
    it('is a 64-character hex string — the width of the stored column', () => {
        const digest = payloadDigest({ to: ['dana@example.test'], subject: 'hello' });
        expect(digest).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is independent of key order', () => {
        expect(payloadDigest({ subject: 'hi', to: ['a@b.test'] })).toBe(
            payloadDigest({ to: ['a@b.test'], subject: 'hi' }),
        );
    });

    it('changes when one byte changes', () => {
        // This is what makes "approving executes the exact thing" checkable:
        // a payload edited between hold and execution cannot run.
        const before = payloadDigest({ body: 'Please transfer 100' });
        const after = payloadDigest({ body: 'Please transfer 900' });
        expect(after).not.toBe(before);
    });

    it('changes when a field is added', () => {
        expect(payloadDigest({ to: ['a@b.test'] })).not.toBe(
            payloadDigest({ to: ['a@b.test'], bcc: ['c@d.test'] }),
        );
    });

    it('is stable across calls', () => {
        const payload = { to: ['a@b.test'], subject: 'hi', body: 'there' };
        expect(payloadDigest(payload)).toBe(payloadDigest(payload));
    });
});
