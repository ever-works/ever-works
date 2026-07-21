/**
 * Agent Scorecards — the `scorecard` field on Agents, DEEP end-to-end.
 *
 * Agent Scorecards increment 1 shipped a quantified-goals model
 * (`AgentScorecardMetric[]`, a nullable `simple-json` column on
 * `agents.scorecard`) with manual editing + display, but no dedicated
 * e2e coverage. This file drives the real API against a live stack and
 * pins the true response shapes + status codes, covering:
 *
 *   • create/read contract — a plain Agent defaults `scorecard: null`;
 *     POST /api/agents REJECTS an inline `scorecard` (the CreateAgentDto
 *     has NO such field, and the global ValidationPipe runs
 *     forbidNonWhitelisted → 400 "property scorecard should not exist").
 *     Scorecards are set exclusively via PATCH.
 *   • PATCH persists a full metric verbatim (key/label/target/current/
 *     period + optional floor/stretch/unit); GET round-trips it
 *     byte-for-byte; the index list also carries the field.
 *   • JSON-column fidelity — unset optionals are OMITTED (not coerced to
 *     null); an EXPLICIT null floor/stretch/unit round-trips as null;
 *     negative / zero / decimal numbers survive; array order is preserved.
 *   • replace / clear semantics — PATCH is a whole-array REPLACE (no
 *     merge); `[]` and `null` both normalize the stored value to null;
 *     an omitted `scorecard` on PATCH leaves an existing one untouched.
 *   • validation (400) — DTO-level (class-validator, per-index messages):
 *     bad kebab key, non-finite/non-number target, unknown period, empty
 *     label, key > 64 / label > 80 / unit > 20, floor-not-a-number, a
 *     nested unknown property, a non-array value. Service-level
 *     (validateScorecard, single-string message): > 12 metrics, duplicate
 *     keys. Exactly 12 metrics is the accepted boundary.
 *   • auth + ownership isolation — unauth PATCH 401; a non-owner cannot
 *     GET or PATCH another user's Agent (404, never 403 — no existence
 *     leak); unknown-but-valid uuid 404; malformed uuid 400 (ParseUUIDPipe).
 *
 * ── Verified live against http://127.0.0.1:3100 (sqlite in-memory — the
 *    CI driver) before assertions were written. See
 *    apps/api/src/agents/dto/agent.dto.ts (AgentScorecardMetricDto) +
 *    packages/agent/src/agents/scorecard.ts (validateScorecard) for the
 *    contract, and packages/agent/src/agents/agents.service.ts (update)
 *    for the `[]`/null → null normalization.
 *
 * Isolation discipline: every test builds FRESH registerUserViaAPI()
 * owners + their own tenant-scoped Agents. Fully API-orchestrated (safe
 * `flow-` prefix, not matched by the no-auth testIgnore regex), so it
 * never contends on the UI or shared auth state.
 */
import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

interface ScorecardMetric {
    key: string;
    label: string;
    target: number;
    current: number;
    floor?: number | null;
    stretch?: number | null;
    unit?: string | null;
    period: 'weekly' | 'monthly' | 'quarterly';
}

const stamp = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Register a fresh user and return its bearer token. */
async function freshToken(request: APIRequestContext): Promise<string> {
    return (await registerUserViaAPI(request)).access_token;
}

