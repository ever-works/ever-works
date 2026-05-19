import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Concurrent conflicts — pass 7. Two simultaneous updates to the same
 * work should land in a sane terminal state:
 *   - Both 2xx (last write wins) OR
 *   - One 2xx + one 409/412 (optimistic locking)
 *
 * What's NOT acceptable: one 5xx, or both succeed AND the result is
 * a frankenstein merge of both updates.
 */

test.describe('Concurrent update — same work, two writers', () => {
    test('two parallel PUTs land in a consistent final state', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `concurrent-${Date.now().toString(36)}`,
        });
        const nameA = `update-A-${Date.now().toString(36)}`;
        const nameB = `update-B-${Date.now().toString(36)}`;
        const [r1, r2] = await Promise.all([
            request.put(`${API_BASE}/api/works/${w.id}`, {
                headers: authedHeaders(u.access_token),
                data: { name: nameA, description: 'A' },
            }),
            request.put(`${API_BASE}/api/works/${w.id}`, {
                headers: authedHeaders(u.access_token),
                data: { name: nameB, description: 'B' },
            }),
        ]);
        // Neither response is allowed to 5xx.
        expect(r1.status()).toBeLessThan(500);
        expect(r2.status()).toBeLessThan(500);
        // At least one must have succeeded.
        const oneSucceeded = r1.status() < 300 || r2.status() < 300;
        expect(oneSucceeded, 'neither concurrent update succeeded').toBe(true);

        // The final state must be a CLEAN choice of one update, not a
        // half-merged value. Read it back and require name to match one
        // of the two writes (or stay at the original — last-success-wins
        // with both rejected is unusual but technically OK).
        const detail = await request.get(`${API_BASE}/api/works/${w.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(detail.status()).toBe(200);
        const body = await detail.json();
        const finalName = body?.name ?? body?.work?.name ?? body?.data?.name;
        expect(typeof finalName).toBe('string');
        const validFinal =
            finalName === nameA ||
            finalName === nameB ||
            // Original starting prefix.
            finalName?.startsWith('concurrent-');
        expect(
            validFinal,
            `final name "${finalName}" is neither A, B, nor original — frankenstein merge?`,
        ).toBe(true);
    });

    test('two parallel PATCH-style partial updates do not 5xx', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, u.access_token, {
            name: `patch-conflict-${Date.now().toString(36)}`,
        });
        // Patch different fields — least-conflicting case.
        const [r1, r2] = await Promise.all([
            request.put(`${API_BASE}/api/works/${w.id}`, {
                headers: authedHeaders(u.access_token),
                data: { description: 'desc from A' },
            }),
            request.put(`${API_BASE}/api/works/${w.id}`, {
                headers: authedHeaders(u.access_token),
                data: { description: 'desc from B' },
            }),
        ]);
        expect(r1.status()).toBeLessThan(500);
        expect(r2.status()).toBeLessThan(500);
    });
});

test.describe('Concurrent update — stranger never wins the race', () => {
    test("two concurrent PUTs (one owner, one stranger) — stranger's MUST NOT take effect", async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, owner.access_token, {
            name: `race-iso-${Date.now().toString(36)}`,
        });
        const stranger = await registerUserViaAPI(request);
        const ownerName = `owner-write-${Date.now().toString(36)}`;
        const strangerName = `stranger-injection-${Date.now().toString(36)}`;
        await Promise.all([
            request.put(`${API_BASE}/api/works/${w.id}`, {
                headers: authedHeaders(owner.access_token),
                data: { name: ownerName },
            }),
            request.put(`${API_BASE}/api/works/${w.id}`, {
                headers: authedHeaders(stranger.access_token),
                data: { name: strangerName },
            }),
        ]);
        const detail = await request.get(`${API_BASE}/api/works/${w.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(detail.status()).toBe(200);
        const body = await detail.json();
        const finalName = body?.name ?? body?.work?.name ?? body?.data?.name;
        // The stranger's write MUST be rejected — final name cannot
        // carry the stranger-injection payload.
        expect(
            String(finalName ?? '').includes('stranger-injection'),
            `stranger's concurrent write landed in DB: final name is "${finalName}"`,
        ).toBe(false);
    });
});
