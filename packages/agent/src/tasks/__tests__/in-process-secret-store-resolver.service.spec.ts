import { Logger } from '@nestjs/common';
import { InProcessSecretStoreResolver } from '../in-process-secret-store-resolver.service';

/**
 * EW-742 P3.2 — default `InProcessSecretStoreResolver` unit tests.
 *
 * Covers the seven branches the default resolver supports:
 *   - unknown scheme → null + Logger.warn
 *   - inline: empty payload → null + Logger.warn
 *   - inline: base64-decode error → null + Logger.warn
 *   - inline: not JSON → null + Logger.warn
 *   - inline: JSON null → null + Logger.warn
 *   - inline: JSON array → null + Logger.warn (must be object)
 *   - inline: JSON object → returns the parsed bag
 */
describe('InProcessSecretStoreResolver (EW-742 P3.2)', () => {
    let resolver: InProcessSecretStoreResolver;
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
        resolver = new InProcessSecretStoreResolver();
        warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

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
