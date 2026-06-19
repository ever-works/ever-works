import { Logger } from '@nestjs/common';
import { InProcessSecretStoreResolver } from '../in-process-secret-store-resolver.service';

/**
 * EW-742 P3.2 — default `InProcessSecretStoreResolver` unit tests.
 *
 * Covers both supported schemes (`inline:` + `env:`) and the fail-open
 * fallback for unknown schemes:
 *   - unknown scheme → null + Logger.warn
 *   - inline: empty payload / base64-decode error / not JSON / null /
 *     array → null + Logger.warn
 *   - inline: valid JSON object → returns the parsed bag
 *   - env: empty var name → null + Logger.warn
 *   - env: undefined env var → null + Logger.warn
 *   - env: empty-string env var → null + Logger.warn
 *   - env: not JSON / null / array → null + Logger.warn
 *   - env: valid JSON object → returns the parsed bag
 */
describe('InProcessSecretStoreResolver (EW-742 P3.2)', () => {
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

    it('returns null + warn for unknown scheme', async () => {
        const result = await resolver.resolve('vault:secret/tenants/acme/temporal');
        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/pointer scheme "vault:"/);
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/fail-open/);
    });

    describe('env: scheme', () => {
        it('returns null + warn when var name is empty (env:)', async () => {
            const result = await resolver.resolve('env:');
            expect(result).toBeNull();
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/empty var name/);
        });

        it('returns null + warn when env var is undefined', async () => {
            setEnv('NEVER_DEFINED_VAR_FOR_TESTS', undefined);
            const result = await resolver.resolve('env:NEVER_DEFINED_VAR_FOR_TESTS');
            expect(result).toBeNull();
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/undefined env var/);
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/NEVER_DEFINED_VAR_FOR_TESTS/);
        });

        it('returns null + warn when env var is empty string', async () => {
            setEnv('EMPTY_VAR_FOR_TESTS', '');
            const result = await resolver.resolve('env:EMPTY_VAR_FOR_TESTS');
            expect(result).toBeNull();
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/empty env var/);
        });

        it('returns null + warn when env var value is not JSON', async () => {
            setEnv('NOT_JSON_VAR', 'plain string, not json');
            const result = await resolver.resolve('env:NOT_JSON_VAR');
            expect(result).toBeNull();
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/not valid JSON/);
        });

        it('returns null + warn when env var value is JSON null', async () => {
            setEnv('NULL_VAR', 'null');
            const result = await resolver.resolve('env:NULL_VAR');
            expect(result).toBeNull();
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/got null/);
        });

        it('returns null + warn when env var value is JSON array', async () => {
            setEnv('ARRAY_VAR', '[1, 2, 3]');
            const result = await resolver.resolve('env:ARRAY_VAR');
            expect(result).toBeNull();
            expect(warnSpy.mock.calls[0]?.[0]).toMatch(/got array/);
        });

        it('returns the parsed bag for a well-formed env: object', async () => {
            const credentials = { accessToken: 'tr_dev_xxx', region: 'us-east-1' };
            setEnv('TENANT_ACME_TRIGGER', JSON.stringify(credentials));
            const result = await resolver.resolve('env:TENANT_ACME_TRIGGER');
            expect(result).toEqual(credentials);
            expect(warnSpy).not.toHaveBeenCalled();
        });

        it('re-reads env var on every call (rotation-friendly)', async () => {
            setEnv('ROTATING_VAR', JSON.stringify({ v: 1 }));
            const before = await resolver.resolve('env:ROTATING_VAR');
            expect(before).toEqual({ v: 1 });

            // Operator rotates the value in-place (e.g. via pod rolling
            // restart). Next resolve picks it up.
            process.env.ROTATING_VAR = JSON.stringify({ v: 2 });
            const after = await resolver.resolve('env:ROTATING_VAR');
            expect(after).toEqual({ v: 2 });
        });
    });

    it('returns null + warn for empty inline: payload', async () => {
        const result = await resolver.resolve('inline:');
        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/empty payload/);
    });

    it('returns null + warn when base64 decode produces invalid utf8 JSON', async () => {
        // base64 of binary garbage that's not utf8 JSON
        const result = await resolver.resolve('inline:!!!not-valid-base64-or-json!!!');
        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        // Could be either the base64-decode error OR the JSON-parse
        // error depending on how Node tolerates the input.
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/base64-decode failed|not valid JSON/);
    });

    it('returns null + warn when payload is not JSON', async () => {
        const notJson = Buffer.from('this is not JSON at all', 'utf8').toString('base64');
        const result = await resolver.resolve(`inline:${notJson}`);
        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/not valid JSON/);
    });

    it('returns null + warn when payload is JSON null', async () => {
        const result = await resolver.resolve(inline(null));
        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/must be a JSON object/);
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/got null/);
    });

    it('returns null + warn when payload is JSON array (must be object)', async () => {
        const result = await resolver.resolve(inline(['a', 'b']));
        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/got array/);
    });

    it('returns the parsed bag for a well-formed inline: object', async () => {
        const credentials = { accessToken: 'tr_dev_xxx', region: 'us-east-1' };
        const result = await resolver.resolve(inline(credentials));
        expect(result).toEqual(credentials);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('preserves nested values in the parsed bag', async () => {
        const credentials = {
            token: 'abc',
            tls: { ca: '-----BEGIN CERTIFICATE-----...', clientCert: 'x', clientKey: 'y' },
            tags: ['prod', 'us'],
        };
        const result = await resolver.resolve(inline(credentials));
        expect(result).toEqual(credentials);
    });
});
