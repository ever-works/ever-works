import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('utils/constants module', () => {
    let originalApi: string | undefined;
    let originalWeb: string | undefined;

    beforeEach(() => {
        originalApi = process.env.API_URL;
        originalWeb = process.env.WEB_URL;
        vi.resetModules();
    });

    afterEach(() => {
        if (originalApi === undefined) delete process.env.API_URL;
        else process.env.API_URL = originalApi;
        if (originalWeb === undefined) delete process.env.WEB_URL;
        else process.env.WEB_URL = originalWeb;
        vi.resetModules();
    });

    it('falls back to localhost defaults when env vars are unset', async () => {
        delete process.env.API_URL;
        delete process.env.WEB_URL;
        const constants = await import('../constants');
        expect(constants.API_URL).toBe('http://localhost:3100');
        expect(constants.WEB_URL).toBe('http://localhost:3000');
    });

    it('uses API_URL env var when set', async () => {
        process.env.API_URL = 'https://api.example.com';
        process.env.WEB_URL = 'https://web.example.com';
        const constants = await import('../constants');
        expect(constants.API_URL).toBe('https://api.example.com');
        expect(constants.WEB_URL).toBe('https://web.example.com');
    });

    it('treats an empty-string env var as unset (uses default)', async () => {
        // The OR operator (`||`) coerces '' to falsy, so the default applies.
        process.env.API_URL = '';
        process.env.WEB_URL = '';
        const constants = await import('../constants');
        expect(constants.API_URL).toBe('http://localhost:3100');
        expect(constants.WEB_URL).toBe('http://localhost:3000');
    });
});
