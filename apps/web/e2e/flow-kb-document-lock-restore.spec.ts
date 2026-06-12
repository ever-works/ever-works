import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';
import { seedKbMarkdownDoc } from './helpers/kb-fixtures';

/**
 * flow-kb-document-lock-restore — Works long-tail deep coverage for the KB
 * document LOCK / UNLOCK / RESTORE / HISTORY verbs on
 * `/api/works/:id/kb/documents/:docId/{lock,unlock,restore,history}`
 * (`apps/api/src/works/kb.controller.ts` → `KnowledgeBaseService`).
 *
 * Pure API-contract spec (no UI nav) — every status/message below was probed
 * against the LIVE sqlite-in-memory CI-mirror API (http://127.0.0.1:3100) on
 * 2026-06-12 before any assertion was written.
 *
 * ─── NON-DUPLICATION (where the dense sibling specs STOP) ────────────────────
 * The lock/history/restore surface already has HEAVY coverage; this file pins
 * ONLY the residual GAPS those specs never assert:
 *   · flow-kb-lock.spec.ts (A30/A31/A32) — full vs additions-only PATCH gating,
 *     owner unlock. Does NOT touch invalid-mode 400, missing-doc 404,
 *     idempotency, restore, history, or cross-work confusion.
 *   · flow-kb-locking-history.spec.ts — lock-mode matrix + UI badge, manager+
 *     gate cross-USER, history doc-scope/limit-clamp/missing-404/non-member-403,
 *     restore manager+/short-sha-400/full-lock-preempt/non-member-403, locked
 *     tree filter. It NEVER asserts: the lock `mode` ENUM-validation 400 (only
 *     mentioned in a header comment), lock/unlock on a MISSING doc → 404,
 *     lock/unlock IDEMPOTENCY + direct full↔additions mode-SWAP without an
 *     unlock, unlock-when-already-unlocked, the restore `@Matches(hex-only)`
 *     guard (it tests only the @Length short-sha), restore length BOUNDARIES
 *     (6/7/41 chars), the DTO-vs-ownership-vs-existence GUARD ORDERING, the
 *     ParseUUIDPipe 400, or CROSS-WORK doc-id confusion (B's docId via A's
 *     route → 404, not 403).
 *   · flow-kb-document-lifecycle-deep.spec.ts — full-lock blocks edit/delete +
 *     unlock; history reachable + missing-404; cross-user isolation 403. No
 *     invalid-mode / idempotency / hex-guard / mode-swap / cross-work-404.
 *
 * THIS file pins exactly those residual lock/unlock/restore/history GAPS.
 *
 * ─── PROBED CONTRACTS (live, 2026-06-12) ─────────────────────────────────────
 *   · POST :docId/lock {mode} — owner of a personal Work clears the manager+
 *       gate. Valid mode → 200 body DTO `{ locked, lockMode, … }`.
 *       Absent `mode` → 400. mode ∉ {full,additions-only} → 400
 *       `["mode must be one of the following values: full, additions-only"]`.
 *       IDEMPOTENT: re-locking `full` twice → still `{locked:true,lockMode:full}`.
 *       MODE-SWAP without unlock: full → additions-only directly →
 *       `{locked:true,lockMode:'additions-only'}` (no intermediate unlock).
 *       Lock on a MISSING docId (owner) → 404 (findById after the role gate).
 *   · POST :docId/unlock → 200 `{locked:false,lockMode:null}`. IDEMPOTENT:
 *       unlocking an already-unlocked doc → 200 `{locked:false}` (NOT 409/404).
 *       Unlock on a MISSING docId (owner) → 404.
 *   · POST :docId/restore {commitSha} — `@Length(7,40)` + `@Matches(/^[0-9a-f]
 *       {7,40}$/)`. NON-HEX (`HEAD~1`, `refs/heads/main`) → 400 incl. message
 *       "commitSha must be a hexadecimal Git SHA". UPPERCASE hex → 400 (lower
 *       only). Absent → 400. 6-char hex → 400 (hex+length msgs). 7-char hex →
 *       NOT a 400 (reaches the mirror). 41-char → 400. A well-formed 40-hex sha
 *       on an UNLOCKED owner doc reaches the wired-but-repoless CI mirror → 500
 *       (deployment with a real repo would 200/404 — tolerated by a set).
 *   · GUARD ORDERING (probed): the global ValidationPipe runs BEFORE the
 *       ownership guard which runs BEFORE the existence check:
 *         - non-member + NON-HEX sha on a missing doc → 400 (DTO wins).
 *         - non-member + VALID sha on a missing doc   → 403 (ownership wins
 *           over existence — the 404 is never reached for an outsider).
 *         - owner     + VALID sha on a missing doc    → 404 (existence).
 *   · CROSS-WORK doc CONFUSION — A's owner addressing B's docId through A's
 *       OWN work route (`/works/:workA/.../:docB/...`) → 404 for lock / unlock /
 *       restore / history (the doc is not found UNDER work A; the owner is NOT
 *       403 because they DO own work A). The doc id alone never crosses works.
 *   · GET :docId/history — in the CI sqlite env the git mirror is wired but has
 *       NO repo, so the commit-log read 500s for every limit (none/0/-5/abc).
 *       A repo-backed deployment would 200 `{items:[]}`; tolerated by a set.
 *       (doc-scope/clamp/isolation are NOT re-pinned here — sibling owns them.)
 *   · ParseUUIDPipe: a non-UUID `docId` on /lock → 400 before any service work.
 *
 * ─── HOUSE RULES honoured ────────────────────────────────────────────────────
 *   · Full isolation: a FRESH registerUserViaAPI() user + a FRESH Work per
 *     mutation (unique suffix from a per-test counter, NOT a module clock).
 *   · Keyless / no-mirror-repo CI: history + the well-formed restore are
 *     GIT-GATED — assert the TYPED GATE / reachability set, never a successful
 *     git-backed mutation. Records & contracts, not completions.
 *   · No module-scope await / no loadSeededTestUser at module scope. Anon paths
 *     use fresh raw tokens. `flow-` filename → runs authed (not the no-auth
 *     project). TS strict.
 */

