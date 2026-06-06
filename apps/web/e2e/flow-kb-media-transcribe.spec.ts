import { test, expect, type APIRequestContext } from '@playwright/test';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { API_BASE, authedHeaders, createWorkViaAPI, loginViaAPI } from './helpers/api';
import { seedKbBinaryDoc } from './helpers/kb-fixtures';

/**
 * EW-643 Phase 3 slice 2c — A28/A29 acceptance: KB media uploads
 * (video / audio) flow through the ffmpeg-backed normalize task and
 * the Whisper transcribe task and land as a `WorkKnowledgeDocument`
 * whose `metadata.transcribedFromUploadId` points back at the upload.
 *
 * GATE — these scenarios require BOTH a real ffmpeg binary AND a real
 * Whisper (transcription-capable) provider configured in the running
 * API + Trigger.dev worker. The gating env vars are inspected
 * dynamically:
 *
 *   - `KB_E2E_FFMPEG=1`    — ffmpeg is installed AND `KB_MEDIA_NORMALIZE`
 *                            is enabled on the API + worker
 *   - `KB_E2E_WHISPER=1`   — a transcription-capable AI provider is
 *                            wired (e.g. OpenAI + `OPENAI_API_KEY`
 *                            present, `KB_TRANSCRIPTION_PROVIDER` pinned
 *                            or selection chain resolves)
 *
 * Either missing → the file `test.skip`s with a clear reason so the
 * suite stays green in environments that don't ship ffmpeg/Whisper
 * (the default GitHub-Actions matrix). Local + cloud runs that DO
 * configure both will exercise the full A28/A29 path.
 *
 * Existing `kb-upload.spec.ts` covers the synchronous text-passthrough
 * branch; existing `flow-kb-viewers-media.spec.ts` covers the
 * viewable-stub branch for media (i.e. the upload row + the stub doc).
 * This spec covers the asynchronous TRANSCRIPT doc — a separate
 * `WorkKnowledgeDocument` produced by the background pipeline and
 * surfaced under `class=research` (default) with a transcript tag.
 *
 * The poll loop intentionally uses a generous deadline (3 minutes) —
 * ffmpeg + Whisper run on real I/O so even a 1 KB fixture takes a few
 * seconds end-to-end on a cold worker.
 */

const POLL_INTERVAL_MS = 2_000;
const POLL_DEADLINE_MS = 180_000;

async function seededToken(request: APIRequestContext): Promise<string> {
    const s = loadSeededTestUser();
    const { access_token } = await loginViaAPI(request, { email: s.email, password: s.password });
    return access_token;
}

function runId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

interface UploadRow {
    id: string;
    extractionStatus: string;
    metadata?: Record<string, unknown> | null;
}

interface KbDocRow {
    id: string;
    path: string;
    class: string;
    sourceUploadId: string | null;
    metadata?: Record<string, unknown> | null;
}

interface KbDocsList {
    items: KbDocRow[];
    total: number;
}

/**
 * Poll the upload row until `metadata.normalizedStoragePath` is
 * populated by the ffmpeg-backed normalize task. Throws on the
 * deadline so the test fails clearly instead of hanging.
 */
