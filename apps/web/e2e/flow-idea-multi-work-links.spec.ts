import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * Idea ↔ Work MULTI-LINK provenance — deep pins for the `idea_works`
 * 0..N relation (domain-model review §23.1 / ADR-009: `idea_works` is
 * the AUTHORITATIVE Idea→Work link; `acceptedWorkId` remains the
 * denormalized "primary / most recent" pointer).
 *
 * REST surface under test:
 *   - POST /api/me/work-proposals/:id/accept   { workId } → 200 { ok:true }.
 *     Valid from PENDING (first link) AND from ACCEPTED (additional
 *     links). Each accept appends an `idea_works` row (kind 'linked',
 *     unique on (ideaId, workId)) and re-points `acceptedWorkId` at the
 *     newest link. It also stamps the Work-side back-pointer
 *     `works.acceptedFromIdeaId` FIRST-WRITER-WINS — per WORK: a Work
 *     keeps at most ONE source Idea for its whole life, but every Work
 *     linked for the first time gets its own stamp.
 *   - GET /api/me/work-proposals/:id/works → 200
 *     { links: [{ id, ideaId, workId, kind, createdAt, workName, workSlug }] }
 *     newest first; 404 when the Idea doesn't exist for the caller.
 *
 * ── NON-DUPLICATION ─────────────────────────────────────────────────
 * flow-idea-to-work-accept.spec.ts pins the accept state machine
 * (re-point + same-Work idempotency + QUEUED/DISMISSED rejection) and
 * flow-idea-lifecycle-deep.spec.ts pins the accept INPUT edge (IDOR /
 * ghost workId / DTO whitelist). THIS file pins the LINK LIST itself:
 * shape, ordering, per-Work back-pointer stamping (incl. cross-Idea
 * first-writer-wins), and the :id/works ownership/404 vocabulary.
 *
 * Cross-spec isolation: every test runs on a FRESH registerUserViaAPI()
 * user with unique Date.now-suffixed names; list assertions only ever
 * touch that user's own rows. No module-scope data loading (a
 * module-scope seeded-user read runs at collection time on EVERY shard
 * and reddens all of them).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A syntactically-valid v4 UUID that no row will ever own. */
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';
const IDEA_DESC_MIN = 'a curated directory of resources'; // ≥10 chars filler

interface IdeaWorkLink {
    id: string;
    ideaId: string;
    workId: string;
    kind: string;
    createdAt: string;
    workName: string | null;
    workSlug: string | null;
}

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function msgOf(body: { message?: unknown }): string {
    return Array.isArray(body?.message) ? body.message.join(' ') : String(body?.message);
}

/** Create a user-manual Idea (PENDING) and return its id. */
async function createIdea(
    request: APIRequestContext,
    token: string,
    description: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/work-proposals`, {
        headers: authedHeaders(token),
        data: { description },
    });
    expect(res.status(), `idea create body=${await res.text()}`).toBe(201);
    const idea = await res.json();
    expect(idea.id).toMatch(UUID_RE);
    expect(idea.status).toBe('pending');
    return idea.id;
}

async function readIdea(request: APIRequestContext, token: string, id: string) {
    const res = await request.get(`${API_BASE}/api/me/work-proposals/${id}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `idea read body=${await res.text()}`).toBe(200);
    return res.json();
}

