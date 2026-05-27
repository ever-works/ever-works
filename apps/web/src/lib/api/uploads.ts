/**
 * Client-side helper for the dashboard's broader file-upload endpoint
 * (`POST /api/uploads/file`). Uses XHR rather than `fetch` so we can
 * surface per-byte progress to the UI — the marketing site does the
 * same in its `LandingPromptForm`, and the PromptComposer mirrors that
 * UX.
 *
 * Response shape matches the backend `UploadResult` (see
 * `apps/api/src/uploads/uploads.service.ts`):
 *
 *   {
 *     id:        string;  // sha256 of the uploaded bytes
 *     url:       string;  // API-routed serve URL (`/api/uploads/<userId>/<filename>`)
 *     filename:  string;  // canonical storage filename (`<sha256>.<ext>`)
 *     size:      number;
 *     mimeType:  string;  // declared MIME echoed back (text + Office files)
 *     hash:      string;  // same as `id`
 *     key?:      string;  // opaque backend storage key
 *   }
 */

export interface UploadResult {
    readonly id: string;
    readonly url: string;
    readonly filename: string;
    readonly size: number;
    readonly mimeType: string;
    readonly hash: string;
    readonly key?: string;
}

export interface UploadFileOptions {
    /**
     * Called repeatedly with the upload progress (0–100 integer
     * percentage). Wired to `xhr.upload.onprogress` so each callback
     * fires when the browser has flushed another chunk to the wire.
     */
    onProgress?: (percent: number) => void;
    /**
     * When provided, scopes the upload to the given Work. Only matters
     * for backends that route per Work (today: `github-storage` in
     * `data-repo` mode). Other backends ignore it. Most PromptComposer
     * callers don't need this — we're always uploading before any
     * entity exists.
     */
    workId?: string;
    /** Abort signal — cancels the upload mid-flight. */
    signal?: AbortSignal;
}

export class UploadError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.name = 'UploadError';
        this.status = status;
    }
}

/**
 * Upload a single file via `POST /api/uploads/file` (the web proxy
 * forwards to the NestJS endpoint with the auth cookie translated to a
 * Bearer token). Returns the canonical reference shape.
 *
 * Throws `UploadError` on non-2xx — the upstream body is parsed for a
 * `{ message }` field where available so the UI can show the right
 * 400 / 413 / 415 messaging from the server.
 */
export function uploadFile(file: File, opts?: UploadFileOptions): Promise<UploadResult> {
    const { onProgress, workId, signal } = opts ?? {};

    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new UploadError('Upload aborted', 0));
            return;
        }

        const form = new FormData();
        form.append('file', file, file.name);

        const url = workId
            ? `/api/uploads/file?workId=${encodeURIComponent(workId)}`
            : '/api/uploads/file';

        const xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        // Never send cookies on the upload bytes path itself — the proxy
        // route on the Next.js side reads our session cookie and forwards
        // a Bearer header. `xhr.withCredentials = false` keeps the cross-
        // origin story clean if the API is ever served from another host.
        xhr.withCredentials = false;

        if (onProgress && xhr.upload) {
            xhr.upload.onprogress = (ev) => {
                if (ev.lengthComputable) {
                    onProgress(Math.min(100, Math.round((ev.loaded / ev.total) * 100)));
                }
            };
        }

        xhr.onload = () => {
            const status = xhr.status;
            const rawText = xhr.responseText || '';
            if (status < 200 || status >= 300) {
                let message = `Upload failed (${status})`;
                try {
                    const body = JSON.parse(rawText) as { message?: string };
                    if (body && typeof body.message === 'string') message = body.message;
                } catch {
                    /* non-JSON; keep generic message */
                }
                reject(new UploadError(message, status));
                return;
            }
            try {
                const body = JSON.parse(rawText) as UploadResult;
                if (!body || typeof body.id !== 'string') {
                    reject(new UploadError('Upload succeeded but response was malformed', status));
                    return;
                }
                resolve(body);
            } catch {
                reject(new UploadError('Upload response was not valid JSON', status));
            }
        };
        xhr.onerror = () => reject(new UploadError('Network error during upload', 0));
        xhr.onabort = () => reject(new UploadError('Upload aborted', 0));
        xhr.ontimeout = () => reject(new UploadError('Upload timed out', 0));

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
