import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Meetings v1 (Wave 8, feature a) — owner-scoped CRUD + transcript
 * capture API CONTRACT. Shipped with no e2e.
 *
 * ── Routes (apps/api/src/meetings/meetings.controller.ts) ───────────
 *   GET    /api/meetings                 200 MeetingView[] (no transcript
 *                                            body in list rows)
 *   POST   /api/meetings                 201 MeetingView
 *   GET    /api/meetings/:id             200 (INCLUDES transcriptText)
 *   PATCH  /api/meetings/:id             200
 *   DELETE /api/meetings/:id             204
 *   POST   /api/meetings/:id/transcript  200 { meeting, summary?,
 *                                            memorySaved, envelopeEmitted }
 *
 * Ownership is enforced in `MeetingsService.getForUser`, which 404s for
 * missing AND for other owners' rows — no existence leak. `dedupeKey`
 * never leaves the API (the view is an explicit projection).
 *
 * Environment note: the transcript pipeline's enrichment half (AI
 * summary → memory observation → ingest envelope) is BEST EFFORT by
 * design, so on a key-less CI stack `summary` is absent and both
 * booleans are false. Only the transcript WRITE can fail the call, and
 * that is what is asserted.
 */

const UNKNOWN_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEETING_SOURCES = ['zoom', 'google-meet', 'manual', 'import'];

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function errText(body: unknown): string {
    const m = (body as { message?: unknown })?.message;
    if (Array.isArray(m)) return m.join(' | ');
    return String(m ?? '');
}

function post(request: APIRequestContext, token: string, path: string, data: unknown) {
    return request.post(`${API_BASE}${path}`, { headers: authedHeaders(token), data });
}

async function createMeeting(
    request: APIRequestContext,
    token: string,
    overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
    const res = await post(request, token, '/api/meetings', {
        title: `Standup ${uniq()}`,
        startedAt: new Date().toISOString(),
        ...overrides,
    });
    expect(res.status(), `setup createMeeting body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

test.describe('POST /api/meetings — CreateMeetingDto', () => {
    test('creates with the documented view shape and never leaks dedupeKey', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const startedAt = new Date('2026-07-20T09:00:00.000Z').toISOString();

        const meeting = await createMeeting(request, u.access_token, {
            title: `Roadmap review ${uniq()}`,
            startedAt,
            endedAt: new Date('2026-07-20T09:45:00.000Z').toISOString(),
            source: 'manual',
            participants: [{ name: 'Ada Lovelace', email: 'ada@example.com' }, { name: 'Grace' }],
            sourceUrl: 'https://example.com/recording/1',
        });

        expect(typeof meeting.id).toBe('string');
        expect(meeting.startedAt).toBe(startedAt);
        expect(meeting.source).toBe('manual');
        expect(meeting.hasTranscript).toBe(false);
        expect(Array.isArray(meeting.participants)).toBe(true);
        expect((meeting.participants as unknown[]).length).toBe(2);
        expect(meeting).not.toHaveProperty('dedupeKey');
        expect(JSON.stringify(meeting)).not.toContain('dedupeKey');
    });

    test('title and startedAt are required and validated at both layers', async ({ request }) => {
        const u = await registerUserViaAPI(request);

        const noTitle = await post(request, u.access_token, '/api/meetings', {
            startedAt: new Date().toISOString(),
        });
        expect(noTitle.status()).toBe(400);
        expect(errText(await noTitle.json())).toContain('title');

        // Whitespace passes the DTO's MinLength(1) and is caught by the
        // SERVICE trim guard — a distinct code path, same 400.
        const wsTitle = await post(request, u.access_token, '/api/meetings', {
            title: '   ',
            startedAt: new Date().toISOString(),
        });
        expect(wsTitle.status()).toBe(400);
        expect(errText(await wsTitle.json())).toContain('title is required');

        const noStart = await post(request, u.access_token, '/api/meetings', {
            title: `no-start-${uniq()}`,
        });
        expect(noStart.status()).toBe(400);
        expect(errText(await noStart.json())).toContain('startedAt');

        const badStart = await post(request, u.access_token, '/api/meetings', {
            title: `bad-start-${uniq()}`,
            startedAt: 'yesterday',
        });
        expect(badStart.status()).toBe(400);
    });

    test('source is a closed set; workId must be a uuid; unknown fields are forbidden', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const base = { title: `src-${uniq()}`, startedAt: new Date().toISOString() };

        for (const source of MEETING_SOURCES) {
            const res = await post(request, u.access_token, '/api/meetings', {
                ...base,
                title: `src-${source}-${uniq()}`,
                source,
            });
            expect(res.status(), `source=${source}`).toBe(201);
            expect((await res.json()).source).toBe(source);
        }

        const badSource = await post(request, u.access_token, '/api/meetings', {
            ...base,
            source: 'telepathy',
        });
        expect(badSource.status()).toBe(400);

        const badWork = await post(request, u.access_token, '/api/meetings', {
            ...base,
            workId: 'not-a-uuid',
        });
        expect(badWork.status()).toBe(400);
        expect(errText(await badWork.json())).toContain('workId must be a UUID');

        const extra = await post(request, u.access_token, '/api/meetings', {
            ...base,
            bogusField: 'x',
        });
        expect(extra.status()).toBe(400);
        expect(errText(await extra.json())).toContain('property bogusField should not exist');
    });

    test('a participant entry is validated field-by-field (nested DTO)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const base = { title: `p-${uniq()}`, startedAt: new Date().toISOString() };

        const emptyName = await post(request, u.access_token, '/api/meetings', {
            ...base,
            participants: [{ name: '' }],
        });
        expect(emptyName.status()).toBe(400);
        expect(errText(await emptyName.json())).toContain('name');

        const notArray = await post(request, u.access_token, '/api/meetings', {
            ...base,
            participants: 'ada',
        });
        expect(notArray.status()).toBe(400);
    });
});

test.describe('GET /api/meetings — list vs. detail projection', () => {
    test('list omits the transcript body; detail includes it', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const meeting = await createMeeting(request, u.access_token, {
            transcriptText: 'Ada: shipping the gate. Grace: reviewing the branch.',
        });

        const list = await request.get(`${API_BASE}/api/meetings`, {
            headers: authedHeaders(u.access_token),
        });
        expect(list.status()).toBe(200);
        const rows = (await list.json()) as Array<Record<string, unknown>>;
        const row = rows.find((r) => r.id === meeting.id);
        expect(row, 'the created meeting appears in my list').toBeTruthy();
        expect(row).not.toHaveProperty('transcriptText');
        expect(row?.hasTranscript).toBe(true);

        const detail = await request.get(`${API_BASE}/api/meetings/${meeting.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(detail.status()).toBe(200);
        const body = await detail.json();
        expect(body).toHaveProperty('transcriptText');
        expect(String(body.transcriptText)).toContain('shipping the gate');
    });

    test('the list is owner-scoped — another account never sees my meetings', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const meeting = await createMeeting(request, owner.access_token);

        const theirs = await request.get(`${API_BASE}/api/meetings`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(theirs.status()).toBe(200);
        const rows = (await theirs.json()) as Array<{ id: string }>;
        expect(rows.some((r) => r.id === meeting.id)).toBe(false);
    });
});