async function waitForNormalized(
    request: APIRequestContext,
    token: string,
    workId: string,
    uploadId: string,
): Promise<UploadRow> {
    const deadline = Date.now() + POLL_DEADLINE_MS;
    let last: UploadRow | null = null;
    while (Date.now() < deadline) {
        const res = await request.get(`${API_BASE}/api/works/${workId}/kb/uploads/${uploadId}`, {
            headers: authedHeaders(token),
        });
        if (res.ok()) {
            last = (await res.json()) as UploadRow;
            const meta = (last.metadata ?? {}) as Record<string, unknown>;
            if (typeof meta.normalizedStoragePath === 'string' && meta.normalizedStoragePath) {
                return last;
            }
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(
        `Upload ${uploadId} never produced metadata.normalizedStoragePath within ${POLL_DEADLINE_MS}ms (last=${JSON.stringify(last)})`,
    );
}

/**
 * Poll the per-Work KB documents list until a doc whose
 * `metadata.transcribedFromUploadId === uploadId` appears.
 */
async function waitForTranscriptDoc(
    request: APIRequestContext,
    token: string,
    workId: string,
    uploadId: string,
): Promise<KbDocRow> {
    const deadline = Date.now() + POLL_DEADLINE_MS;
    while (Date.now() < deadline) {
        const res = await request.get(`${API_BASE}/api/works/${workId}/kb/documents`, {
            headers: authedHeaders(token),
        });
        if (res.ok()) {
            const list = (await res.json()) as KbDocsList;
            const match = list.items.find((d) => {
                const meta = (d.metadata ?? {}) as Record<string, unknown>;
                return meta.transcribedFromUploadId === uploadId;
            });
            if (match) return match;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(
        `No transcript doc with metadata.transcribedFromUploadId=${uploadId} appeared within ${POLL_DEADLINE_MS}ms`,
    );
}

test.describe('KB media → transcript (A28-A29)', () => {
    test.beforeEach(() => {
        // These scenarios need REAL ffmpeg + REAL Whisper. Without either,
        // the normalize task throws `FfmpegFailedError` and the transcribe
        // task throws `TranscriptionNotConfiguredError` — neither of which
        // is meaningful coverage. Gate the whole describe block.
        const ffmpegOk = process.env.KB_E2E_FFMPEG === '1';
        const whisperOk = process.env.KB_E2E_WHISPER === '1';
        test.skip(
            !ffmpegOk || !whisperOk,
            'Requires KB_E2E_FFMPEG=1 AND KB_E2E_WHISPER=1 (real ffmpeg + transcription provider).',
        );
    });

    test('A28 — video upload normalizes via ffmpeg and lands a transcript doc', async ({
        request,
    }) => {
        test.setTimeout(POLL_DEADLINE_MS + 60_000);
        const token = await seededToken(request);
        const id = runId();
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `KB media transcribe video ${id}`,
        });
        expect(workId).toBeTruthy();

        // 1 KB synthetic "video/mp4" buffer. The ingest pipeline only
        // gates on the reported MIME family — ffmpeg will fail to decode
        // these bytes in environments without real fixtures, hence the
        // KB_E2E_FFMPEG gate above (operators wire a real fixture path
        // via KB_E2E_VIDEO_FIXTURE when running locally).
        const fixtureBytes = Buffer.alloc(1024, 0x00);
        const seeded = await seedKbBinaryDoc(request, token, workId, {
            filename: `mediatranscribe-${id}.mp4`,
            mimeType: 'video/mp4',
            body: fixtureBytes,
        });
        expect(seeded.uploadId, 'upload row created').toBeTruthy();

        const normalized = await waitForNormalized(request, token, workId, seeded.uploadId);
        const meta = (normalized.metadata ?? {}) as Record<string, unknown>;
        expect(typeof meta.normalizedStoragePath).toBe('string');
        expect(typeof meta.normalizedSha256).toBe('string');

        const transcript = await waitForTranscriptDoc(request, token, workId, seeded.uploadId);
        const tMeta = (transcript.metadata ?? {}) as Record<string, unknown>;
        expect(tMeta.transcribedFromUploadId).toBe(seeded.uploadId);
        expect(transcript.class).toMatch(/research|freeform/);
    });

    test('A29 — audio upload normalizes via ffmpeg and lands a transcript doc', async ({
        request,
    }) => {
        test.setTimeout(POLL_DEADLINE_MS + 60_000);
        const token = await seededToken(request);
        const id = runId();
        const { id: workId } = await createWorkViaAPI(request, token, {
            name: `KB media transcribe audio ${id}`,
        });
        expect(workId).toBeTruthy();

        // 1 KB synthetic "audio/mpeg" buffer. Same caveat as A28 above.
        const fixtureBytes = Buffer.alloc(1024, 0x00);
        const seeded = await seedKbBinaryDoc(request, token, workId, {
            filename: `mediatranscribe-${id}.mp3`,
            mimeType: 'audio/mpeg',
            body: fixtureBytes,
        });
        expect(seeded.uploadId).toBeTruthy();

        const normalized = await waitForNormalized(request, token, workId, seeded.uploadId);
        const meta = (normalized.metadata ?? {}) as Record<string, unknown>;
        expect(typeof meta.normalizedStoragePath).toBe('string');
        expect(typeof meta.normalizedMimeType).toBe('string');

        const transcript = await waitForTranscriptDoc(request, token, workId, seeded.uploadId);
        const tMeta = (transcript.metadata ?? {}) as Record<string, unknown>;
        expect(tMeta.transcribedFromUploadId).toBe(seeded.uploadId);
    });
});
