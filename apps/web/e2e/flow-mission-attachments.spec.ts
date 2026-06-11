import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * FLOW: MISSION ATTACHMENTS — the `MissionAttachment` sub-resource hung off
 * `/api/me/missions/:id/attachments[/:attachmentId]`
 * (apps/api/src/missions/missions.controller.ts → MissionsService
 * .{list,add,remove}Attachment in packages/agent/src/missions/missions.service.ts,
 * row shape packages/agent/src/entities/mission-attachment.entity.ts). This
 * is the Mission analogue of the Task/Agent attachment edge: it associates a
 * content-addressed Upload (the sha256 `id` from `POST /api/uploads/file`)
 * with a Mission so the PromptComposer's "files attached when creating a
 * Mission" flow has a persistence target.
 *
 * GROUNDING — every status/body/message below was probed against the LIVE
 * stack (API :3100, sqlite in-memory, REQUIRE_EMAIL_VERIFICATION=false,
 * keyless) with curl + throwaway users on 2026-06-11, then cross-checked
 * against source. Key surprises that drove the assertions:
 *   - `uploadId` is NOT UUID-shaped. The DTO (AddMissionAttachmentDto) guards
 *     it with `@Matches(/^[0-9a-f]{64}$/i)` and the entity column is
 *     `varchar(64)` — it stores the sha256 content hash, not a uuid (Codex +
 *     Greptile P1 on PR #1044). A uuid-shaped value is therefore a 400, not a
 *     valid id. The DTO's class-validator message fires BEFORE the service's
 *     own `Invalid uploadId` BadRequest, so the wire message is the regex one.
 *   - Ownership is opaque: every cross-user / unknown-mission path collapses
 *     to 404 `"Mission not found"` (findOrThrow scopes by {id,userId}); the
 *     API never leaks whether the id exists for another user.
 *   - Attach is idempotent at the unique (missionId, uploadId) index: a second
 *     POST of the SAME uploadId returns 201 with the SAME row (no duplicate).
 *   - Delete is NOT idempotent: the second DELETE of a removed/unknown
 *     attachmentId is 404 `"Attachment not found"`.
 *
 * PROBED CONTRACTS (live, 2026-06-11):
 *   GET    :id/attachments               own mission -> 200 [] (fresh), then
 *                                         [row] after an attach
 *   POST   :id/attachments {uploadId}    own mission, sha256 uploadId -> 201
 *       { id:<uuid>, missionId:<uuid>, uploadId:<sha256>, createdAt:<iso> }
 *       (NO upload metadata echoed — the edge stores only the hash)
 *   POST   re-attach same uploadId       -> 201 SAME row (idempotent index)
 *   POST   {uploadId:<uuid>}             -> 400 ["uploadId must match
 *                                         /^[0-9a-f]{64}$/i regular expression"]
 *   POST   {} (missing uploadId)         -> 400 [regex msg, "uploadId must be
 *                                         a string"]
 *   POST   cross-user (B -> A's mission) -> 404 "Mission not found"
 *   GET    cross-user list               -> 404 "Mission not found"
 *   POST   attach to unknown missionId   -> 404 "Mission not found"
 *   POST   malformed missionId (not uuid)-> 400 "Validation failed (uuid is
 *                                         expected)" (ParseUUIDPipe)
 *   DELETE :id/attachments/:attId        own, real id -> 200 { deleted:true }
 *   DELETE same id again                 -> 404 "Attachment not found"
 *   DELETE unknown (valid-uuid) attId    -> 404 "Attachment not found"
 *   DELETE cross-user (B -> A's att)     -> 404 "Mission not found"
 *   DELETE malformed attachmentId        -> 400 "Validation failed (uuid is
 *                                         expected)" (ParseUUIDPipe)
 *   anon list/attach/delete              -> 401 "Unauthorized"
 *   uppercase-hex uploadId               -> 201 (regex is /i); stored verbatim
 *                                         so it is a DISTINCT row from the
 *                                         lowercase form (case-sensitive index)
 *
 * NON-DUPLICATION:
 *   - missions.spec.ts owns the Mission CRUD + lifecycle (pause/resume/
 *     complete) + budget contract and the unknown-id 404 matrix on those
 *     routes; it does NOT touch `/attachments` at all. This file is the sole
 *     owner of the Mission attachment sub-resource.
 *   - flow-mission-clone.spec.ts / flow-mission-clone-fork.spec.ts own clone/
 *     guardrails/isolation; agents-advanced.spec.ts pins the AGENT
 *     `/attachments` GET (empty array only). Neither attaches a real upload
 *     to a mission, and the Agent file never exercises POST/DELETE.
 *   - flow-uploads-matrix-deep.spec.ts owns the UploadsController storage /
 *     sha256 / MIME contract; here we only consume `POST /api/uploads/file`
 *     to MINT a real uploadId, asserting nothing about the upload itself.
 *
 * ADAPTIVITY: pure authz / validation / persistence contracts over the API
 * tier — no LLM key, no mail, no Redis, no search provider. No AI generation
 * is relied on (missions are seeded via `POST /api/me/missions` exactly the
 * way missions.spec.ts does). The single anonymous case uses a raw fetch with
 * no Authorization header (no shared storageState involved).
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

// Per-test counter for unique-but-clock-free suffixes (house rule: never call
// a clock at module scope; the increment runs inside each test body).
let seq = 0;
function nextSuffix(): string {
    seq += 1;
    return `ma${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Create a one-shot Mission for `token` and return its id. */
async function createMission(
    request: APIRequestContext,
    token: string,
    description: string,
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: { description, type: 'one-shot' },
    });
    expect(res.status(), `create mission body=${await res.text()}`).toBe(201);
    return (await res.json()).id as string;
}

/**
 * Upload a tiny markdown file via `POST /api/uploads/file` and return the
 * content-addressed sha256 `id` to use as an attachment `uploadId`. (There is
 * no shared upload helper in helpers/api.ts; this is local to this spec.)
 */
async function mintUploadId(request: APIRequestContext, token: string): Promise<string> {
    const res = await request.post(`${API_BASE}/api/uploads/file`, {
        headers: authedHeaders(token),
        multipart: {
            file: {
                name: `${nextSuffix()}.md`,
                mimeType: 'text/markdown',
                buffer: Buffer.from(`# attachment ${nextSuffix()}\n`),
            },
        },
    });
    expect(res.status(), `upload body=${await res.text()}`).toBe(201);
    const id = (await res.json()).id as string;
    expect(id, 'upload id is a sha256 hex').toMatch(SHA256_HEX);
    return id;
}