test.describe('PATCH / DELETE /api/meetings/:id', () => {
    test('partial update round-trips; an empty title is rejected by the service', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const meeting = await createMeeting(request, u.access_token);

        const renamed = await request.patch(`${API_BASE}/api/meetings/${meeting.id}`, {
            headers: authedHeaders(u.access_token),
            data: { title: `Renamed ${uniq()}` },
        });
        expect(renamed.status(), `patch body=${await renamed.text().catch(() => '')}`).toBe(200);
        expect(String((await renamed.json()).title)).toContain('Renamed');

        const emptied = await request.patch(`${API_BASE}/api/meetings/${meeting.id}`, {
            headers: authedHeaders(u.access_token),
            data: { title: '   ' },
        });
        expect(emptied.status()).toBe(400);
        expect(errText(await emptied.json())).toContain('title cannot be empty');
    });

    test('delete is 204 and the row is then gone (404 on re-read)', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const meeting = await createMeeting(request, u.access_token);

        const removed = await request.delete(`${API_BASE}/api/meetings/${meeting.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(removed.status()).toBe(204);

        const reread = await request.get(`${API_BASE}/api/meetings/${meeting.id}`, {
            headers: authedHeaders(u.access_token),
        });
        expect(reread.status()).toBe(404);
    });

    test('authz closure on every verb: stranger 404, unknown 404, malformed 400, anon 401', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const meeting = await createMeeting(request, owner.access_token);
        const path = `/api/meetings/${meeting.id}`;
        const strangerHeaders = authedHeaders(stranger.access_token);

        expect(
            (await request.get(`${API_BASE}${path}`, { headers: strangerHeaders })).status(),
        ).toBe(404);
        expect(
            (
                await request.patch(`${API_BASE}${path}`, {
                    headers: strangerHeaders,
                    data: { title: 'hijack' },
                })
            ).status(),
        ).toBe(404);
        expect(
            (await request.delete(`${API_BASE}${path}`, { headers: strangerHeaders })).status(),
        ).toBe(404);

        // …and the owner's row survived every refused attempt.
        const survived = await request.get(`${API_BASE}${path}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(survived.status()).toBe(200);

        const unknown = await request.get(`${API_BASE}/api/meetings/${UNKNOWN_UUID}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(unknown.status()).toBe(404);

        const malformed = await request.get(`${API_BASE}/api/meetings/not-a-uuid`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(malformed.status()).toBe(400);

        expect((await request.get(`${API_BASE}${path}`)).status()).toBe(401);
    });
});

test.describe('POST /api/meetings/:id/transcript', () => {
    test('stores the transcript and reports the best-effort fan-out flags', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const meeting = await createMeeting(request, u.access_token);

        const res = await post(request, u.access_token, `/api/meetings/${meeting.id}/transcript`, {
            transcriptText: 'Ada: the gate is green. Grace: merging the task branch.',
        });
        expect(res.status(), `transcript body=${await res.text().catch(() => '')}`).toBe(200);
        const body = await res.json();

        // The WRITE is the only part that can fail the call.
        expect(body.meeting.hasTranscript).toBe(true);
        expect(String(body.meeting.transcriptText)).toContain('the gate is green');
        // Enrichment is best effort — booleans are always present, the
        // summary only when an AI provider answered.
        expect(typeof body.memorySaved).toBe('boolean');
        expect(typeof body.envelopeEmitted).toBe('boolean');
    });

    test('an empty transcript is rejected; authz closes the same way as the rest', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const meeting = await createMeeting(request, owner.access_token);
        const path = `/api/meetings/${meeting.id}/transcript`;

        const empty = await post(request, owner.access_token, path, { transcriptText: '' });
        expect(empty.status()).toBe(400);

        const whitespace = await post(request, owner.access_token, path, { transcriptText: '   ' });
        expect(whitespace.status()).toBe(400);
        expect(errText(await whitespace.json())).toContain('Transcript text is required');

        const cross = await post(request, stranger.access_token, path, {
            transcriptText: 'not mine',
        });
        expect(cross.status()).toBe(404);

        const anon = await request.post(`${API_BASE}${path}`, {
            data: { transcriptText: 'anon' },
        });
        expect(anon.status()).toBe(401);
    });
});
