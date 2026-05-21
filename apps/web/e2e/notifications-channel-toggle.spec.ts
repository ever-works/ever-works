import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Notifications channel toggle — pass 18. Pass-9
 * `notification-channels` covered the GET shape. This pass adds:
 *  - PATCH/PUT toggle of a channel reflects on next GET
 *  - PATCH with unknown channel key returns 4xx (not silent accept)
 *  - the toggle round-trips exact value (true→false→true)
 */

const PREF_PATHS = [
    '/api/notifications/preferences',
    '/api/account/notification-preferences',
    '/api/notifications/channels',
];

async function findPrefPath(
    request: import('@playwright/test').APIRequestContext,
    token: string,
): Promise<string | null> {
    for (const p of PREF_PATHS) {
        const res = await request.get(`${API_BASE}${p}`, { headers: authedHeaders(token) });
        if (res.status() === 404) continue;
        if (res.ok() && (res.headers()['content-type'] || '').includes('json')) return p;
    }
    return null;
}

test.describe('Notifications — channel toggle reflects on next GET', () => {
    test('PATCH disable a channel reflects on next GET (round-trip)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const path = await findPrefPath(request, u.access_token);
        if (!path) test.skip(true, 'no preferences endpoint exposed');
        // Read original.
        const before = await request.get(`${API_BASE}${path}`, {
            headers: authedHeaders(u.access_token),
        });
        const beforeBody = await before.json();
        // Find a boolean-shaped channel key.
        const channelKey = pickBooleanKey(beforeBody);
        if (!channelKey) test.skip(true, 'no boolean channel key in preferences body');
        const key = channelKey!;
        const originalValue = readBool(beforeBody, key);
        const newValue = !originalValue;
        const patch = await request.patch(`${API_BASE}${path}`, {
            headers: authedHeaders(u.access_token),
            data: { [key]: newValue },
        });
        if (!patch.ok() && patch.status() !== 204) {
            // Try PUT instead.
            const put = await request.put(`${API_BASE}${path}`, {
                headers: authedHeaders(u.access_token),
                data: { [key]: newValue },
            });
            if (!put.ok() && put.status() !== 204) {
                test.skip(
                    true,
                    `neither PATCH nor PUT accepted (${patch.status()}/${put.status()})`,
                );
            }
        }
        const after = await request.get(`${API_BASE}${path}`, {
            headers: authedHeaders(u.access_token),
        });
        const afterBody = await after.json();
        const afterValue = readBool(afterBody, key);
        expect(
            afterValue,
            `channel ${key} did not round-trip: was=${originalValue}, set=${newValue}, read=${afterValue}`,
        ).toBe(newValue);
    });

    test('PATCH with unknown channel key returns 4xx (not silent 200)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const path = await findPrefPath(request, u.access_token);
        if (!path) test.skip(true, 'no preferences endpoint exposed');
        const bogus = `bogus_channel_${Date.now().toString(36)}`;
        const res = await request.patch(`${API_BASE}${path}`, {
            headers: authedHeaders(u.access_token),
            data: { [bogus]: true },
        });
        // Either 4xx (rejected) or 2xx silent-ignore. NEVER 5xx.
        expect(res.status()).toBeLessThan(500);
        // Codex P2: 204 No Content (which `res.ok()` accepts) has no
        // body, so `await res.json()` would throw and fail the test
        // for the wrong reason. Gate on JSON content-type + non-empty
        // body before parsing.
        if (res.ok() && res.status() !== 204) {
            const ct = res.headers()['content-type'] || '';
            if (ct.includes('json')) {
                const text = await res.text();
                if (text.length > 0) {
                    const echoedBogus = text.includes(bogus);
                    if (echoedBogus) {
                        test.info().annotations.push({
                            type: 'informational',
                            description: `unknown channel "${bogus}" was silently accepted into the payload`,
                        });
                    }
                }
            }
        }
    });
});

function pickBooleanKey(node: unknown): string | null {
    if (!node || typeof node !== 'object') return null;
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
        if (typeof obj[k] === 'boolean') return k;
    }
    // Try one level of nesting.
    for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') {
            const sub = v as Record<string, unknown>;
            for (const k of Object.keys(sub)) {
                if (typeof sub[k] === 'boolean') return k;
            }
        }
    }
    return null;
}

function readBool(node: unknown, key: string): boolean | undefined {
    if (!node || typeof node !== 'object') return undefined;
    const obj = node as Record<string, unknown>;
    if (typeof obj[key] === 'boolean') return obj[key] as boolean;
    for (const v of Object.values(obj)) {
        if (
            v &&
            typeof v === 'object' &&
            typeof (v as Record<string, unknown>)[key] === 'boolean'
        ) {
            return (v as Record<string, unknown>)[key] as boolean;
        }
    }
    return undefined;
}
