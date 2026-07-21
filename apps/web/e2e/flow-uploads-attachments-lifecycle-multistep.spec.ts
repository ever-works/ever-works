import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * FLOW: UPLOADS → ATTACHMENTS LIFECYCLE (MULTI-STEP) — the end-to-end arc that
 * ties a first-class `user_uploads` row (minted by `POST /api/uploads/file`)
 * to the ATTACHMENT edge surfaces that reference it, with ownership isolation
 * pinned at every hop. The spotlight is the AGENT attachment sub-resource
 * (`/api/agents/:id/attachments`), which — unlike the bare Mission edge —
 * enriches its LIST response by JOINing the owner's `user_uploads` metadata
 * (originalFilename / mimeType / fileSize) and rebuilding the owner-gated
 * serve URL. A modest TASK attachment section pins the DISTINCT contract of
 * that sibling surface (UUID uploadId → `work_knowledge_uploads`, Work-scope
 * required). Avatar (`avatarImageUploadId`) is exercised as the third
 * upload-reference on an Agent.
 *
 *   apps/api/src/uploads/uploads.controller.ts   POST /api/uploads/file → sha256 id
 *   apps/api/src/agents/agents.controller.ts     GET/POST/DELETE :id/attachments
 *   apps/api/src/agents/dto/agent.dto.ts          AddAgentAttachmentDto (@Matches sha256),
 *                                                 CreateAgentDto.avatarImageUploadId (@IsUUID)
 *   packages/agent/src/agents/agents.service.ts   addAttachment ownership 404,
 *                                                 listAttachments user_uploads enrichment,
 *                                                 validateAvatarFields
 *   packages/agent/src/entities/user-upload.entity.ts   the first-class row
 *   packages/agent/src/entities/agent-attachment.entity.ts   the edge (varchar(64) sha256)
 *   apps/api/src/tasks/tasks.controller.ts        POST :id/attachments (AddAttachmentDto @IsUUID)
 *   packages/agent/src/tasks-domain/tasks.service.ts   addAttachment Work-scope guard
 *
 * GROUNDING — every status/body/message/header below was probed against the
 * LIVE stack (API :3100, sqlite in-memory, all flags ON,
 * REQUIRE_EMAIL_VERIFICATION=false, keyless) with curl + throwaway users on
 * 2026-07-21, then cross-checked against source.
 *
 * PROBED CONTRACTS (live, 2026-07-21):
 *   POST /api/uploads/file (text/markdown) → 201 { id:<sha256>, hash===id,
 *       filename:'<sha256>.md', url:'/api/uploads/<uid>/<sha>.md',
 *       key:'<uid>/<sha>.md', size, mimeType:'text/markdown' }
 *   POST /api/agents {scope:'tenant',name}  → 201 Agent (status:'draft',
 *       avatarMode:'initials', avatarImageUploadId:null)
 *   GET  /api/agents/:id/attachments (fresh)   → 200 []
 *   POST /api/agents/:id/attachments {uploadId:<sha>}  → 201 BARE edge
 *       { agentId, uploadId, id:<uuid>, createdAt:<iso> } (4 keys, NO metadata)
 *   GET  /api/agents/:id/attachments (after)   → 200 [ ENRICHED row ]
 *       { id, agentId, uploadId, createdAt, filename:<originalName>,
 *         mimeType:'text/markdown', sizeBytes:<number>, url:'/api/uploads/…' }
 *   GET  <enriched.url>  (owner)              → 200 + exact bytes, hardening
 *       headers (CSP default-src 'none', X-Content-Type-Options nosniff)
 *   POST re-attach SAME uploadId              → 201 SAME bare edge (idempotent
 *                                               on the unique (agentId,uploadId))
 *   same upload on TWO agents                 → 201 each; both enriched-list it
 *   POST {uploadId:<uuid>}                    → 400 ["uploadId must match
 *                                               /^[0-9a-f]{64}$/i regular expression"]
 *   POST {} (missing)                         → 400 [regex msg, "uploadId must
 *                                               be a string"]
 *   POST foreign upload (Alice's sha on Bob's OWN agent) → 404
 *       "Upload <sha> not found." (user_uploads keyed by owner → no dangling edge)
 *   POST ghost sha (never uploaded)           → 404 "Upload <sha> not found."
 *   POST cross-user (B → A's agent)           → 404 "Agent <id> not found." (opaque)
 *   GET  cross-user list                      → 404 "Agent <id> not found."
 *   DELETE cross-user (B → A's edge)          → 404 "Agent <id> not found.";
 *                                               A's edge untouched
 *   POST unknown (valid-uuid) agentId         → 404 "Agent <uuid> not found."
 *   POST/GET malformed agentId (not uuid)     → 400 "Validation failed (uuid is expected)"
 *   DELETE :id/attachments/:attId (own)       → 200 { deleted:true }; list empties
 *   DELETE same attId again                   → 404 "Attachment not found"
 *   anon list/attach/delete                   → 401 { message:'Unauthorized', statusCode:401 }
 *   AVATAR (create):
 *     avatarMode:'image' + NO avatarImageUploadId → 400 "avatarImageUploadId
 *         required when avatarMode=image"
 *     avatarMode:'image' + <uuid>            → 201, avatarImageUploadId echoed
 *     avatarMode:'initials' + <uuid>         → 201, avatarImageUploadId:null (ignored)
 *     avatarMode:'image' + non-uuid          → 400 ["avatarImageUploadId must be a UUID"]
 *   TASK attachments (DISTINCT family — work_knowledge_uploads, UUID uploadId):
 *     POST /api/tasks/:id/attachments {uploadId:<sha256>} → 400 ["uploadId must be a UUID"]
 *     POST … {uploadId:<uuid>} on a non-Work task → 400 "Task attachments require a
 *         Work-scoped task so upload ownership can be verified."
 *     GET  fresh                              → 200 []
 *     cross-user attach/list                  → 404 "Task <id> not found."
 *     anon                                    → 401
 *
 * NON-DUPLICATION:
 *   - flow-uploads-matrix-deep.spec.ts owns the UploadsController storage /
 *     sha256 content-addressing / MIME matrix / size caps / serve MIME
 *     collapse. This file does NOT re-pin those; it only CONSUMES
 *     `POST /api/uploads/file` to mint real ids, and does exactly ONE serve
 *     round-trip to prove the ATTACHMENT surface's enriched url resolves.
 *   - flow-mission-attachments.spec.ts owns the Mission (bare-edge) attachment
 *     surface + the Mission upload-ownership 404. This file owns the AGENT
 *     (enriched-edge) surface + the avatar + the TASK sub-resource — distinct
 *     entities; it never touches /api/me/missions.
 *   - sec-pin-uploads-auth.spec.ts owns the anon-401 matrix on the UPLOAD
 *     routes + the cross-user serve 404. Here the only serve call is an OWNER
 *     200 through the agent-list-derived url; the 401s pinned here are on the
 *     AGENT / TASK attachment routes, not the upload routes.
 *   - agents-advanced.spec.ts pins ONLY the empty GET /api/agents/:id/attachments.
 *     This file adds POST/DELETE, the user_uploads-enriched list shape,
 *     idempotency, cross-user isolation, and the avatar create matrix.
 *   - flow-task-{collaboration,chat-messages,full-multistep}.spec.ts cover the
 *     Task CHAT attachments (`POST /api/tasks/:id/chat {attachments}`), a
 *     different route from the Task attachment SUB-RESOURCE pinned here.
 *
 * ADAPTIVITY: pure authz / validation / persistence contracts over the API
 * tier — no LLM key, no mail, no Redis, no search provider, no Trigger.dev.
 * The single anonymous case uses a header-less request (the fixture carries no
 * storageState, so it is genuinely unauthenticated).
 */

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';
const SAMPLE_UUID = '11111111-1111-4111-8111-111111111111';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

// Per-test counter for unique-but-clock-free suffixes (house rule: never call a
// clock at module scope; the increment runs inside each test body).
let seq = 0;
function nextSuffix(): string {
    seq += 1;
    return `ual${seq}-${Math.random().toString(36).slice(2, 6)}`;
}

interface MintedUpload {
    id: string;
    filename: string;
    originalName: string;
    mimeType: string;
    size: number;
    url: string;
}

/**
 * Upload a tiny markdown file via `POST /api/uploads/file` and return the
 * first-class content-addressed record (its sha256 `id` is what attachments
 * reference). `body` defaults to a unique string so distinct calls yield
 * distinct hashes unless a caller pins the bytes.
 */
async function mintUpload(
    request: APIRequestContext,
    token: string,
    opts: { body?: string; originalName?: string } = {},
): Promise<MintedUpload> {
    const originalName = opts.originalName ?? `${nextSuffix()}.md`;
    const body = opts.body ?? `# attachment ${nextSuffix()}\n`;
    const res = await request.post(`${API_BASE}/api/uploads/file`, {
        headers: authedHeaders(token),
        multipart: {
            file: { name: originalName, mimeType: 'text/markdown', buffer: Buffer.from(body) },
        },
    });
    expect(res.status(), `upload body=${await res.text()}`).toBe(201);
    const json = await res.json();
    expect(json.id, 'upload id is a sha256 hex').toMatch(SHA256_HEX);
    return {
        id: json.id,
        filename: json.filename,
        originalName,
        mimeType: json.mimeType,
        size: json.size,
        url: json.url,
    };
}

/** Create a tenant-scoped Agent (no mission/idea/work required) and return it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createAgent(
    request: APIRequestContext,
    token: string,
    extra: Record<string, unknown> = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
    const res = await request.post(`${API_BASE}/api/agents`, {
        headers: authedHeaders(token),
        data: { scope: 'tenant', name: `Agent ${nextSuffix()}`, ...extra },
    });
    expect(res.status(), `create agent body=${await res.text()}`).toBe(201);
    return res.json();
}

async function createAgentId(
    request: APIRequestContext,
    token: string,
    extra: Record<string, unknown> = {},
): Promise<string> {
    return (await createAgent(request, token, extra)).id as string;
}

/** POST an attachment edge; return status + parsed body. */
async function attach(
    request: APIRequestContext,
    token: string,
    agentId: string,
    uploadId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
    const res = await request.post(`${API_BASE}/api/agents/${agentId}/attachments`, {
        headers: authedHeaders(token),
        data: { uploadId },
    });
    return { status: res.status(), body: await res.json().catch(() => ({})) };
}

async function listAttachments(
    request: APIRequestContext,
    token: string,
    agentId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
    const res = await request.get(`${API_BASE}/api/agents/${agentId}/attachments`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `list body=${await res.text()}`).toBe(200);
    return res.json();
}

test.describe('FLOW: uploads→agent attachments — first-class user_uploads shape (multi-step)', () => {
    test('attach own upload → 201 BARE edge; the list enriches it with user_uploads metadata (filename/mime/size/url)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const agentId = await createAgentId(request, owner.access_token);
        const up = await mintUpload(request, owner.access_token, { originalName: 'spec-notes.md' });

        // Fresh agent → empty attachment list.
        expect(await listAttachments(request, owner.access_token, agentId)).toEqual([]);

        // Attach → 201 BARE edge: exactly id/agentId/uploadId/createdAt, no
        // upload metadata echoed on the POST response.
        const a = await attach(request, owner.access_token, agentId, up.id);
        expect(a.status, `attach body=${JSON.stringify(a.body)}`).toBe(201);
        expect(a.body.id, 'edge id is a generated uuid').toMatch(UUID_RE);
        expect(a.body.agentId).toBe(agentId);
        expect(a.body.uploadId).toBe(up.id);
        expect(String(a.body.createdAt)).toMatch(ISO_RE);
        expect(Object.keys(a.body).sort()).toEqual(['agentId', 'createdAt', 'id', 'uploadId']);

        // The LIST, by contrast, JOINs the owner's user_uploads row and adds
        // filename (the ORIGINAL name, not the hash-named storage file),
        // mimeType, sizeBytes (a number), and the owner-gated serve url.
        const list = await listAttachments(request, owner.access_token, agentId);
        expect(list).toHaveLength(1);
        const row = list[0];
        expect(row.id).toBe(a.body.id);
        expect(row.uploadId).toBe(up.id);
        expect(row.filename, 'enriched from user_uploads.originalFilename').toBe('spec-notes.md');
        expect(row.mimeType).toBe('text/markdown');
        expect(typeof row.sizeBytes, 'sizeBytes is a number, not a bigint string').toBe('number');
        expect(row.sizeBytes).toBe(up.size);
        expect(row.url).toBe(`/api/uploads/${owner.user.id}/${up.id}.md`);
        expect(Object.keys(row).sort()).toEqual([
            'agentId',
            'createdAt',
            'filename',
            'id',
            'mimeType',
            'sizeBytes',
            'uploadId',
            'url',
        ]);
    });

    test('multi-step: the enriched-list url round-trips to the owner-gated serve → 200 with identical bytes + hardening headers', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const agentId = await createAgentId(request, owner.access_token);
        const bytes = `# served through the attachment edge ${nextSuffix()}`;
        const up = await mintUpload(request, owner.access_token, { body: bytes });

        expect((await attach(request, owner.access_token, agentId, up.id)).status).toBe(201);
        const row = (await listAttachments(request, owner.access_token, agentId))[0];

        // Follow the url the ATTACHMENT surface handed back (not the raw upload
        // response) — this proves the round-trip the web tiles rely on.
        const served = await request.get(`${API_BASE}${row.url}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(served.status(), 'owner reads own attached file → 200').toBe(200);
        const h = served.headers();
        expect(h['x-content-type-options']).toBe('nosniff');
        expect(h['content-security-policy']).toContain("default-src 'none'");
        expect(Buffer.compare(await served.body(), Buffer.from(bytes)), 'bytes identical').toBe(0);
    });

    test('re-attaching the SAME uploadId is idempotent → 201 same edge id; list stays length 1', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const agentId = await createAgentId(request, owner.access_token);
        const up = await mintUpload(request, owner.access_token);

        const first = await attach(request, owner.access_token, agentId, up.id);
        expect(first.status).toBe(201);
        const second = await attach(request, owner.access_token, agentId, up.id);
        expect(second.status, `re-attach body=${JSON.stringify(second.body)}`).toBe(201);
        // The unique (agentId, uploadId) index swallows the duplicate and
        // re-reads the existing edge — same id, no second row.
        expect(second.body.id).toBe(first.body.id);
        expect(await listAttachments(request, owner.access_token, agentId)).toHaveLength(1);
    });

    test('the SAME upload attaches to TWO of the owner’s agents as independent edges, both enriched identically', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const a1 = await createAgentId(request, owner.access_token);
        const a2 = await createAgentId(request, owner.access_token);
        const up = await mintUpload(request, owner.access_token, { originalName: 'shared-ref.md' });

        const r1 = await attach(request, owner.access_token, a1, up.id);
        const r2 = await attach(request, owner.access_token, a2, up.id);
        expect(r1.status).toBe(201);
        expect(r2.status).toBe(201);
        // Distinct edge rows (per-agent), but they reference the one upload…
        expect(r1.body.id).not.toBe(r2.body.id);

        const [l1, l2] = [
            (await listAttachments(request, owner.access_token, a1))[0],
            (await listAttachments(request, owner.access_token, a2))[0],
        ];
        // …so the enriched metadata (from the single user_uploads row) matches.
        expect(l1.uploadId).toBe(up.id);
        expect(l2.uploadId).toBe(up.id);
        expect(l1.filename).toBe('shared-ref.md');
        expect(l2.filename).toBe('shared-ref.md');
        expect(l1.url).toBe(l2.url);
    });

    test('two DISTINCT uploads attach as two enriched rows, each carrying its own filename/size', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const agentId = await createAgentId(request, owner.access_token);
        const upA = await mintUpload(request, owner.access_token, {
            originalName: 'alpha.md',
            body: `alpha ${nextSuffix()}`,
        });
        const upB = await mintUpload(request, owner.access_token, {
            originalName: 'beta.md',
            body: `beta body is longer ${nextSuffix()}`,
        });
        expect(upA.id).not.toBe(upB.id);

        expect((await attach(request, owner.access_token, agentId, upA.id)).status).toBe(201);
        expect((await attach(request, owner.access_token, agentId, upB.id)).status).toBe(201);

        const list = await listAttachments(request, owner.access_token, agentId);
        expect(list).toHaveLength(2);
        const byUpload = new Map(list.map((r) => [r.uploadId as string, r]));
        expect(byUpload.get(upA.id)?.filename).toBe('alpha.md');
        expect(byUpload.get(upB.id)?.filename).toBe('beta.md');
        expect(byUpload.get(upA.id)?.sizeBytes).toBe(upA.size);
        expect(byUpload.get(upB.id)?.sizeBytes).toBe(upB.size);
    });
});

test.describe('FLOW: uploads→agent attachments — ownership isolation (user_uploads keyed by owner)', () => {
    test('a foreign upload (Alice’s sha on Bob’s OWN agent) → 404 "Upload … not found."; no dangling edge is persisted', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const aliceUpload = await mintUpload(request, alice.access_token);
        const bobAgent = await createAgentId(request, bob.access_token);

        const res = await attach(request, bob.access_token, bobAgent, aliceUpload.id);
        expect(res.status, `foreign upload body=${JSON.stringify(res.body)}`).toBe(404);
        // user_uploads is keyed by (userId, sha256) — Bob doesn't own the sha.
        expect(String(res.body.message)).toContain('Upload');
        expect(String(res.body.message)).toContain('not found');
        // Nothing was attached — the ownership check gates BEFORE the edge insert.
        expect(await listAttachments(request, bob.access_token, bobAgent)).toEqual([]);
    });

    test('a ghost sha256 (never uploaded) on the owner’s own agent → 404 "Upload … not found."', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const agentId = await createAgentId(request, owner.access_token);
        const ghost = 'f'.repeat(64);

        const res = await attach(request, owner.access_token, agentId, ghost);
        expect(res.status).toBe(404);
        expect(String(res.body.message)).toContain('Upload');
        expect(await listAttachments(request, owner.access_token, agentId)).toEqual([]);
    });

    test('cross-user opacity: B cannot attach / list / delete on A’s agent → 404 "Agent … not found."; A’s edge is untouched', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const agentId = await createAgentId(request, alice.access_token);
        const aliceUpload = await mintUpload(request, alice.access_token);
        const edge = await attach(request, alice.access_token, agentId, aliceUpload.id);
        expect(edge.status).toBe(201);

        // Bob's own upload, but A's agent — the AGENT ownership check fires
        // first, so it 404s "Agent … not found." before uploadId is considered.
        const bobUpload = await mintUpload(request, bob.access_token);
        const bAttach = await attach(request, bob.access_token, agentId, bobUpload.id);
        expect(bAttach.status).toBe(404);
        expect(bAttach.body.message).toBe(`Agent ${agentId} not found.`);

        const bList = await request.get(`${API_BASE}/api/agents/${agentId}/attachments`, {
            headers: authedHeaders(bob.access_token),
        });
        expect(bList.status()).toBe(404);
        expect((await bList.json()).message).toBe(`Agent ${agentId} not found.`);

        const bDelete = await request.delete(
            `${API_BASE}/api/agents/${agentId}/attachments/${edge.body.id}`,
            { headers: authedHeaders(bob.access_token) },
        );
        expect(bDelete.status()).toBe(404);
        expect((await bDelete.json()).message).toBe(`Agent ${agentId} not found.`);

        // A's real edge survives every cross-user probe.
        const stillThere = await listAttachments(request, alice.access_token, agentId);
        expect(stillThere).toHaveLength(1);
        expect(stillThere[0].id).toBe(edge.body.id);
    });

    test('anonymous list / attach / delete on the agent attachment surface → 401 Unauthorized', async ({
        request,
    }) => {
        // No Authorization header; the fixture carries no storageState.
        const list = await request.get(`${API_BASE}/api/agents/${UNKNOWN_UUID}/attachments`);
        expect(list.status()).toBe(401);
        expect(await list.json()).toMatchObject({ message: 'Unauthorized', statusCode: 401 });

        const post = await request.post(`${API_BASE}/api/agents/${UNKNOWN_UUID}/attachments`, {
            data: { uploadId: 'a'.repeat(64) },
        });
        expect(post.status()).toBe(401);

        const del = await request.delete(
            `${API_BASE}/api/agents/${UNKNOWN_UUID}/attachments/${UNKNOWN_UUID}`,
        );
        expect(del.status()).toBe(401);
    });
});

test.describe('FLOW: uploads→agent attachments — validation + delete lifecycle', () => {
    test('uploadId must be sha256-hex: a uuid-shaped value → 400 with the regex message', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const agentId = await createAgentId(request, owner.access_token);

        const res = await attach(request, owner.access_token, agentId, UNKNOWN_UUID);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Bad Request');
        expect((res.body.message as string[]).some((m) => m.includes('must match'))).toBe(true);
    });

    test('missing uploadId field → 400 with both the regex and the string-type messages', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const agentId = await createAgentId(request, owner.access_token);

        const res = await request.post(`${API_BASE}/api/agents/${agentId}/attachments`, {
            headers: authedHeaders(owner.access_token),
            data: {},
        });
        expect(res.status()).toBe(400);
        const messages: string[] = (await res.json()).message;
        expect(messages).toContain('uploadId must be a string');
        expect(messages.some((m) => m.includes('must match'))).toBe(true);
    });

    test('malformed agentId → 400 ParseUUIDPipe; unknown (valid-uuid) agentId → 404 "Agent … not found."', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const sha = 'a'.repeat(64);

        const malformed = await request.post(`${API_BASE}/api/agents/not-a-uuid/attachments`, {
            headers: authedHeaders(owner.access_token),
            data: { uploadId: sha },
        });
        expect(malformed.status()).toBe(400);
        expect((await malformed.json()).message).toBe('Validation failed (uuid is expected)');

        const unknown = await attach(request, owner.access_token, UNKNOWN_UUID, sha);
        expect(unknown.status).toBe(404);
        expect(unknown.body.message).toBe(`Agent ${UNKNOWN_UUID} not found.`);
    });

    test('detach → 200 { deleted:true }, the list empties, and a second detach → 404 "Attachment not found"', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const agentId = await createAgentId(request, owner.access_token);
        const up = await mintUpload(request, owner.access_token);
        const edge = await attach(request, owner.access_token, agentId, up.id);
        expect(edge.status).toBe(201);

        const del = await request.delete(
            `${API_BASE}/api/agents/${agentId}/attachments/${edge.body.id}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(del.status(), `delete body=${await del.text()}`).toBe(200);
        expect(await del.json()).toEqual({ deleted: true });
        expect(await listAttachments(request, owner.access_token, agentId)).toEqual([]);

        // Detach is NOT idempotent — the edge is gone.
        const again = await request.delete(
            `${API_BASE}/api/agents/${agentId}/attachments/${edge.body.id}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(again.status()).toBe(404);
        expect((await again.json()).message).toBe('Attachment not found');
    });

    test('detach of an unknown (valid-uuid) attachmentId on an owned agent → 404 "Attachment not found"', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const agentId = await createAgentId(request, owner.access_token);

        const res = await request.delete(
            `${API_BASE}/api/agents/${agentId}/attachments/${UNKNOWN_UUID}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(res.status()).toBe(404);
        expect((await res.json()).message).toBe('Attachment not found');
    });
});

test.describe('FLOW: uploads→agent avatar — avatarImageUploadId create matrix', () => {
    test('avatarMode=image requires avatarImageUploadId: omitting it → 400 with the exact guard message', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/agents`, {
            headers: authedHeaders(owner.access_token),
            data: { scope: 'tenant', name: `AvatarNoImg ${nextSuffix()}`, avatarMode: 'image' },
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).message).toBe(
            'avatarImageUploadId required when avatarMode=image',
        );
    });

    test('avatarMode=image + a UUID avatarImageUploadId → 201 and the value is persisted', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const agent = await createAgent(request, owner.access_token, {
            avatarMode: 'image',
            avatarImageUploadId: SAMPLE_UUID,
        });
        expect(agent.avatarMode).toBe('image');
        expect(agent.avatarImageUploadId).toBe(SAMPLE_UUID);
    });

    test('avatarMode=initials IGNORES a supplied avatarImageUploadId (persists null)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const agent = await createAgent(request, owner.access_token, {
            avatarMode: 'initials',
            avatarImageUploadId: SAMPLE_UUID,
        });
        expect(agent.avatarMode).toBe('initials');
        // The service only persists avatarImageUploadId when mode=image.
        expect(agent.avatarImageUploadId).toBeNull();
    });

    test('avatarImageUploadId is @IsUUID-validated: a non-uuid → 400 "avatarImageUploadId must be a UUID"', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/agents`, {
            headers: authedHeaders(owner.access_token),
            data: {
                scope: 'tenant',
                name: `AvatarBad ${nextSuffix()}`,
                avatarMode: 'image',
                avatarImageUploadId: 'not-a-uuid',
            },
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).message).toContain('avatarImageUploadId must be a UUID');
    });
});

test.describe('FLOW: uploads→task attachments — the DISTINCT work_knowledge_uploads sub-resource', () => {
    /** Create a plain (non-Work-scoped) Task and return its id. */
    async function createTask(token: string, r: APIRequestContext): Promise<string> {
        const res = await r.post(`${API_BASE}/api/tasks`, {
            headers: authedHeaders(token),
            data: { title: `Task ${nextSuffix()}` },
        });
        expect(res.status(), `create task body=${await res.text()}`).toBe(201);
        return (await res.json()).id as string;
    }

    test('a sha256 uploadId is REJECTED here (unlike agent/mission edges): 400 "uploadId must be a UUID"', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const taskId = await createTask(owner.access_token, request);
        // The Task edge FKs into work_knowledge_uploads (uuid PK), so the DTO is
        // @IsUUID — the opposite of the sha256 agent/mission DTOs.
        const up = await mintUpload(request, owner.access_token);
        const res = await request.post(`${API_BASE}/api/tasks/${taskId}/attachments`, {
            headers: authedHeaders(owner.access_token),
            data: { uploadId: up.id },
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).message).toContain('uploadId must be a UUID');
    });

    test('a UUID uploadId on a non-Work-scoped task → 400 (Work scope is required to verify upload ownership)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const taskId = await createTask(owner.access_token, request);
        const res = await request.post(`${API_BASE}/api/tasks/${taskId}/attachments`, {
            headers: authedHeaders(owner.access_token),
            data: { uploadId: SAMPLE_UUID },
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).message).toBe(
            'Task attachments require a Work-scoped task so upload ownership can be verified.',
        );
    });

    test('a fresh task has an empty attachment list → 200 []', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const taskId = await createTask(owner.access_token, request);
        const res = await request.get(`${API_BASE}/api/tasks/${taskId}/attachments`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual([]);
    });

    test('cross-user opacity + anon: B → A’s task attachments → 404 "Task … not found."; anon → 401', async ({
        request,
    }) => {
        const alice = await registerUserViaAPI(request);
        const bob = await registerUserViaAPI(request);
        const taskId = await createTask(alice.access_token, request);

        const bAttach = await request.post(`${API_BASE}/api/tasks/${taskId}/attachments`, {
            headers: authedHeaders(bob.access_token),
            data: { uploadId: SAMPLE_UUID },
        });
        expect(bAttach.status()).toBe(404);
        expect((await bAttach.json()).message).toBe(`Task ${taskId} not found.`);

        const bList = await request.get(`${API_BASE}/api/tasks/${taskId}/attachments`, {
            headers: authedHeaders(bob.access_token),
        });
        expect(bList.status()).toBe(404);
        expect((await bList.json()).message).toBe(`Task ${taskId} not found.`);

        const anon = await request.get(`${API_BASE}/api/tasks/${taskId}/attachments`);
        expect(anon.status()).toBe(401);
    });
});
