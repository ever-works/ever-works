import { DEFAULT_TRUST_PROXY_HOPS, resolveTrustProxyHops } from './trust-proxy';

describe('resolveTrustProxyHops', () => {
    it('documents the default as a single nginx → pod hop', () => {
        expect(DEFAULT_TRUST_PROXY_HOPS).toBe(1);
    });

    describe('legit happy path — numeric env honoured', () => {
        it('returns the exact integer for a valid count', () => {
            expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '2' })).toBe(2);
        });

        it('accepts 0 (trust no proxy — direct socket IP)', () => {
            expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '0' })).toBe(0);
        });

        it('accepts larger multi-hop topologies', () => {
            expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '3' })).toBe(3);
        });

        it('tolerates surrounding whitespace', () => {
            expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '  2  ' })).toBe(2);
        });

        it('accepts an explicit leading + sign', () => {
            expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '+2' })).toBe(2);
        });
    });

    describe('sanitised path — fall back to the documented default', () => {
        it('falls back when the var is unset', () => {
            expect(resolveTrustProxyHops({})).toBe(DEFAULT_TRUST_PROXY_HOPS);
        });

        it('falls back on an empty string', () => {
            expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '' })).toBe(DEFAULT_TRUST_PROXY_HOPS);
        });

        it('falls back on whitespace-only', () => {
            expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '   ' })).toBe(
                DEFAULT_TRUST_PROXY_HOPS,
            );
        });

        it('falls back on non-numeric garbage', () => {
            expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: 'foo' })).toBe(
                DEFAULT_TRUST_PROXY_HOPS,
            );
        });

        it('falls back on a trailing-unit typo like "2hops"', () => {
            expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '2hops' })).toBe(
                DEFAULT_TRUST_PROXY_HOPS,
            );
        });

        it('falls back on a fractional value (Express wants an integer)', () => {
            expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '1.5' })).toBe(
                DEFAULT_TRUST_PROXY_HOPS,
            );
        });
    });

    describe('fail-closed clamp — negatives become 0 (trust nobody)', () => {
        it('clamps -1 to 0', () => {
            expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '-1' })).toBe(0);
        });

        it('clamps a large negative to 0', () => {
            expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '-100' })).toBe(0);
        });
    });

    it('always returns a finite, non-negative integer', () => {
        for (const value of ['2', '0', '-5', 'foo', '', '1.5', '+9', undefined]) {
            const result = resolveTrustProxyHops({ TRUST_PROXY_HOPS: value });
            expect(Number.isInteger(result)).toBe(true);
            expect(result).toBeGreaterThanOrEqual(0);
        }
    });
});
