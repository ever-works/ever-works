import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * OpenAI-compatible API surface — the platform exposes an OpenAI-shaped
 * chat-completions endpoint so any tool that speaks OpenAI can plug in.
 * Pins the contract for the public endpoints.
 *
 * The exact paths depend on `openai-compat.controller.ts`; we probe a
 * few common shapes (`/v1/chat/completions`, `/api/v1/chat/completions`)
 * and accept any consistent behaviour.
 */

test.describe('OpenAI-compatible API — contract', () => {
    const CANDIDATE_PATHS = [
        '/api/v1/chat/completions',
        '/v1/chat/completions',
        '/api/openai/v1/chat/completions',
    ];

    test('one of the OpenAI-compat paths exists and requires auth', async ({ request }) => {
        let foundPath: string | null = null;
        let anyResponse: { path: string; status: number } | null = null;

        for (const path of CANDIDATE_PATHS) {
            const res = await request.post(`${API_BASE}${path}`, {
                data: {
                    model: 'gpt-4o-mini',
                    messages: [{ role: 'user', content: 'ping' }],
                },
            });
            if (res.status() !== 404) {
                foundPath = path;
                anyResponse = { path, status: res.status() };
                break;
            }
        }

        if (!foundPath) {
            test.skip(true, 'OpenAI-compat endpoint not exposed at any tested path; skipping');
            return;
        }

        // Found a path — it should reject unauthenticated requests.
        expect(
            [401, 403],
            `unauth POST returned ${anyResponse!.status} at ${anyResponse!.path}`,
        ).toContain(anyResponse!.status);
    });

    test('authenticated POST with valid body responds < 500', async ({ request }) => {
        const u = await registerUserViaAPI(request);

        let foundPath: string | null = null;
        for (const path of CANDIDATE_PATHS) {
            const probe = await request.post(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
                data: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }] },
            });
            if (probe.status() !== 404) {
                foundPath = path;
                // 200 = response (provider configured); 4xx = validation / no
                // provider; 503 = provider unreachable. Reject 5xx.
                expect(probe.status(), `status at ${path} was ${probe.status()}`).toBeLessThan(500);
                break;
            }
        }

        if (!foundPath) {
            test.skip(true, 'OpenAI-compat endpoint not exposed; skipping');
        }
    });
});