async function acceptIdea(
    request: APIRequestContext,
    token: string,
    ideaId: string,
    workId: string,
): Promise<void> {
    const res = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/accept`, {
        headers: authedHeaders(token),
        data: { workId },
    });
    expect(res.status(), `accept body=${await res.text()}`).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
}

async function listLinks(
    request: APIRequestContext,
    token: string,
    ideaId: string,
): Promise<IdeaWorkLink[]> {
    const res = await request.get(`${API_BASE}/api/me/work-proposals/${ideaId}/works`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `links body=${await res.text()}`).toBe(200);
    const body = (await res.json()) as { links: IdeaWorkLink[] };
    expect(Array.isArray(body.links)).toBe(true);
    return body.links;
}

/** Pull the authoritative name/slug out of the create-Work response. */
function workDisplay(work: { raw: unknown }): { name?: string; slug?: string } {
    const raw = work.raw as { work?: { name?: string; slug?: string } };
    return { name: raw.work?.name, slug: raw.work?.slug };
}

test.describe('Idea → Work multi-link provenance (idea_works, 0..N)', () => {
    test('first accept records one kind-linked row; a second accept from ACCEPTED appends a second link, re-points acceptedWorkId, and GET :id/works lists newest first', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // ── (a) Idea + Work A, first accept ─────────────────────────────────
        const ideaId = await createIdea(
            request,
            token,
            `Multi-link idea ${s} — ${IDEA_DESC_MIN} for the 0..N provenance probe`,
        );
        const workA = await createWorkViaAPI(request, token, { name: `Multi Work A ${s}` });
        expect(workA.id).toMatch(UUID_RE);

        await acceptIdea(request, token, ideaId, workA.id);
        const afterFirst = await readIdea(request, token, ideaId);
        expect(afterFirst.status).toBe('accepted');
        expect(afterFirst.acceptedWorkId).toBe(workA.id);

        const linksAfterFirst = await listLinks(request, token, ideaId);
        expect(linksAfterFirst.length).toBe(1);
        const firstLink = linksAfterFirst[0];
        expect(firstLink.id).toMatch(UUID_RE);
        expect(firstLink.ideaId).toBe(ideaId);
        expect(firstLink.workId).toBe(workA.id);
        // A user-manual accept records kind 'linked' ('built'/'rebuilt' are
        // reserved for the Goal-completion writer, which can't run here).
        expect(firstLink.kind).toBe('linked');
        expect(firstLink.createdAt).toBeTruthy();
        const aDisplay = workDisplay(workA);
        if (aDisplay.name) expect(firstLink.workName).toBe(aDisplay.name);
        if (aDisplay.slug) expect(firstLink.workSlug).toBe(aDisplay.slug);

        // ── (b) Work B, accept AGAIN — valid from ACCEPTED (0..N) ───────────
        const workB = await createWorkViaAPI(request, token, { name: `Multi Work B ${s}` });
        await acceptIdea(request, token, ideaId, workB.id);

        const afterSecond = await readIdea(request, token, ideaId);
        expect(afterSecond.status).toBe('accepted');
        // The denormalized pointer follows the NEWEST link.
        expect(afterSecond.acceptedWorkId).toBe(workB.id);

        const linksAfterSecond = await listLinks(request, token, ideaId);
        expect(linksAfterSecond.length).toBe(2);
        // Newest first: B (second accept) before A (first accept).
        expect(linksAfterSecond[0].workId).toBe(workB.id);
        expect(linksAfterSecond[1].workId).toBe(workA.id);
        expect(linksAfterSecond.map((l) => l.kind)).toEqual(['linked', 'linked']);
        expect(linksAfterSecond.every((l) => l.ideaId === ideaId)).toBe(true);
        // Two distinct link rows, not one row re-pointed.
        expect(new Set(linksAfterSecond.map((l) => l.id)).size).toBe(2);
    });

    test('back-pointer stamping is per-WORK: every first-time-linked Work gets acceptedFromIdeaId = the Idea id, and a Work already sourced from one Idea is never re-pointed by another', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // ── (c) One Idea, two Works, both linked ────────────────────────────
        const ideaId = await createIdea(
            request,
            token,
            `Back-pointer idea ${s} — ${IDEA_DESC_MIN} for the per-Work stamp probe`,
        );
        const workA = await createWorkViaAPI(request, token, { name: `Stamp Work A ${s}` });
        const workB = await createWorkViaAPI(request, token, { name: `Stamp Work B ${s}` });

        await acceptIdea(request, token, ideaId, workA.id);
        await acceptIdea(request, token, ideaId, workB.id);

        // FIRST-WRITER-WINS is per WORK (each Work has its OWN one-shot
        // `acceptedFromIdeaId` column): both Works were linked for the first
        // time here, so BOTH carry the Idea id — the guard never means "only
        // the first-accepted Work of an Idea gets stamped".
        for (const work of [workA, workB]) {
            const res = await request.get(`${API_BASE}/api/works/${work.id}`, {
                headers: authedHeaders(token),
            });
            expect(res.status(), `work read body=${await res.text()}`).toBe(200);
            const body = await res.json();
            expect((body?.work ?? body)?.acceptedFromIdeaId ?? null).toBe(ideaId);
        }

        // Cross-Idea first-writer-wins: a SECOND Idea linking Work A appends
        // its own provenance row (200), but Work A's back-pointer keeps its
        // ORIGINAL source Idea — a Work keeps at most one source Idea, ever.
        const secondIdeaId = await createIdea(
            request,
            token,
            `Second-source idea ${s} — ${IDEA_DESC_MIN} that must NOT re-point Work A`,
        );
        await acceptIdea(request, token, secondIdeaId, workA.id);

        const secondLinks = await listLinks(request, token, secondIdeaId);
        expect(secondLinks.length).toBe(1);
        expect(secondLinks[0].workId).toBe(workA.id);

        const workARead = await request.get(`${API_BASE}/api/works/${workA.id}`, {
            headers: authedHeaders(token),
        });
        expect(workARead.status()).toBe(200);
        const workABody = await workARead.json();
        expect((workABody?.work ?? workABody)?.acceptedFromIdeaId ?? null).toBe(ideaId);
        expect((workABody?.work ?? workABody)?.acceptedFromIdeaId ?? null).not.toBe(secondIdeaId);
    });

    test('accept with a well-formed but non-existent workId → 404, the Idea stays PENDING, and no phantom link is recorded', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const s = stamp();

        // ── (d) Ghost workId is refused before any state change ─────────────
        const ideaId = await createIdea(
            request,
            token,
            `Ghost-link idea ${s} — ${IDEA_DESC_MIN} for the negative accept probe`,
        );
        const ghost = await request.post(`${API_BASE}/api/me/work-proposals/${ideaId}/accept`, {
            headers: authedHeaders(token),
            data: { workId: UNKNOWN_UUID },
        });
        expect(ghost.status(), `ghost accept body=${await ghost.text()}`).toBe(404);

        const after = await readIdea(request, token, ideaId);
        expect(after.status).toBe('pending');
        expect(after.acceptedWorkId).toBeNull();

        // A link-less Idea returns the empty-list shape, not a 404.
        expect(await listLinks(request, token, ideaId)).toEqual([]);
    });

    test('GET :id/works is ownership-scoped: a stranger, an unknown id, a malformed id, and an anonymous caller are all rejected without leaking links', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const s = stamp();

        // ── (e) Owner has a linked Idea; nobody else can enumerate it ───────
        const ideaId = await createIdea(
            request,
            owner.access_token,
            `Scoped-links idea ${s} — ${IDEA_DESC_MIN} for the ownership probe`,
        );
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `Scoped Work ${s}`,
        });
        await acceptIdea(request, owner.access_token, ideaId, work.id);
        expect((await listLinks(request, owner.access_token, ideaId)).length).toBe(1);

        // Another user's Idea → 404 (same existence-leak-safe vocabulary as
        // the other Idea reads — no "forbidden" hint that the id exists).
        const foreign = await request.get(`${API_BASE}/api/me/work-proposals/${ideaId}/works`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(foreign.status()).toBe(404);
        expect(msgOf(await foreign.json())).toMatch(/proposal not found/i);

        // Unknown-but-well-formed id → 404.
        const unknown = await request.get(
            `${API_BASE}/api/me/work-proposals/${UNKNOWN_UUID}/works`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(unknown.status()).toBe(404);
        expect(msgOf(await unknown.json())).toMatch(/proposal not found/i);

        // Malformed id → 400 ParseUUIDPipe, before any ownership guard.
        const malformed = await request.get(`${API_BASE}/api/me/work-proposals/not-a-uuid/works`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(malformed.status()).toBe(400);
        expect(msgOf(await malformed.json())).toMatch(/uuid is expected/i);

        // Unauthenticated → 401.
        const anon = await request.get(`${API_BASE}/api/me/work-proposals/${ideaId}/works`);
        expect(anon.status()).toBe(401);
    });
});