test.describe('FLOW: mission attachments — attach / list / delete', () => {
    test('attach an upload to own mission -> 201 edge DTO; it appears in the list', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const headers = authedHeaders(owner.access_token);
        const missionId = await createMission(
            request,
            owner.access_token,
            'attach-and-list mission',
        );
        const uploadId = await mintUploadId(request, owner.access_token);

        // Fresh mission: empty attachment list.
        const before = await request.get(`${API_BASE}/api/me/missions/${missionId}/attachments`, {
            headers,
        });
        expect(before.status()).toBe(200);
        expect(await before.json()).toEqual([]);

        // Attach -> 201 with the MissionAttachment edge DTO. The edge carries
        // ONLY the hash + ids + timestamp — no upload filename/size/mime echo.
        const attach = await request.post(`${API_BASE}/api/me/missions/${missionId}/attachments`, {
            headers,
            data: { uploadId },
        });
        expect(attach.status(), `attach body=${await attach.text()}`).toBe(201);
        const edge = await attach.json();
        expect(edge.id, 'attachment id is a generated uuid').toMatch(UUID_RE);
        expect(edge.missionId).toBe(missionId);
        expect(edge.uploadId).toBe(uploadId);
        expect(edge.createdAt).toMatch(ISO_RE);
        // The edge is exactly these four keys — no leaked upload metadata.
        expect(Object.keys(edge).sort()).toEqual(['createdAt', 'id', 'missionId', 'uploadId']);

        // List now reflects the single edge.
        const after = await request.get(`${API_BASE}/api/me/missions/${missionId}/attachments`, {
            headers,
        });
        expect(after.status()).toBe(200);
        const list = await after.json();
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ id: edge.id, missionId, uploadId });
    });

    test('re-attaching the SAME uploadId is idempotent -> 201 same row, list stays length 1', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const headers = authedHeaders(owner.access_token);
        const missionId = await createMission(
            request,
            owner.access_token,
            'idempotent-attach mission',
        );
        const uploadId = await mintUploadId(request, owner.access_token);

        const first = await request.post(`${API_BASE}/api/me/missions/${missionId}/attachments`, {
            headers,
            data: { uploadId },
        });
        expect(first.status()).toBe(201);
        const firstEdge = await first.json();

        // The unique (missionId, uploadId) index swallows the duplicate and
        // re-reads the existing row — same edge id, still 201, no second row.
        const second = await request.post(`${API_BASE}/api/me/missions/${missionId}/attachments`, {
            headers,
            data: { uploadId },
        });
        expect(second.status(), `re-attach body=${await second.text()}`).toBe(201);
        expect((await second.json()).id).toBe(firstEdge.id);

        const list = await (
            await request.get(`${API_BASE}/api/me/missions/${missionId}/attachments`, { headers })
        ).json();
        expect(list).toHaveLength(1);
    });

    test('two distinct uploads attach as two distinct edges on the same mission', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const headers = authedHeaders(owner.access_token);
        const missionId = await createMission(request, owner.access_token, 'multi-attach mission');
        const uploadA = await mintUploadId(request, owner.access_token);
        const uploadB = await mintUploadId(request, owner.access_token);
        expect(uploadA).not.toBe(uploadB);

        for (const uploadId of [uploadA, uploadB]) {
            const res = await request.post(`${API_BASE}/api/me/missions/${missionId}/attachments`, {
                headers,
                data: { uploadId },
            });
            expect(res.status()).toBe(201);
        }

        const list = await (
            await request.get(`${API_BASE}/api/me/missions/${missionId}/attachments`, { headers })
        ).json();
        expect(list).toHaveLength(2);
        expect(new Set(list.map((r: { uploadId: string }) => r.uploadId))).toEqual(
            new Set([uploadA, uploadB]),
        );
    });

    test('delete an attachment -> 200 { deleted: true }; list shrinks; second delete -> 404', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const headers = authedHeaders(owner.access_token);
        const missionId = await createMission(request, owner.access_token, 'delete-attach mission');
        const uploadId = await mintUploadId(request, owner.access_token);

        const attachmentId = (
            await (
                await request.post(`${API_BASE}/api/me/missions/${missionId}/attachments`, {
                    headers,
                    data: { uploadId },
                })
            ).json()
        ).id as string;

        const del = await request.delete(
            `${API_BASE}/api/me/missions/${missionId}/attachments/${attachmentId}`,
            { headers },
        );
        expect(del.status(), `delete body=${await del.text()}`).toBe(200);
        expect(await del.json()).toEqual({ deleted: true });

        // Edge gone from the list.
        const list = await (
            await request.get(`${API_BASE}/api/me/missions/${missionId}/attachments`, { headers })
        ).json();
        expect(list).toEqual([]);

        // Delete is NOT idempotent — the row is gone, so 404.
        const again = await request.delete(
            `${API_BASE}/api/me/missions/${missionId}/attachments/${attachmentId}`,
            { headers },
        );
        expect(again.status()).toBe(404);
        expect((await again.json()).message).toBe('Attachment not found');
    });
});

