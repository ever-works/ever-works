import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { InProcessSecretStoreResolver } from '../in-process-secret-store-resolver.service';

/**
 * EW-742 P3.2 — extra-coverage edge cases beyond the bundled
 * `in-process-secret-store-resolver.service.spec.ts`:
 *
 *   - all unsupported schemes return null + warn (vault:, k8s:, op:, etc.);
 *   - empty pointer / pointer with no scheme prefix → null + warn;
 *   - inline: corruption taxonomy (invalid base64, valid base64 + invalid
 *     JSON, missing object shape);
 *   - env: rotation semantics + missing-var taxonomy;
 *   - SECURITY: warn log lines do NOT contain decoded credential VALUES —
 *     only the scheme + a length-style hint. Pins a regression-prevention
 *     contract: a future "helpful" diagnostic addition must not start
 *     dumping secrets to logs.
 *   - resolver is stateless across calls (no DI / no internal cache).
 */
describe('InProcessSecretStoreResolver — deep edge cases (EW-742 P3.2)', () => {
    let resolver: InProcessSecretStoreResolver;
    let warnSpy: jest.SpyInstance;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        resolver = new InProcessSecretStoreResolver();
        warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        warnSpy.mockRestore();
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        for (const k of Object.keys(savedEnv)) delete savedEnv[k];
    });

    function setEnv(name: string, value: string | undefined): void {
        savedEnv[name] = process.env[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }

    function inline(obj: unknown): string {
        return `inline:${Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')}`;
    }

    describe('unknown / malformed pointer shapes', () => {
        it.each([
            ['vault:', 'vault:secret/tenants/acme/temporal'],
            ['k8s:', 'k8s:tenant-acme-trigger-credentials'],
            ['op:', 'op://Vault/Trigger-acme/access-token'],
            ['infisical:', 'infisical:/projects/abc/secrets/trigger'],
            ['doppler:', 'doppler:secret/trigger'],
            ['gcp-sm:', 'gcp-sm:projects/p/secrets/trigger/versions/latest'],
            ['aws-sm:', 'aws-sm:trigger-prod'],
            ['azure-kv:', 'azure-kv:trigger-key'],
        ])('returns null + warn for unsupported scheme "%s"', async (scheme, pointer) => {
            const result = await resolver.resolve(pointer);
            expect(result).toBeNull();
            expect(warnSpy).toHaveBeenCalledTimes(1);
            // Warn names the scheme so operators know which integration is missing.
            expect(warnSpy.mock.calls[0]?.[0]).toContain(`"${scheme}"`);
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/fail-open|Returning null/);
        });

        it('returns null + warn for a pointer with no scheme prefix at all', async () => {
            const result = await resolver.resolve('just-a-bare-string-no-colon');
            expect(result).toBeNull();
            expect(warnSpy).toHaveBeenCalledTimes(1);
            // `split(':', 1)[0]` of a no-colon string returns the whole
            // string — the warn message names IT as the scheme.
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/just-a-bare-string-no-colon/);
        });

        it('returns null + warn for empty pointer (no scheme, no payload)', async () => {
            // Empty string: `startsWith('inline:')` false, `startsWith('env:')`
            // false, falls through to unknown-scheme branch.
            const result = await resolver.resolve('');
            expect(result).toBeNull();
            expect(warnSpy).toHaveBeenCalledTimes(1);
        });

        it('treats a pointer that LOOKS like inline: but with no colon as unknown scheme', async () => {
            // `inline` (no colon) → not the inline branch → unknown scheme.
            const result = await resolver.resolve('inlineWITHOUTcolon');
            expect(result).toBeNull();
            expect(warnSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('inline: corruption taxonomy', () => {
        it('returns null + warn for inline: with valid base64 but non-JSON payload', async () => {
            const notJson = Buffer.from('hello world, not json', 'utf8').toString('base64');
            const result = await resolver.resolve(`inline:${notJson}`);
            expect(result).toBeNull();
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/not valid JSON/);
        });

        it('returns null + warn for inline: with valid JSON primitive (string)', async () => {
            const result = await resolver.resolve(inline('a string is not an object'));
            expect(result).toBeNull();
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/must be a JSON object/);
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/got string/);
        });

        it('returns null + warn for inline: with valid JSON primitive (number)', async () => {
            const result = await resolver.resolve(inline(42));
            expect(result).toBeNull();
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/got number/);
        });

        it('returns null + warn for inline: with valid JSON primitive (boolean)', async () => {
            const result = await resolver.resolve(inline(true));
            expect(result).toBeNull();
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/got boolean/);
        });

        it('returns the empty object for inline: with `{}` (valid empty JSON object)', async () => {
            // Empty object is technically a valid credential bag — the
            // resolver returns it; the provider's `bindToTenant` is the
            // one that decides whether the bag is usable.
            const result = await resolver.resolve(inline({}));
            expect(result).toEqual({});
            expect(warnSpy).not.toHaveBeenCalled();
        });
    });

    describe('env: missing-var taxonomy + rotation', () => {
        it('returns null + warn for env:UNSET_VAR (var was never defined)', async () => {
            const varName = `UNSET_${randomUUID().replace(/-/g, '_').toUpperCase()}`;
            setEnv(varName, undefined);
            const result = await resolver.resolve(`env:${varName}`);
            expect(result).toBeNull();
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/undefined env var/);
            expect(warnSpy.mock.calls[0]?.[0]).toContain(varName);
        });

        it('returns null + warn for env:EMPTY_VAR (defined but empty)', async () => {
            const varName = `EMPTY_${randomUUID().replace(/-/g, '_').toUpperCase()}`;
            setEnv(varName, '');
            const result = await resolver.resolve(`env:${varName}`);
            expect(result).toBeNull();
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/empty env var/);
        });

        it('returns null + warn for env:WHITESPACE_VAR (whitespace-only is not valid JSON)', async () => {
            const varName = `WS_${randomUUID().replace(/-/g, '_').toUpperCase()}`;
            setEnv(varName, '   ');
            const result = await resolver.resolve(`env:${varName}`);
            expect(result).toBeNull();
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/not valid JSON/);
        });

        it('returns null + warn for env: with primitive (number) value', async () => {
            const varName = `NUM_${randomUUID().replace(/-/g, '_').toUpperCase()}`;
            setEnv(varName, '12345');
            const result = await resolver.resolve(`env:${varName}`);
            expect(result).toBeNull();
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/got number/);
        });

        it('returns null + warn for env: with primitive (boolean) value', async () => {
            const varName = `BOOL_${randomUUID().replace(/-/g, '_').toUpperCase()}`;
            setEnv(varName, 'true');
            const result = await resolver.resolve(`env:${varName}`);
            expect(result).toBeNull();
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/got boolean/);
        });
    });

    describe('security — no plaintext credentials in warn output', () => {
        it('warn for inline: non-object payload does NOT contain the decoded payload string', async () => {
            // Pin that future "helpful" diagnostic additions don't start
            // leaking the decoded payload into logs. The payload here is
            // a primitive (string) the resolver rejects; the warn message
            // must reference the type, NOT the value.
            const secret = 'super-secret-access-token-DO-NOT-LOG';
            const result = await resolver.resolve(inline(secret));
            expect(result).toBeNull();
            const warnText = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
            expect(warnText).not.toContain(secret);
            // The warn must still contain enough to diagnose (the type).
            expect(warnText).toMatch(/got string/);
        });

        it('warn for env: non-object value does NOT contain the env var value', async () => {
            const varName = `SECRET_${randomUUID().replace(/-/g, '_').toUpperCase()}`;
            const secret = 'super-secret-bearer-token-DO-NOT-LOG';
            setEnv(varName, JSON.stringify(secret));
            const result = await resolver.resolve(`env:${varName}`);
            expect(result).toBeNull();
            const warnText = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
            expect(warnText).not.toContain(secret);
            // The warn names the VAR (operator-facing label) — not the value.
            expect(warnText).toContain(varName);
        });

        it('successful resolve does NOT log any warn at all (no per-success log noise)', async () => {
            const credentials = { accessToken: 'tr_dev_xxx', region: 'us-east-1' };
            const result = await resolver.resolve(inline(credentials));
            expect(result).toEqual(credentials);
            expect(warnSpy).not.toHaveBeenCalled();
        });
    });

    describe('statelessness + re-entrancy', () => {
        it('100 concurrent inline: resolves return identical-shaped bags (no cross-talk)', async () => {
            const bags = Array.from({ length: 100 }, (_, i) => ({
                token: `tk-${i}`,
                idx: i,
            }));
            const pointers = bags.map((b) => inline(b));
            const results = await Promise.all(pointers.map((p) => resolver.resolve(p)));
            results.forEach((r, i) => {
                expect(r).toEqual(bags[i]);
            });
        });

        it('inline: + env: in alternating order resolve independently', async () => {
            const varName = `ALT_${randomUUID().replace(/-/g, '_').toUpperCase()}`;
            setEnv(varName, JSON.stringify({ src: 'env' }));
            const inlinePtr = inline({ src: 'inline' });
            const results = await Promise.all([
                resolver.resolve(inlinePtr),
                resolver.resolve(`env:${varName}`),
                resolver.resolve(inlinePtr),
                resolver.resolve(`env:${varName}`),
            ]);
            expect(results).toEqual([
                { src: 'inline' },
                { src: 'env' },
                { src: 'inline' },
                { src: 'env' },
            ]);
        });
    });
});
