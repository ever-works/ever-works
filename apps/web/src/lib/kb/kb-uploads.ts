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
     * Optional "auto-classify" hint. When `true` the server is allowed to
     * re-classify the document via its routing/classification plugin chain
     * instead of locking it to `targetClass`.
     *
     * Wire shape: `autoClassify=true|false` as a multipart string. The
     * Create DTO accepts it as a boolean — class-validator's
     * `@Type(() => Boolean)` parses the string back.
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
