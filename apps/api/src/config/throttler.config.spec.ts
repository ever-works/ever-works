import type { ThrottlerOptions } from '@nestjs/throttler';
import { throttlerConfig } from './throttler.config';

// `ThrottlerModuleOptions` is a union (array OR object-with-throttlers). The
// concrete value here is the object form. Narrow once for the rest of the
// suite.
const cfg = throttlerConfig as { throttlers: ThrottlerOptions[] };

describe('throttlerConfig', () => {
    it('uses the object form (not the array shorthand) — has a `throttlers` field', () => {
        expect(Array.isArray(throttlerConfig)).toBe(false);
        expect(cfg.throttlers).toBeDefined();
        expect(Array.isArray(cfg.throttlers)).toBe(true);
        expect(cfg.throttlers.length).toBe(3);
    });

    it('exposes three named throttler tiers — short / medium / long', () => {
        expect(cfg.throttlers.map((t) => t.name)).toEqual(['short', 'medium', 'long']);
    });

    it('short tier: 50 req / 1s', () => {
        const tier = cfg.throttlers.find((t) => t.name === 'short');
        expect(tier).toEqual({ name: 'short', ttl: 1000, limit: 50 });
    });

    it('medium tier: 300 req / 10s', () => {
        const tier = cfg.throttlers.find((t) => t.name === 'medium');
        expect(tier).toEqual({ name: 'medium', ttl: 10000, limit: 300 });
    });

    it('long tier: 1000 req / 60s', () => {
        const tier = cfg.throttlers.find((t) => t.name === 'long');
        expect(tier).toEqual({ name: 'long', ttl: 60000, limit: 1000 });
    });

    it('all tiers have positive ttl and limit (numeric, not Resolvable functions)', () => {
        for (const tier of cfg.throttlers) {
            expect(typeof tier.ttl).toBe('number');
            expect(typeof tier.limit).toBe('number');
            expect(tier.ttl as number).toBeGreaterThan(0);
            expect(tier.limit as number).toBeGreaterThan(0);
        }
    });

    it('TTLs are monotonically increasing — short < medium < long', () => {
        const get = (name: string) => cfg.throttlers.find((t) => t.name === name)!.ttl as number;
        expect(get('short')).toBeLessThan(get('medium'));
        expect(get('medium')).toBeLessThan(get('long'));
    });

    it('limit values rise with the window — short.limit < medium.limit < long.limit', () => {
        const get = (name: string) =>
            cfg.throttlers.find((t) => t.name === name)!.limit as number;
        expect(get('short')).toBeLessThan(get('medium'));
        expect(get('medium')).toBeLessThan(get('long'));
    });

    it('does not configure global skipIf / errorMessage / storage / ignoreUserAgents', () => {
        const c = throttlerConfig as Record<string, unknown>;
        expect(c.skipIf).toBeUndefined();
        expect(c.errorMessage).toBeUndefined();
        expect(c.storage).toBeUndefined();
        expect(c.ignoreUserAgents).toBeUndefined();
    });
});