/** KbLockMode enum (packages/agent/src/entities/kb-types.ts). */
const LOCK_FULL = 'full';
const LOCK_ADDITIONS_ONLY = 'additions-only';

/** A well-formed 40-char lowercase-hex SHA — passes the restore DTO guard. */
const VALID_SHA = '0123456789abcdef0123456789abcdef01234567';
/** All-zero UUID — never a real row → drives the existence-404 path. */
const MISSING_DOC = '00000000-0000-0000-0000-000000000000';

/**
 * The wired-but-repoless CI mirror 500s the restore/history reads; a
 * repo-backed deployment would 200 (restore) / 404 (sha-not-found). Accept the
 * documented success/not-found branches too so the GATE assertions stay
 * portable — we annotate which branch ran. We NEVER assert a populated git
 * result (that needs a real repo).
 */
const RESTORE_REACHED_MIRROR = [200, 404, 409, 500, 502, 503] as const;
const HISTORY_REACHABLE = [200, 409, 500, 502, 503] as const;

/** Per-test unique suffix — a closure counter, NOT a module-scope clock. */
let seq = 0;
function uniq(): string {
    seq += 1;
    return `${seq}${Math.random().toString(36).slice(2, 7)}`;
}

interface KbBodyDto {
    id: string;
    path: string;
    locked: boolean;
    lockMode: string | null;
}

function msgOf(body: unknown): string {
    const m = (body as { message?: unknown })?.message;
    return Array.isArray(m) ? m.join(' ') : String(m ?? '');
}

async function jsonOf(res: { json(): Promise<unknown> }): Promise<unknown> {
    try {
        return await res.json();
    } catch {
        return null;
    }
}

function lockUrl(workId: string, docId: string): string {
    return `${API_BASE}/api/works/${workId}/kb/documents/${docId}/lock`;
}
function unlockUrl(workId: string, docId: string): string {
    return `${API_BASE}/api/works/${workId}/kb/documents/${docId}/unlock`;
}
function restoreUrl(workId: string, docId: string): string {
    return `${API_BASE}/api/works/${workId}/kb/documents/${docId}/restore`;
}
function historyUrl(workId: string, docId: string): string {
    return `${API_BASE}/api/works/${workId}/kb/documents/${docId}/history`;
}

async function lock(
    request: APIRequestContext,
    token: string,
    workId: string,
    docId: string,
    mode: string | undefined,
): Promise<{ status: number; body: unknown }> {
    const res = await request.post(lockUrl(workId, docId), {
        headers: { ...authedHeaders(token), 'content-type': 'application/json' },
        data: mode === undefined ? {} : { mode },
    });
    return { status: res.status(), body: await jsonOf(res) };
}

async function unlock(
    request: APIRequestContext,
    token: string,
    workId: string,
    docId: string,
): Promise<{ status: number; body: unknown }> {
    const res = await request.post(unlockUrl(workId, docId), { headers: authedHeaders(token) });
    return { status: res.status(), body: await jsonOf(res) };
}