/** Create a tenant-scoped Agent and return its full DTO (raw JSON). */
async function createAgentRaw(
    request: APIRequestContext,
    token: string,
    name: string,
): Promise<Record<string, unknown> & { id: string }> {
    const res = await request.post(`${API_BASE}/api/agents`, {
        headers: authedHeaders(token),
        data: { scope: 'tenant', name },
    });
    expect(res.status(), `createAgent body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

function patchAgent(
    request: APIRequestContext,
    token: string,
    id: string,
    data: Record<string, unknown>,
): Promise<APIResponse> {
    return request.patch(`${API_BASE}/api/agents/${id}`, { headers: authedHeaders(token), data });
}

async function getAgent(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<Record<string, unknown> & { scorecard: ScorecardMetric[] | null }> {
    const res = await request.get(`${API_BASE}/api/agents/${id}`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return res.json();
}

/** Robustly stringify the error `message` (string OR string[]) for substring checks. */
async function messageText(res: APIResponse): Promise<string> {
    const body = await res.json().catch(() => ({}));
    return JSON.stringify((body as { message?: unknown }).message ?? body);
}

test.describe('Agent Scorecards — create/read contract', () => {
    test('a fresh Agent defaults scorecard:null; POST rejects an inline scorecard (forbidNonWhitelisted)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `Plain ${stamp()}`);
        expect(agent.id).toMatch(UUID_RE);
        // The create DTO has no scorecard field → the column defaults to null.
        expect(agent.scorecard).toBeNull();

        // Sending scorecard on POST is rejected outright (not silently stripped).
        const rejected = await request.post(`${API_BASE}/api/agents`, {
            headers: authedHeaders(token),
            data: {
                scope: 'tenant',
                name: `Inline ${stamp()}`,
                scorecard: [{ key: 'k', label: 'L', target: 1, current: 0, period: 'weekly' }],
            },
        });
        expect(rejected.status()).toBe(400);
        expect(await messageText(rejected)).toContain('scorecard');
    });

    test('PATCH persists a full metric verbatim and GET round-trips it identically', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `Full ${stamp()}`);
        const metric: ScorecardMetric = {
            key: 'weekly-signups',
            label: 'Weekly signups',
            target: 100,
            current: 40,
            floor: 10,
            stretch: 200,
            unit: 'users',
            period: 'weekly',
        };
        const res = await patchAgent(request, token, agent.id, { scorecard: [metric] });
        expect(res.status(), `patch body=${await res.text().catch(() => '')}`).toBe(200);
        const patched = await res.json();
        expect(patched.scorecard).toEqual([metric]);

        // GET must return the exact same array — no reshaping on read.
        const fetched = await getAgent(request, token, agent.id);
        expect(fetched.scorecard).toEqual([metric]);
    });

    test('unset optional fields are OMITTED on the stored metric (not coerced to null)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `Bare ${stamp()}`);
        // First metric carries optionals; the second omits all three.
        const withOpts: ScorecardMetric = {
            key: 'mrr',
            label: 'MRR',
            target: 5000,
            current: 1200,
            floor: 1000,
            stretch: 8000,
            unit: '$',
            period: 'monthly',
        };
        const bare: ScorecardMetric = {
            key: 'nps',
            label: 'NPS',
            target: 50,
            current: 30,
            period: 'quarterly',
        };
        const res = await patchAgent(request, token, agent.id, { scorecard: [withOpts, bare] });
        expect(res.status()).toBe(200);
        const sc = (await res.json()).scorecard as ScorecardMetric[];
        expect(sc).toHaveLength(2);
        // The bare metric has no floor/stretch/unit KEYS at all.
        expect(sc[1]).not.toHaveProperty('floor');
        expect(sc[1]).not.toHaveProperty('stretch');
        expect(sc[1]).not.toHaveProperty('unit');
        // The rich one keeps every optional.
        expect(sc[0].floor).toBe(1000);
        expect(sc[0].stretch).toBe(8000);
        expect(sc[0].unit).toBe('$');
    });

    test('an EXPLICIT null floor/stretch/unit round-trips as null (keys present, value null)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `Null ${stamp()}`);
        const metric = {
            key: 'k',
            label: 'X',
            target: 1,
            current: 0,
            period: 'weekly',
            floor: null,
            stretch: null,
            unit: null,
        };
        const res = await patchAgent(request, token, agent.id, { scorecard: [metric] });
        expect(res.status()).toBe(200);
        const stored = (await res.json()).scorecard[0];
        expect(stored).toHaveProperty('floor');
        expect(stored.floor).toBeNull();
        expect(stored.stretch).toBeNull();
        expect(stored.unit).toBeNull();
    });

    test('negative, zero, and decimal target/current/floor/stretch are all preserved', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `Nums ${stamp()}`);
        const metric: ScorecardMetric = {
            key: 'burn-rate',
            label: 'Burn rate',
            target: -5,
            current: -10.5,
            floor: -20,
            stretch: 0,
            period: 'quarterly',
        };
        const res = await patchAgent(request, token, agent.id, { scorecard: [metric] });
        expect(res.status()).toBe(200);
        expect((await res.json()).scorecard[0]).toEqual(metric);
    });

    test('metric ARRAY ORDER is preserved end-to-end', async ({ request }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `Order ${stamp()}`);
        const keys = ['zeta', 'alpha', 'mike', 'bravo'];
        const scorecard = keys.map((key, i) => ({
            key,
            label: `Metric ${i}`,
            target: 10,
            current: i,
            period: 'weekly' as const,
        }));
        const res = await patchAgent(request, token, agent.id, { scorecard });
        expect(res.status()).toBe(200);
        const fetched = await getAgent(request, token, agent.id);
        expect((fetched.scorecard ?? []).map((m) => m.key)).toEqual(keys);
    });

    test('the index list (GET /api/agents) carries the scorecard field for the Agent', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `Listed ${stamp()}`);
        await patchAgent(request, token, agent.id, {
            scorecard: [
                {
                    key: 'prs-merged',
                    label: 'PRs merged',
                    target: 20,
                    current: 7,
                    period: 'weekly',
                },
            ],
        });
        const listed = await request.get(`${API_BASE}/api/agents?limit=200`, {
            headers: authedHeaders(token),
        });
        expect(listed.status()).toBe(200);
        const rows = (await listed.json()).data as Array<Record<string, unknown> & { id: string }>;
        const mine = rows.find((r) => r.id === agent.id);
        expect(mine, 'created agent should appear in the list').toBeTruthy();
        const sc = mine!.scorecard as ScorecardMetric[] | null;
        expect((sc ?? []).map((m) => m.key)).toContain('prs-merged');
    });
});

test.describe('Agent Scorecards — replace / clear semantics', () => {
    test('PATCH is a whole-array REPLACE — a new scorecard supersedes the old one (no merge)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `Replace ${stamp()}`);
        await patchAgent(request, token, agent.id, {
            scorecard: [
                { key: 'a', label: 'A', target: 1, current: 0, period: 'weekly' },
                { key: 'b', label: 'B', target: 2, current: 0, period: 'weekly' },
            ],
        });
        // Replace with a single different metric.
        const res = await patchAgent(request, token, agent.id, {
            scorecard: [{ key: 'c', label: 'C', target: 3, current: 1, period: 'monthly' }],
        });
        expect(res.status()).toBe(200);
        const fetched = await getAgent(request, token, agent.id);
        expect((fetched.scorecard ?? []).map((m) => m.key)).toEqual(['c']);
    });

    test('an empty array [] clears the stored scorecard to null', async ({ request }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `EmptyClear ${stamp()}`);
        await patchAgent(request, token, agent.id, {
            scorecard: [{ key: 'x', label: 'X', target: 1, current: 0, period: 'weekly' }],
        });
        const res = await patchAgent(request, token, agent.id, { scorecard: [] });
        expect(res.status()).toBe(200);
        expect((await res.json()).scorecard).toBeNull();
        expect((await getAgent(request, token, agent.id)).scorecard).toBeNull();
    });

    test('an explicit null clears the stored scorecard to null', async ({ request }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `NullClear ${stamp()}`);
        await patchAgent(request, token, agent.id, {
            scorecard: [{ key: 'x', label: 'X', target: 1, current: 0, period: 'weekly' }],
        });
        const res = await patchAgent(request, token, agent.id, { scorecard: null });
        expect(res.status()).toBe(200);
        expect((await res.json()).scorecard).toBeNull();
    });

    test('omitting scorecard on PATCH leaves an existing one untouched; updatedAt bumps on a scorecard write', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `Untouched ${stamp()}`);
        const createdAt = agent.createdAt as string;

        const set = await patchAgent(request, token, agent.id, {
            scorecard: [{ key: 'k', label: 'K', target: 10, current: 4, period: 'weekly' }],
        });
        expect(set.status()).toBe(200);
        const afterSet = await set.json();
        expect(afterSet.updatedAt).toMatch(ISO_RE);
        expect(new Date(afterSet.updatedAt).getTime()).toBeGreaterThanOrEqual(
            new Date(createdAt).getTime(),
        );

        // A name-only PATCH must not disturb the scorecard.
        const renamed = await patchAgent(request, token, agent.id, {
            name: `Untouched Renamed ${stamp()}`,
        });
        expect(renamed.status()).toBe(200);
        const body = await renamed.json();
        expect((body.scorecard as ScorecardMetric[]).map((m) => m.key)).toEqual(['k']);
    });
});

test.describe('Agent Scorecards — validation (400)', () => {
    test('a non-kebab key is rejected (400)', async ({ request }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `BadKey ${stamp()}`);
        for (const key of ['Bad_Key', 'UPPER', 'has space', '-leading', 'trailing-']) {
            const res = await patchAgent(request, token, agent.id, {
                scorecard: [{ key, label: 'X', target: 1, current: 0, period: 'weekly' }],
            });
            expect(res.status(), `key="${key}" should 400`).toBe(400);
        }
    });

    test('a non-number / non-finite target or current is rejected (400)', async ({ request }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `BadNum ${stamp()}`);
        const asString = await patchAgent(request, token, agent.id, {
            scorecard: [
                { key: 'k', label: 'X', target: 'notanumber', current: 0, period: 'weekly' },
            ],
        });
        expect(asString.status()).toBe(400);
        // IsNumber rejects NaN/Infinity (allowNaN/allowInfinity default false).
        const notFinite = await patchAgent(request, token, agent.id, {
            scorecard: [{ key: 'k', label: 'X', target: 1, current: null, period: 'weekly' }],
        });
        expect(notFinite.status()).toBe(400);
    });

    test('an unknown period is rejected (400)', async ({ request }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `BadPeriod ${stamp()}`);
        for (const period of ['daily', 'yearly', 'WEEKLY', '']) {
            const res = await patchAgent(request, token, agent.id, {
                scorecard: [{ key: 'k', label: 'X', target: 1, current: 0, period }],
            });
            expect(res.status(), `period="${period}" should 400`).toBe(400);
        }
    });

    test('a missing / empty label is rejected (400)', async ({ request }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `BadLabel ${stamp()}`);
        const missing = await patchAgent(request, token, agent.id, {
            scorecard: [{ key: 'k', target: 1, current: 0, period: 'weekly' }],
        });
        expect(missing.status()).toBe(400);
        const empty = await patchAgent(request, token, agent.id, {
            scorecard: [{ key: 'k', label: '', target: 1, current: 0, period: 'weekly' }],
        });
        expect(empty.status()).toBe(400);
    });

    test('over-long key / label / unit are each rejected (400)', async ({ request }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `TooLong ${stamp()}`);
        const longKey = `a${'-b'.repeat(40)}`; // valid kebab, 81 chars > 64
        expect(longKey.length).toBeGreaterThan(64);
        const keyRes = await patchAgent(request, token, agent.id, {
            scorecard: [{ key: longKey, label: 'X', target: 1, current: 0, period: 'weekly' }],
        });
        expect(keyRes.status()).toBe(400);
        const labelRes = await patchAgent(request, token, agent.id, {
            scorecard: [
                { key: 'k', label: 'L'.repeat(81), target: 1, current: 0, period: 'weekly' },
            ],
        });
        expect(labelRes.status()).toBe(400);
        const unitRes = await patchAgent(request, token, agent.id, {
            scorecard: [
                {
                    key: 'k',
                    label: 'X',
                    target: 1,
                    current: 0,
                    period: 'weekly',
                    unit: 'u'.repeat(21),
                },
            ],
        });
        expect(unitRes.status()).toBe(400);
    });

    test('a non-number floor (when present) is rejected (400)', async ({ request }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `BadFloor ${stamp()}`);
        const res = await patchAgent(request, token, agent.id, {
            scorecard: [
                { key: 'k', label: 'X', target: 1, current: 0, period: 'weekly', floor: 'low' },
            ],
        });
        expect(res.status()).toBe(400);
    });

    test('a nested unknown property on a metric is rejected (400)', async ({ request }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `Nested ${stamp()}`);
        const res = await patchAgent(request, token, agent.id, {
            scorecard: [
                { key: 'k', label: 'X', target: 1, current: 0, period: 'weekly', bogus: true },
            ],
        });
        expect(res.status()).toBe(400);
        expect(await messageText(res)).toContain('bogus');
    });

    test('a non-array scorecard value is rejected (400)', async ({ request }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `NotArray ${stamp()}`);
        const res = await patchAgent(request, token, agent.id, { scorecard: { key: 'k' } });
        expect(res.status()).toBe(400);
    });

    test('exactly 12 metrics is accepted; 13 is rejected by the service cap (400)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `Cap ${stamp()}`);
        const make = (n: number): ScorecardMetric[] =>
            Array.from({ length: n }, (_, i) => ({
                key: `m-${i}`,
                label: `Metric ${i}`,
                target: 10,
                current: 5,
                period: 'weekly' as const,
            }));

        const ok = await patchAgent(request, token, agent.id, { scorecard: make(12) });
        expect(ok.status()).toBe(200);
        expect((await ok.json()).scorecard).toHaveLength(12);

        const tooMany = await patchAgent(request, token, agent.id, { scorecard: make(13) });
        expect(tooMany.status()).toBe(400);
        expect(await messageText(tooMany)).toContain('at most 12');
    });

    test('duplicate keys within one scorecard are rejected by the service (400)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `Dup ${stamp()}`);
        const res = await patchAgent(request, token, agent.id, {
            scorecard: [
                { key: 'dup', label: 'A', target: 1, current: 0, period: 'weekly' },
                { key: 'dup', label: 'B', target: 2, current: 0, period: 'weekly' },
            ],
        });
        expect(res.status()).toBe(400);
        expect(await messageText(res)).toContain('duplicated');
    });

    test('a rejected scorecard write does not mutate the previously stored scorecard', async ({
        request,
    }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `NoMutate ${stamp()}`);
        await patchAgent(request, token, agent.id, {
            scorecard: [{ key: 'keep', label: 'Keep', target: 9, current: 3, period: 'weekly' }],
        });
        // An invalid follow-up PATCH must be atomic — the good scorecard survives.
        const bad = await patchAgent(request, token, agent.id, {
            scorecard: [{ key: 'BAD KEY', label: 'X', target: 1, current: 0, period: 'weekly' }],
        });
        expect(bad.status()).toBe(400);
        const fetched = await getAgent(request, token, agent.id);
        expect((fetched.scorecard ?? []).map((m) => m.key)).toEqual(['keep']);
    });
});

test.describe('Agent Scorecards — auth + ownership isolation', () => {
    test('an unauthenticated scorecard PATCH is rejected (401)', async ({ request }) => {
        const token = await freshToken(request);
        const agent = await createAgentRaw(request, token, `Unauth ${stamp()}`);
        const res = await request.patch(`${API_BASE}/api/agents/${agent.id}`, {
            data: { scorecard: [] },
        });
        expect(res.status()).toBe(401);
    });

    test("a non-owner can neither GET nor PATCH another user's Agent scorecard (404, never 403)", async ({
        request,
    }) => {
        const owner = await freshToken(request);
        const intruder = await freshToken(request);
        const agent = await createAgentRaw(request, owner, `Owned ${stamp()}`);
        await patchAgent(request, owner, agent.id, {
            scorecard: [
                { key: 'secret', label: 'Secret', target: 1, current: 0, period: 'weekly' },
            ],
        });

        const read = await request.get(`${API_BASE}/api/agents/${agent.id}`, {
            headers: authedHeaders(intruder),
        });
        expect(read.status()).toBe(404);
        const write = await patchAgent(request, intruder, agent.id, {
            scorecard: [{ key: 'hijack', label: 'H', target: 1, current: 0, period: 'weekly' }],
        });
        expect(write.status()).toBe(404);

        // The owner's scorecard is untouched by the intruder's attempts.
        const fetched = await getAgent(request, owner, agent.id);
        expect((fetched.scorecard ?? []).map((m) => m.key)).toEqual(['secret']);
    });

    test('an unknown-but-valid uuid → 404; a malformed uuid → 400', async ({ request }) => {
        const token = await freshToken(request);
        const unknown = await patchAgent(request, token, UNKNOWN_UUID, { scorecard: [] });
        expect(unknown.status()).toBe(404);
        const malformed = await patchAgent(request, token, 'not-a-uuid', { scorecard: [] });
        expect(malformed.status()).toBe(400);
    });
});
