/**
 * EW-641 slice C — Client-side helper for the KB upload endpoint
 * (`POST /api/works/:id/kb/uploads`).
 *
 * Mirrors the broader-dashboard `apps/web/src/lib/api/uploads.ts` helper
 * but targets the per-Work KB upload route and supports the
 * `CreateKbUploadDto` extra fields (`targetClass`, `title`, `description`,
 * `tags[]`, `autoClassify` — see `packages/agent/src/dto/kb.dto.ts`).
 *
 * Uses `XMLHttpRequest` rather than `fetch` so we can wire
 * `xhr.upload.onprogress` and surface per-byte progress to the workbench
 * progress toast stack. The native Fetch streams API does not expose
 * reliable upload progress in all browsers as of 2026.
 */
import type { KbDocumentClass, KbDocumentDto, KbUploadDto } from '@ever-works/contracts';

export interface KbUploadResponse {
    readonly upload: KbUploadDto;
    readonly document: KbDocumentDto | null;
}

export interface UploadKbFileOptions {
    /** Target Work whose KB receives the upload. */
    readonly workId: string;
    /** The user-picked file. */
    readonly file: File;
    /** Required target class — the modal forces this to be set before "Upload" is enabled. */
    readonly class: KbDocumentClass;
    /** Optional tags — repeated multipart `tags[]` parts. */
    readonly tags?: readonly string[];
    /** Optional plaintext description. */
    readonly description?: string;
    /**
     * Optional "auto-classify" hint. When `true` the server derives the
     * class from the EXTRACTED TEXT (one small structured AI call over a
     * closed enum) and `class` above becomes the fallback used when the
     * classifier is unavailable or returns something unrecognised.
     *
     * Wire shape: `autoClassify=true` as a multipart string, because
     * multipart carries no booleans. `CreateKbUploadDto` declares a
     * matching `@Transform` — until it did, sending this field 400'd the
     * whole upload under `forbidNonWhitelisted`.
     */
    readonly autoClassify?: boolean;
    /**
     * Called with `(bytesUploaded, bytesTotal)` whenever the browser flushes
     * another chunk to the wire. `bytesTotal` is `file.size` when the
     * progress event is `lengthComputable`; otherwise the callback fires
     * with `(0, 0)` and the caller should fall back to an indeterminate
     * progress bar.
     */
    onProgress?: (bytesUploaded: number, bytesTotal: number) => void;
    /** Optional abort signal — cancels the upload mid-flight. */
    readonly signal?: AbortSignal;
}

export class KbUploadError extends Error {
    readonly status: number;
    readonly body: unknown;
    constructor(message: string, status: number, body?: unknown) {
        super(message);
        this.name = 'KbUploadError';
        this.status = status;
        this.body = body;
    }
}

/**
 * Upload a single file to a Work's KB. Resolves with the parsed
 * `{ upload, document }` envelope on 2xx; rejects with `KbUploadError`
 * on non-2xx (parsing the upstream JSON body for a `message` field where
 * available, so the UI can render the right 400 / 413 / 503 copy).
 */
export function uploadKbFile(opts: UploadKbFileOptions): Promise<KbUploadResponse> {
    const { workId, file, tags, description, autoClassify, onProgress, signal } = opts;
    const targetClass: KbDocumentClass = opts.class;

    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new KbUploadError('Upload aborted', 0));
            return;
        }

        const form = new FormData();
        form.append('file', file, file.name);
        form.append('targetClass', targetClass);
        if (description && description.trim().length > 0) {
            form.append('description', description);
        }
        if (autoClassify === true) {
            form.append('autoClassify', 'true');
        }
        if (tags && tags.length > 0) {
            for (const tag of tags) {
                const trimmed = tag.trim();
                if (trimmed.length > 0) {
                    // NestJS class-validator accepts repeated form fields
                    // as a string array when the DTO declares `tags: string[]`.
                    form.append('tags[]', trimmed);
                }
            }
        }

        const url = `/api/works/${encodeURIComponent(workId)}/kb/uploads`;
        // eslint-disable-next-line no-restricted-syntax -- EW-790: verified Work-scoped (workId + userId), never reads the Organization
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        // Mirror `uploads.ts`: never send cookies on the bytes path — the
        // Next.js proxy attaches the auth header.
        xhr.withCredentials = false;

        if (onProgress && xhr.upload) {
            xhr.upload.onprogress = (ev) => {
                if (ev.lengthComputable) {
                    onProgress(ev.loaded, ev.total);
                } else {
                    onProgress(0, 0);
                }
            };
        }

        xhr.onload = () => {
            const status = xhr.status;
            const rawText = xhr.responseText || '';
            if (status < 200 || status >= 300) {
                let message = `Upload failed (${status})`;
                let parsed: unknown;
                try {
                    parsed = JSON.parse(rawText);
                    const body = parsed as { message?: string };
                    if (body && typeof body.message === 'string') message = body.message;
                } catch {
                    /* non-JSON; keep generic message */
                }
                reject(new KbUploadError(message, status, parsed));
                return;
            }
            try {
                const body = JSON.parse(rawText) as KbUploadResponse;
                if (!body || !body.upload || typeof body.upload.id !== 'string') {
                    reject(
                        new KbUploadError(
                            'Upload succeeded but response was malformed',
                            status,
                            body,
                        ),
                    );
                    return;
                }
                resolve(body);
            } catch {
                reject(new KbUploadError('Upload response was not valid JSON', status));
            }
        };
        xhr.onerror = () => reject(new KbUploadError('Network error during upload', 0));
        xhr.onabort = () => reject(new KbUploadError('Upload aborted', 0));
        xhr.ontimeout = () => reject(new KbUploadError('Upload timed out', 0));

        if (signal) {
            const onAbort = () => {
                try {
                    xhr.abort();
                } catch {
                    /* noop */
                }
            };
            signal.addEventListener('abort', onAbort, { once: true });
        }

        xhr.send(form);
    });
}

/**
 * List a Work's KB uploads — the "Originals" tab's data source.
 *
 * Goes through the Next.js proxy (`/api/works/:id/kb/uploads`) rather than
 * the API directly so the session cookie is exchanged for a bearer token
 * server-side; the browser never holds the API token.
 */
export async function listKbUploads(
    workId: string,
    opts?: { signal?: AbortSignal },
): Promise<{ items: KbUploadDto[]; total: number }> {
    // eslint-disable-next-line no-restricted-syntax -- EW-790: verified Work-scoped (workId + userId), never reads the Organization
    const res = await fetch(`/api/works/${workId}/kb/uploads`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: opts?.signal,
    });
    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new KbUploadError(
            (body as { message?: string } | null)?.message ??
                `Failed to list uploads (${res.status})`,
            res.status,
            body,
        );
    }
    const body = (await res.json().catch(() => null)) as {
        items?: KbUploadDto[];
        total?: number;
    } | null;
    return { items: body?.items ?? [], total: body?.total ?? 0 };
}

/**
 * Re-run extraction for an upload whose first attempt FAILED. The bytes are
 * already stored, so this takes no body — see the proxy route for why.
 */
export async function retryKbUploadExtraction(
    workId: string,
    uploadId: string,
): Promise<KbUploadResponse> {
    // eslint-disable-next-line no-restricted-syntax -- EW-790: verified Work-scoped (workId + userId), never reads the Organization
    const res = await fetch(`/api/works/${workId}/kb/uploads/${uploadId}/retry-extraction`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
        throw new KbUploadError(
            (body as { message?: string } | null)?.message ?? `Retry failed (${res.status})`,
            res.status,
            body,
        );
    }
    return body as KbUploadResponse;
}