async function restore(
    request: APIRequestContext,
    token: string,
    workId: string,
    docId: string,
    commitSha: string | undefined,
): Promise<{ status: number; body: unknown }> {
    const res = await request.post(restoreUrl(workId, docId), {
        headers: { ...authedHeaders(token), 'content-type': 'application/json' },
        data: commitSha === undefined ? {} : { commitSha },
    });
    return { status: res.status(), body: await jsonOf(res) };
}

/** Mint a fresh owner + a fresh personal Work + a seeded markdown doc. */
async function freshOwnerWorkDoc(
    request: APIRequestContext,
    label: string,
): Promise<{ token: string; workId: string; docId: string; path: string }> {
    const id = uniq();
    const owner = await registerUserViaAPI(request, { name: `${label} ${id}` });
    const { id: workId } = await createWorkViaAPI(request, owner.access_token, {
        name: `${label} W ${id}`,
    });
    expect(workId, 'work id is non-empty').toBeTruthy();
    const { documentId, path } = await seedKbMarkdownDoc(request, owner.access_token, workId, {
        filename: `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id}.md`,
        body: `# ${label} ${id}\n\nseed body for the ${label} lock/restore probe\n`,
    });
    return { token: owner.access_token, workId, docId: documentId, path };
}

test.describe('flow: KB doc lock/unlock/restore/history — residual verb contracts', () => {
    // ─────────────────────────────────────────────────────────────────────────
    // 1 — LOCK `mode` ENUM validation. The DTO `@IsIn(KB_LOCK_MODES)` rejects an
    // absent or off-enum mode with a 400 BEFORE any service work. (Siblings only
    // mention this in a header comment; none assert it.)
    // ─────────────────────────────────────────────────────────────────────────
    test('lock mode validation: absent + off-enum mode → 400 with the enum message', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token, workId, docId } = await freshOwnerWorkDoc(request, 'LockMode');

        const absent = await lock(request, token, workId, docId, undefined);
        expect(absent.status, 'absent mode → 400').toBe(400);

        const bogus = await lock(request, token, workId, docId, 'partial');
        expect(bogus.status, 'off-enum mode → 400').toBe(400);
        expect(msgOf(bogus.body)).toContain(
            'mode must be one of the following values: full, additions-only',
        );

        // The doc stays UNLOCKED — a rejected lock never flips the flag.
        const after = await request.get(`${API_BASE}/api/works/${workId}/kb/documents/${docId}`, {
            headers: authedHeaders(token),
        });
        expect(((await after.json()) as KbBodyDto).locked, 'rejected lock left doc unlocked').toBe(
            false,
        );

        // Both valid enum members are accepted (the positive side of the gate).
        const full = await lock(request, token, workId, docId, LOCK_FULL);
        expect(full.status, 'full is a valid mode → 200').toBe(200);
        expect((full.body as KbBodyDto).lockMode).toBe(LOCK_FULL);
        const add = await lock(request, token, workId, docId, LOCK_ADDITIONS_ONLY);
        expect(add.status, 'additions-only is a valid mode → 200').toBe(200);
        expect((add.body as KbBodyDto).lockMode).toBe(LOCK_ADDITIONS_ONLY);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2 — ParseUUIDPipe on the docId param: a malformed (non-UUID) docId on
    // /lock is rejected at the pipe layer with a 400, before ownership/service.
    // ─────────────────────────────────────────────────────────────────────────
    test('lock with a non-UUID docId → 400 at the ParseUUIDPipe', async ({ request }) => {
        test.setTimeout(120_000);
        const { token, workId } = await freshOwnerWorkDoc(request, 'UuidPipe');
        const res = await request.post(lockUrl(workId, 'not-a-uuid'), {
            headers: { ...authedHeaders(token), 'content-type': 'application/json' },
            data: { mode: LOCK_FULL },
        });
        expect(res.status(), 'non-UUID docId → 400 (ParseUUIDPipe)').toBe(400);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3 — LOCK / UNLOCK on a MISSING doc (owner). The role gate passes (owner),
    // then findById returns null → a clean 404, not a 5xx. (Siblings test
    // missing-doc only for history/restore, never lock/unlock.)
    // ─────────────────────────────────────────────────────────────────────────
    test('lock + unlock on a missing doc (owner) → 404', async ({ request }) => {
        test.setTimeout(120_000);
        const { token, workId } = await freshOwnerWorkDoc(request, 'LockMissing');

        const lk = await lock(request, token, workId, MISSING_DOC, LOCK_FULL);
        expect(lk.status, 'lock missing doc → 404').toBe(404);
        expect(msgOf(lk.body)).toContain('not found');

        const ul = await unlock(request, token, workId, MISSING_DOC);
        expect(ul.status, 'unlock missing doc → 404').toBe(404);
        expect(msgOf(ul.body)).toContain('not found');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4 — LOCK IDEMPOTENCY + direct mode-SWAP without an intervening unlock.
    // Re-locking `full` twice is idempotent; locking `additions-only` while
    // already full-locked SWAPS the mode in place (no unlock first). The doc
    // stays `locked:true` throughout. (Siblings escalate via the UI flow but
    // never assert the bare re-lock idempotency / in-place swap contract.)
    // ─────────────────────────────────────────────────────────────────────────
    test('lock is idempotent and supports a direct full↔additions mode swap', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token, workId, docId } = await freshOwnerWorkDoc(request, 'LockIdem');

        const first = await lock(request, token, workId, docId, LOCK_FULL);
        expect(first.status).toBe(200);
        expect((first.body as KbBodyDto).locked).toBe(true);
        expect((first.body as KbBodyDto).lockMode).toBe(LOCK_FULL);

        // Re-lock full → still locked full (idempotent, no 409).
        const again = await lock(request, token, workId, docId, LOCK_FULL);
        expect(again.status, 're-lock full → 200').toBe(200);
        expect((again.body as KbBodyDto).locked).toBe(true);
        expect((again.body as KbBodyDto).lockMode).toBe(LOCK_FULL);

        // Swap to additions-only WITHOUT unlocking first → mode changes in place.
        const swap = await lock(request, token, workId, docId, LOCK_ADDITIONS_ONLY);
        expect(swap.status, 'mode swap → 200').toBe(200);
        expect((swap.body as KbBodyDto).locked, 'still locked after the swap').toBe(true);
        expect((swap.body as KbBodyDto).lockMode, 'mode swapped in place').toBe(
            LOCK_ADDITIONS_ONLY,
        );

        // Swap back to full directly.
        const back = await lock(request, token, workId, docId, LOCK_FULL);
        expect(back.status).toBe(200);
        expect((back.body as KbBodyDto).lockMode).toBe(LOCK_FULL);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5 — UNLOCK IDEMPOTENCY: unlocking an already-unlocked doc is a clean 200
    // `{locked:false,lockMode:null}` (NOT a 409/404). Lock→unlock→unlock cycles
    // converge on the unlocked state. (Siblings unlock once; never twice.)
    // ─────────────────────────────────────────────────────────────────────────
    test('unlock is idempotent: unlocking an already-unlocked doc → 200 locked:false', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token, workId, docId } = await freshOwnerWorkDoc(request, 'UnlockIdem');

        // Unlock a never-locked doc → 200, already false.
        const u0 = await unlock(request, token, workId, docId);
        expect(u0.status, 'unlock never-locked doc → 200').toBe(200);
        expect((u0.body as KbBodyDto).locked).toBe(false);
        expect((u0.body as KbBodyDto).lockMode).toBeNull();

        // Lock, then unlock twice — the second unlock is still a clean 200.
        expect((await lock(request, token, workId, docId, LOCK_FULL)).status).toBe(200);
        const u1 = await unlock(request, token, workId, docId);
        expect(u1.status).toBe(200);
        expect((u1.body as KbBodyDto).locked).toBe(false);
        const u2 = await unlock(request, token, workId, docId);
        expect(u2.status, 'second consecutive unlock → 200 (idempotent)').toBe(200);
        expect((u2.body as KbBodyDto).locked).toBe(false);
        expect((u2.body as KbBodyDto).lockMode).toBeNull();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 6 — RESTORE `commitSha` HEX guard (`@Matches(/^[0-9a-f]{7,40}$/)`). The
    // sibling restore spec asserts ONLY the @Length short-sha 400. This pins the
    // hex-only guard (prevents arbitrary git refs): symbolic refs, branch names,
    // and UPPERCASE hex are all 400 with the hex message — a SECURITY contract.
    // ─────────────────────────────────────────────────────────────────────────
    test('restore commitSha hex guard: symbolic refs / branch names / uppercase → 400', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token, workId, docId } = await freshOwnerWorkDoc(request, 'RestoreHex');

        // Symbolic ref `HEAD~1` — non-hex AND under-length: 400 carries BOTH the
        // hex and the length messages.
        const headRef = await restore(request, token, workId, docId, 'HEAD~1');
        expect(headRef.status, 'HEAD~1 → 400').toBe(400);
        expect(msgOf(headRef.body)).toContain('commitSha must be a hexadecimal Git SHA');

        // Branch ref — long enough but non-hex → 400 on the hex rule alone.
        const branch = await restore(request, token, workId, docId, 'refs/heads/main');
        expect(branch.status, 'refs/heads/main → 400').toBe(400);
        expect(msgOf(branch.body)).toContain('hexadecimal Git SHA');

        // UPPERCASE 40-char hex — the guard is lowercase-only → 400.
        const upper = await restore(
            request,
            token,
            workId,
            docId,
            'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
        );
        expect(upper.status, 'uppercase hex → 400 (lowercase-only guard)').toBe(400);
        expect(msgOf(upper.body)).toContain('hexadecimal Git SHA');

        // Absent commitSha → 400 (the field is required).
        const absent = await restore(request, token, workId, docId, undefined);
        expect(absent.status, 'absent commitSha → 400').toBe(400);

        // The doc body is untouched by every rejected restore.
        const after = await request.get(`${API_BASE}/api/works/${workId}/kb/documents/${docId}`, {
            headers: authedHeaders(token),
        });
        expect(((await after.json()) as { body: string }).body).toContain('seed body');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 7 — RESTORE commitSha LENGTH boundaries (`@Length(7,40)`). 6 chars → 400;
    // 7 chars (min) is NOT a length-400 (reaches the mirror); 41 chars → 400.
    // A well-formed 40-hex sha on an UNLOCKED owner doc reaches the wired CI
    // mirror — which has no repo → 500 here (a repo-backed deploy would 200/404,
    // tolerated). Never a 400/403 for the owner with a valid sha.
    // ─────────────────────────────────────────────────────────────────────────
    test('restore commitSha length boundaries: 6→400, 7→reaches mirror, 41→400; valid sha is gate-clean', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token, workId, docId } = await freshOwnerWorkDoc(request, 'RestoreLen');

        const six = await restore(request, token, workId, docId, 'abc123'); // 6 hex chars.
        expect(six.status, '6-char sha → 400').toBe(400);
        expect(msgOf(six.body)).toMatch(/longer than or equal to 7/i);

        const fortyOne = await restore(
            request,
            token,
            workId,
            docId,
            '0123456789abcdef0123456789abcdef012345678', // 41 hex chars.
        );
        expect(fortyOne.status, '41-char sha → 400').toBe(400);

        // 7-char min-boundary hex sha is a VALID length → it is NOT a 400; it
        // reaches the git mirror (500 in the repoless CI env / 200|404 elsewhere).
        const seven = await restore(request, token, workId, docId, 'abc1234');
        expect(seven.status, '7-char sha is not a length-400').not.toBe(400);
        expect(
            RESTORE_REACHED_MIRROR.includes(
                seven.status as (typeof RESTORE_REACHED_MIRROR)[number],
            ),
            `7-char sha reaches the mirror (got ${seven.status})`,
        ).toBeTruthy();

        // A full 40-hex sha on the UNLOCKED owner doc: owner clears manager+,
        // the DTO passes, the existence check passes → it reaches the mirror.
        // Never a 400 (valid sha) and never a 403 (owner).
        const full = await restore(request, token, workId, docId, VALID_SHA);
        expect(full.status, 'valid sha is never a client 400').not.toBe(400);
        expect(full.status, 'owner valid-sha restore is never a 403').not.toBe(403);
        expect(
            RESTORE_REACHED_MIRROR.includes(full.status as (typeof RESTORE_REACHED_MIRROR)[number]),
            `valid-sha restore reaches the mirror (got ${full.status})`,
        ).toBeTruthy();
        if (full.status !== 200) {
            test.info().annotations.push({
                type: 'mirror-no-repo',
                description:
                    'CI sqlite env: the wired KB git mirror has no real repo, so a well-formed restore sha 500s at the body-at-commit read. The manager+ gate + DTO validation + reachability are pinned; the 200 restored-DTO branch needs a repo-backed deployment.',
            });
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 8 — GUARD ORDERING on /restore: the global ValidationPipe runs BEFORE the
    // ownership guard, which runs BEFORE the existence check. Probed precisely:
    //   non-member + non-hex sha on a missing doc → 400 (DTO wins over both)
    //   non-member + valid sha on a missing doc   → 403 (ownership over existence)
    //   owner      + valid sha on a missing doc   → 404 (existence)
    // This three-way split is a TRUTHFUL ordering contract no sibling pins.
    // ─────────────────────────────────────────────────────────────────────────
    test('restore guard ordering: DTO(400) before ownership(403) before existence(404)', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token: ownerToken, workId } = await freshOwnerWorkDoc(request, 'RestoreOrder');
        const outsider = await registerUserViaAPI(request, { name: `RestoreOut ${uniq()}` });

        // DTO validation fires FIRST — even for a non-member on a missing doc.
        const dtoWins = await restore(request, outsider.access_token, workId, MISSING_DOC, 'HEAD');
        expect(dtoWins.status, 'non-hex sha → 400 even for an outsider on a missing doc').toBe(400);
        expect(msgOf(dtoWins.body)).toContain('hexadecimal Git SHA');

        // With a VALID sha, ownership wins over existence — the outsider never
        // learns whether the doc exists (403, not 404).
        const ownershipWins = await restore(
            request,
            outsider.access_token,
            workId,
            MISSING_DOC,
            VALID_SHA,
        );
        expect(
            ownershipWins.status,
            'outsider + valid sha + missing doc → 403 (ownership over existence)',
        ).toBe(403);

        // The owner with the same valid sha reaches the existence check → 404.
        const existenceWins = await restore(request, ownerToken, workId, MISSING_DOC, VALID_SHA);
        expect(
            existenceWins.status,
            'owner + valid sha + missing doc → 404 (existence reached)',
        ).toBe(404);
        expect(msgOf(existenceWins.body)).toContain('not found');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 9 — CROSS-WORK doc-id CONFUSION. The doc id alone never crosses works:
    // user A's OWNER, addressing user B's docId through A's OWN work route, gets
    // a 404 (the doc is not found UNDER work A) — NOT a 403 (A owns work A) and
    // NOT a leak of B's content. Pinned for lock / unlock / restore / history.
    // The doc remains intact + still readable in B's own work.
    // ─────────────────────────────────────────────────────────────────────────
    test('cross-work confusion: B-doc id via A-route → 404 for lock/unlock/restore/history', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        // A owns work A (with its own doc); B owns work B (with B's doc).
        const a = await freshOwnerWorkDoc(request, 'XworkA');
        const b = await freshOwnerWorkDoc(request, 'XworkB');

        // A, the legitimate owner of work A, points A's route at B's docId.
        const lk = await lock(request, a.token, a.workId, b.docId, LOCK_FULL);
        expect(lk.status, "A locks B's docId via A's route → 404").toBe(404);

        const ul = await unlock(request, a.token, a.workId, b.docId);
        expect(ul.status, "A unlocks B's docId via A's route → 404").toBe(404);

        const rs = await restore(request, a.token, a.workId, b.docId, VALID_SHA);
        expect(rs.status, "A restores B's docId via A's route → 404 (existence, not 403)").toBe(
            404,
        );

        const hist = await request.get(historyUrl(a.workId, b.docId), {
            headers: authedHeaders(a.token),
        });
        expect(hist.status(), "A reads history of B's docId via A's route → 404").toBe(404);

        // B's doc is unharmed in B's own work — still unlocked + readable.
        const bRead = await request.get(
            `${API_BASE}/api/works/${b.workId}/kb/documents/${b.docId}`,
            { headers: authedHeaders(b.token) },
        );
        expect(bRead.status(), "B's doc still readable in B's work").toBe(200);
        const bDoc = (await bRead.json()) as KbBodyDto;
        expect(bDoc.locked, "B's doc untouched by A's cross-work lock attempt").toBe(false);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 10 — HISTORY read GATE under the repoless CI mirror across limit shapes.
    // The mirror is wired but has NO repo, so the commit-log read 500s for every
    // limit form (none / 0 / -5 / non-numeric). The controller's `/^\d+$/` regex
    // turns a non-numeric limit into `undefined` (default 25) — it never 400s on
    // a bad limit; the limit only affects the (repoless → 500) read. A repo-
    // backed deployment would 200 `{items:[]}` (tolerated). We assert the GATE /
    // reachability, never a populated commit log.
    // (doc-scope / clamp / isolation are NOT re-pinned — sibling owns them.)
    // ─────────────────────────────────────────────────────────────────────────
    test('history read is reachable across limit shapes (no 400 on a bad limit) under the repoless mirror', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token, workId, docId } = await freshOwnerWorkDoc(request, 'History');

        const base = await request.get(historyUrl(workId, docId), {
            headers: authedHeaders(token),
        });
        expect(
            HISTORY_REACHABLE.includes(base.status() as (typeof HISTORY_REACHABLE)[number]),
            `history base read reachable (got ${base.status()})`,
        ).toBeTruthy();
        const repoBacked = base.status() === 200;
        if (repoBacked) {
            expect(Array.isArray(((await base.json()) as { items: unknown[] }).items)).toBeTruthy();
        } else {
            test.info().annotations.push({
                type: 'mirror-no-repo',
                description:
                    'CI sqlite env: the wired KB git mirror has no repo, so the commit-log read 500s. The reachability + no-400-on-bad-limit contract is pinned; the populated-items branch needs a repo-backed deployment.',
            });
        }

        // A NON-NUMERIC limit is coerced to undefined by the `/^\d+$/` guard —
        // it never 400s; the status matches the base (limit doesn't change the
        // repoless-500 branch).
        const nonNumeric = await request.get(`${historyUrl(workId, docId)}?limit=abc`, {
            headers: authedHeaders(token),
        });
        expect(nonNumeric.status(), 'non-numeric limit is never a 400').not.toBe(400);
        expect(nonNumeric.status(), 'non-numeric limit takes the base read branch').toBe(
            base.status(),
        );

        // limit=0 and limit=-5 are clamped/parsed server-side (never a 400) and
        // take the same repoless branch.
        for (const lim of ['0', '-5']) {
            const r = await request.get(`${historyUrl(workId, docId)}?limit=${lim}`, {
                headers: authedHeaders(token),
            });
            expect(r.status(), `limit=${lim} is never a 400`).not.toBe(400);
            expect(r.status(), `limit=${lim} takes the base read branch`).toBe(base.status());
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 11 — FULL-LOCK pre-empts UNLOCK-able mutations but NOT the lock toggles.
    // assertNotLockedFull gates PATCH/DELETE/RESTORE; lock/unlock themselves are
    // NOT gated by it (you must be able to re-lock or unlock a full-locked doc).
    // Probed via a single owner: full-lock → PATCH 403 → re-lock 200 (no gate)
    // → unlock 200 (no gate) → PATCH 200. Pins that the lock toggles bypass the
    // assertNotLockedFull gate while the content verbs honour it.
    // ─────────────────────────────────────────────────────────────────────────
    test('full-lock gates content writes but NOT the lock/unlock toggles themselves', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token, workId, docId } = await freshOwnerWorkDoc(request, 'LockToggle');

        expect((await lock(request, token, workId, docId, LOCK_FULL)).status).toBe(200);

        // PATCH is gated by the full lock.
        const blocked = await request.patch(
            `${API_BASE}/api/works/${workId}/kb/documents/${docId}`,
            { headers: authedHeaders(token), data: { description: 'must not apply' } },
        );
        expect(blocked.status(), 'full-locked PATCH → 403').toBe(403);
        expect(msgOf(await blocked.json())).toContain('locked (mode=full)');

        // RE-LOCK is NOT gated by assertNotLockedFull — you can re-lock a locked
        // doc (the toggle endpoints never call the gate).
        const relock = await lock(request, token, workId, docId, LOCK_FULL);
        expect(relock.status, 're-lock a full-locked doc → 200 (toggle bypasses the gate)').toBe(
            200,
        );

        // UNLOCK is likewise not gated — otherwise a full lock would be a trap.
        const un = await unlock(request, token, workId, docId);
        expect(un.status, 'unlock a full-locked doc → 200 (toggle bypasses the gate)').toBe(200);
        expect((un.body as KbBodyDto).locked).toBe(false);

        // After unlock the content write flows again — the gate was the lock.
        const ok = await request.patch(`${API_BASE}/api/works/${workId}/kb/documents/${docId}`, {
            headers: authedHeaders(token),
            data: { description: 'editable post-unlock' },
        });
        expect(ok.status(), 'post-unlock PATCH → 200').toBe(200);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 12 — NON-MEMBER (outsider) is forbidden on EVERY lock-family verb of a
    // foreign work's REAL doc — lock / unlock / restore — via ensureCanEdit, and
    // on history via ensureCanView. 403, never a 404 (the outsider must not be
    // able to probe doc existence). The doc stays unlocked + unharmed.
    // (Sibling pins non-member 403 for restore + history; this adds lock/unlock
    // and ties them into one foreign-doc sweep with the unharmed-doc assertion.)
    // ─────────────────────────────────────────────────────────────────────────
    test('non-member is 403 on lock/unlock/restore/history of a foreign works real doc', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const a = await freshOwnerWorkDoc(request, 'NonMember');
        const outsider = await registerUserViaAPI(request, { name: `NonMemberOut ${uniq()}` });

        const lk = await lock(request, outsider.access_token, a.workId, a.docId, LOCK_FULL);
        expect(lk.status, 'non-member lock → 403').toBe(403);

        const ul = await unlock(request, outsider.access_token, a.workId, a.docId);
        expect(ul.status, 'non-member unlock → 403').toBe(403);

        const rs = await restore(request, outsider.access_token, a.workId, a.docId, VALID_SHA);
        expect(rs.status, 'non-member restore → 403').toBe(403);

        const hist = await request.get(historyUrl(a.workId, a.docId), {
            headers: authedHeaders(outsider.access_token),
        });
        expect(hist.status(), 'non-member history → 403').toBe(403);

        // None of the forbidden calls touched the doc — the owner sees it
        // unlocked + intact.
        const ownerRead = await request.get(
            `${API_BASE}/api/works/${a.workId}/kb/documents/${a.docId}`,
            { headers: authedHeaders(a.token) },
        );
        expect(ownerRead.status()).toBe(200);
        expect(((await ownerRead.json()) as KbBodyDto).locked, 'doc unharmed by outsider').toBe(
            false,
        );
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 13 — LOCK then DELETE-and-recreate path interplay: a full-locked doc
    // blocks DELETE (gated), and after UNLOCK the DELETE succeeds (204). This
    // pins the lock→delete coupling that the lifecycle-deep spec asserts for
    // PATCH but we anchor specifically on DELETE here, with the typed lock 403.
    // ─────────────────────────────────────────────────────────────────────────
    test('full-locked DELETE → 403, then unlock → DELETE 204', async ({ request }) => {
        test.setTimeout(120_000);
        const { token, workId, docId } = await freshOwnerWorkDoc(request, 'LockDelete');

        expect((await lock(request, token, workId, docId, LOCK_FULL)).status).toBe(200);

        const blockedDel = await request.delete(
            `${API_BASE}/api/works/${workId}/kb/documents/${docId}`,
            { headers: authedHeaders(token) },
        );
        expect(blockedDel.status(), 'full-locked DELETE → 403').toBe(403);
        expect(msgOf(await blockedDel.json())).toContain('locked (mode=full)');

        // The doc is still present (the blocked DELETE was a no-op).
        const stillThere = await request.get(
            `${API_BASE}/api/works/${workId}/kb/documents/${docId}`,
            { headers: authedHeaders(token) },
        );
        expect(stillThere.status(), 'doc survives the blocked DELETE').toBe(200);

        // Unlock → DELETE now succeeds (204) and the doc is gone.
        expect((await unlock(request, token, workId, docId)).status).toBe(200);
        const del = await request.delete(`${API_BASE}/api/works/${workId}/kb/documents/${docId}`, {
            headers: authedHeaders(token),
        });
        expect(del.status(), 'post-unlock DELETE → 204').toBe(204);
        const gone = await request.get(`${API_BASE}/api/works/${workId}/kb/documents/${docId}`, {
            headers: authedHeaders(token),
        });
        expect(gone.status(), 'deleted doc → 404').toBe(404);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 14 — ADDITIONS-ONLY lock does NOT gate RESTORE or DELETE (only `full`
    // does, via assertNotLockedFull which checks lockMode==='full'). Probed:
    // under additions-only, a well-formed restore reaches the mirror (not a lock
    // 403) and DELETE succeeds. Pins the truthful "only full pre-empts the
    // restore/delete gate" boundary that distinguishes the two lock modes.
    // ─────────────────────────────────────────────────────────────────────────
    test('additions-only lock does not pre-empt restore or delete (only full does)', async ({
        request,
    }) => {
        test.setTimeout(120_000);
        const { token, workId, docId } = await freshOwnerWorkDoc(request, 'AddOnlyGate');

        const add = await lock(request, token, workId, docId, LOCK_ADDITIONS_ONLY);
        expect(add.status).toBe(200);
        expect((add.body as KbBodyDto).lockMode).toBe(LOCK_ADDITIONS_ONLY);

        // RESTORE under additions-only is NOT lock-403 — it reaches the mirror
        // (500 repoless / 200|404 repo-backed). The lock-mode check only fires
        // for `full`.
        const rs = await restore(request, token, workId, docId, VALID_SHA);
        expect(rs.status, 'additions-only restore is not a lock 403').not.toBe(403);
        expect(
            RESTORE_REACHED_MIRROR.includes(rs.status as (typeof RESTORE_REACHED_MIRROR)[number]),
            `additions-only restore reaches the mirror (got ${rs.status})`,
        ).toBeTruthy();

        // DELETE under additions-only succeeds (only `full` gates delete).
        const del = await request.delete(`${API_BASE}/api/works/${workId}/kb/documents/${docId}`, {
            headers: authedHeaders(token),
        });
        expect(del.status(), 'additions-only DELETE → 204 (not gated)').toBe(204);
    });
});