test.describe('FLOW: mission attachments — validation + ownership', () => {
    test('uploadId must be sha256-hex: a uuid-shaped value -> 400 regex message', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const headers = authedHeaders(owner.access_token);
        const missionId = await createMission(request, owner.access_token, 'bad-uploadid mission');

        const res = await request.post(`${API_BASE}/api/me/missions/${missionId}/attachments`, {
            headers,
            data: { uploadId: UNKNOWN_UUID },
        });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.error).toBe('Bad Request');
        expect(body.message).toContain('uploadId must match /^[0-9a-f]{64}$/i regular expression');
    });

    test('missing uploadId field -> 400 with both string + regex validation messages', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const headers = authedHeaders(owner.access_token);
        const missionId = await createMission(
            request,
            owner.access_token,
            'missing-uploadid mission',
        );

        const res = await request.post(`${API_BASE}/api/me/missions/${missionId}/attachments`, {
            headers,
            data: {},
        });
        expect(res.status()).toBe(400);
        const messages: string[] = (await res.json()).message;
        expect(messages).toContain('uploadId must be a string');
        expect(messages.some((m) => m.includes('must match'))).toBe(true);
    });

    test('uppercase-hex uploadId is accepted (regex /i) and stored verbatim as a distinct row', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const headers = authedHeaders(owner.access_token);
        const missionId = await createMission(request, owner.access_token, 'uppercase-hex mission');
        const lower = await mintUploadId(request, owner.access_token);
        const upper = lower.toUpperCase();
        expect(upper).not.toBe(lower);

        const a = await request.post(`${API_BASE}/api/me/missions/${missionId}/attachments`, {
            headers,
            data: { uploadId: lower },
        });
        expect(a.status()).toBe(201);
        const b = await request.post(`${API_BASE}/api/me/missions/${missionId}/attachments`, {
            headers,
            data: { uploadId: upper },
        });
        // Same /i regex passes; the stored varchar(64) differs by case, so the
        // unique (missionId, uploadId) index does NOT collapse them.
        expect(b.status(), `uppercase attach body=${await b.text()}`).toBe(201);
        expect((await b.json()).uploadId).toBe(upper);

        const list = await (
            await request.get(`${API_BASE}/api/me/missions/${missionId}/attachments`, { headers })
        ).json();
        expect(list).toHaveLength(2);
    });

    test('malformed missionId on attach -> 400 ParseUUIDPipe (uuid expected)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const headers = authedHeaders(owner.access_token);
        const uploadId = await mintUploadId(request, owner.access_token);

        const res = await request.post(`${API_BASE}/api/me/missions/not-a-uuid/attachments`, {
            headers,
            data: { uploadId },
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).message).toBe('Validation failed (uuid is expected)');
    });

    test('malformed attachmentId on delete -> 400 ParseUUIDPipe (uuid expected)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const headers = authedHeaders(owner.access_token);
        const missionId = await createMission(request, owner.access_token, 'bad-attid mission');

        const res = await request.delete(
            `${API_BASE}/api/me/missions/${missionId}/attachments/not-a-uuid`,
            { headers },
        );
        expect(res.status()).toBe(400);
        expect((await res.json()).message).toBe('Validation failed (uuid is expected)');
    });

    test('delete of an unknown (well-formed uuid) attachmentId -> 404 Attachment not found', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const headers = authedHeaders(owner.access_token);
        const missionId = await createMission(request, owner.access_token, 'unknown-attid mission');

        const res = await request.delete(
            `${API_BASE}/api/me/missions/${missionId}/attachments/${UNKNOWN_UUID}`,
            { headers },
        );
        expect(res.status()).toBe(404);
        expect((await res.json()).message).toBe('Attachment not found');
    });

    test('attaching / listing on a nonexistent mission -> 404 Mission not found', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const headers = authedHeaders(owner.access_token);
        const uploadId = await mintUploadId(request, owner.access_token);

        const attach = await request.post(
            `${API_BASE}/api/me/missions/${UNKNOWN_UUID}/attachments`,
            { headers, data: { uploadId } },
        );
        expect(attach.status()).toBe(404);
        expect((await attach.json()).message).toBe('Mission not found');

        const list = await request.get(`${API_BASE}/api/me/missions/${UNKNOWN_UUID}/attachments`, {
            headers,
        });
        expect(list.status()).toBe(404);
        expect((await list.json()).message).toBe('Mission not found');
    });

    test('cross-user isolation: B cannot list/attach/delete on A’s mission -> 404 (opaque)', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const aliceHeaders = authedHeaders(alice.access_token);
        const bobHeaders = authedHeaders(bob.access_token);

        const missionId = await createMission(request, alice.access_token, 'cross-user mission');
        const aliceUpload = await mintUploadId(request, alice.access_token);
        const attachmentId = (
            await (
                await request.post(`${API_BASE}/api/me/missions/${missionId}/attachments`, {
                    headers: aliceHeaders,
                    data: { uploadId: aliceUpload },
                })
            ).json()
        ).id as string;

        // B's own upload, but A's mission — ownership is checked on the MISSION
        // first, so it 404s with the opaque "Mission not found" before the
        // uploadId is even considered.
        const bobUpload = await mintUploadId(request, bob.access_token);
        const bAttach = await request.post(`${API_BASE}/api/me/missions/${missionId}/attachments`, {
            headers: bobHeaders,
            data: { uploadId: bobUpload },
        });
        expect(bAttach.status()).toBe(404);
        expect((await bAttach.json()).message).toBe('Mission not found');

        const bList = await request.get(`${API_BASE}/api/me/missions/${missionId}/attachments`, {
            headers: bobHeaders,
        });
        expect(bList.status()).toBe(404);

        // B cannot delete A's real attachment edge either.
        const bDelete = await request.delete(
            `${API_BASE}/api/me/missions/${missionId}/attachments/${attachmentId}`,
            { headers: bobHeaders },
        );
        expect(bDelete.status()).toBe(404);
        expect((await bDelete.json()).message).toBe('Mission not found');

        // And A's edge is untouched — the cross-user calls were no-ops.
        const stillThere = await (
            await request.get(`${API_BASE}/api/me/missions/${missionId}/attachments`, {
                headers: aliceHeaders,
            })
        ).json();
        expect(stillThere).toHaveLength(1);
        expect(stillThere[0].id).toBe(attachmentId);
    });

    test('anonymous list / attach / delete are all 401', async ({ request }) => {
        // No Authorization header on any call. The request fixture carries no
        // storageState, so these are genuinely unauthenticated.
        const list = await request.get(`${API_BASE}/api/me/missions/${UNKNOWN_UUID}/attachments`);
        expect(list.status()).toBe(401);

        const attach = await request.post(
            `${API_BASE}/api/me/missions/${UNKNOWN_UUID}/attachments`,
            { data: { uploadId: 'a'.repeat(64) } },
        );
        expect(attach.status()).toBe(401);

        const del = await request.delete(
            `${API_BASE}/api/me/missions/${UNKNOWN_UUID}/attachments/${UNKNOWN_UUID}`,
        );
        expect(del.status()).toBe(401);
    });
});
