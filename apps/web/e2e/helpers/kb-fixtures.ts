import type { APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders } from './api';

/**
 * KB-specific fixture helpers for e2e tests.
 *
 * Keep these tiny: they exist so KB acceptance specs (A12-A17) can stand up
 * the same backend state via the public API instead of driving the UI.
 * UI-based setup is the right shape for the A12 upload spec itself, but
 * downstream specs (A13 autosave, A14 viewers, A15 activity log, …) want a
 * pre-seeded doc so they can focus on the behaviour under test.
 */

export interface SeedKbMarkdownDocOptions {
    /** Filename used in the multipart upload; controls the resulting doc slug. */
    filename: string;
    /** Markdown body. */
    body: string;
    /** Optional class override; defaults to `freeform` (a valid KbDocumentClass enum value). */
    targetClass?: string;
    /** Optional title — falls back to filename-minus-extension server-side. */
    title?: string;
}

export interface SeededKbDoc {
    documentId: string;
    path: string;
}

/**
 * POST multipart to `/api/works/:id/kb/uploads`, returning the new document's
 * id + path. Throws if the API rejects the call (caller catches with
 * `await expect(...).rejects.toThrow()` if testing the error case).
 *
 * The upload endpoint synchronously creates a KbDocument for text MIMEs
 * (markdown / plain), so a `text/markdown` upload returns
 * `{ upload, document: { id, path, ... } }` in one round-trip — no polling
 * needed (Phase 1B/b spec §7.4).
 */
export async function seedKbMarkdownDoc(
    request: APIRequestContext,
    token: string,
    workId: string,
    opts: SeedKbMarkdownDocOptions,
): Promise<SeededKbDoc> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/kb/uploads`, {
        headers: authedHeaders(token),
        multipart: {
            file: {
                name: opts.filename,
                mimeType: 'text/markdown',
                buffer: Buffer.from(opts.body, 'utf8'),
            },
            targetClass: opts.targetClass ?? 'freeform',
            ...(opts.title ? { title: opts.title } : {}),
        },
    });
    if (!res.ok()) {
        const errBody = await res.text();
        throw new Error(`seedKbMarkdownDoc failed (${res.status()}): ${errBody}`);
    }
    const json = (await res.json()) as {
        document?: { id?: string; path?: string } | null;
    };
    const documentId = json.document?.id;
    const path = json.document?.path;
    if (!documentId || !path) {
        throw new Error(
            `seedKbMarkdownDoc: upload accepted but response shape missing document.id/path: ${JSON.stringify(json)}`,
        );
    }
    return { documentId, path };
}

export interface SeedKbBinaryDocOptions {
    /** Filename used in the multipart upload; controls the resulting doc slug. */
    filename: string;
    /** Storage MIME type — drives both the upload row's `mimeType` and the viewer dispatcher (row 21b). */
    mimeType: string;
    /** Raw bytes. For viewer-cap tests, `Buffer.alloc(6 * 1024 * 1024, 0)` is plenty for a 6 MiB stub. */
    body: Buffer;
    /** Optional class override; defaults to `freeform` (a valid KbDocumentClass enum value). */
    targetClass?: string;
    /** Optional title — falls back to filename-minus-extension server-side. */
    title?: string;
}

export interface SeededKbBinaryDoc extends SeededKbDoc {
    uploadId: string;
}

/**
 * POST multipart with an arbitrary MIME + buffer, returning the upload id
 * AND the resulting doc id/path. Mirrors `seedKbMarkdownDoc` but accepts
 * binary uploads — for non-text MIMEs the API stores the bytes with
 * `extractionStatus='skipped'`, creates a stub `WorkKnowledgeDocument`
 * row whose `sourceUploadId` points at the upload, and the row-21b viewer
 * dispatcher (`pickKbViewer`) mounts the matching `Kb{Pdf,Xlsx,Docx,Image,
 * Video,Audio}Viewer`.
 *
 * Watch-out: the upload endpoint's per-file cap is `KB_UPLOAD_MAX_BYTES`
 * (default 200 MiB). The 5 MiB-XLSX / 30 MiB-PDF / 10 MiB-image / etc.
 * thresholds tested by A14 are enforced VIEWER-SIDE (each viewer's
 * `KB_*_INLINE_MAX_BYTES`), so a 6 MiB upload here is accepted and the
 * viewer renders the download fallback purely from the doc's
 * `fileSize`-driven decision.
 */
export async function seedKbBinaryDoc(
    request: APIRequestContext,
    token: string,
    workId: string,
    opts: SeedKbBinaryDocOptions,
): Promise<SeededKbBinaryDoc> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/kb/uploads`, {
        headers: authedHeaders(token),
        multipart: {
            file: {
                name: opts.filename,
                mimeType: opts.mimeType,
                buffer: opts.body,
            },
            targetClass: opts.targetClass ?? 'freeform',
            ...(opts.title ? { title: opts.title } : {}),
        },
    });
    if (!res.ok()) {
        const errBody = await res.text();
        throw new Error(`seedKbBinaryDoc failed (${res.status()}): ${errBody}`);
    }
    const json = (await res.json()) as {
        upload?: { id?: string } | null;
        document?: { id?: string; path?: string } | null;
    };
    const uploadId = json.upload?.id;
    const documentId = json.document?.id;
    const path = json.document?.path;
    if (!uploadId || !documentId || !path) {
        throw new Error(
            `seedKbBinaryDoc: upload accepted but response shape missing ids: ${JSON.stringify(json)}`,
        );
    }
    return { uploadId, documentId, path };
}

export interface SeedKbSkippedUploadOptions {
    /** Filename used in the multipart upload. */
    filename: string;
    /** Raw bytes. Tests can use `Buffer.from('opaque', 'utf8')` — content doesn't matter when extraction is skipped. */
    body: Buffer;
    /**
     * Optional MIME override — defaults to `application/octet-stream` which
     * has no extractor route, so the upload lands as `extractionStatus='skipped'`
     * with `document: null`. Pass another off-list MIME (e.g.
     * `application/x-zip-compressed`) to exercise the same branch with a
     * different content-type.
     */
    mimeType?: string;
    /** Optional class override; defaults to `freeform` (a valid KbDocumentClass enum value). */
    targetClass?: string;
}

export interface SeededKbSkippedUpload {
    uploadId: string;
    /** Raw `extractionStatus` field as it appeared in the upload row on response. */
    extractionStatus: string;
}

/**
 * POST multipart with a MIME that has no extractor route, returning ONLY
 * the upload id + its extractionStatus. Companion to `seedKbBinaryDoc` for
 * the row 23 (A16) retry-extraction acceptance test: when the MIME is
 * unrecognized, `KnowledgeBaseService.createUpload` short-circuits the
 * extract+materialize path, persists the bytes, records
 * `kb_upload_extraction_skipped`, and returns `{ upload, document: null }`.
 * Throwing on the missing `document` field — like `seedKbBinaryDoc` does
 * — would be wrong for this branch.
 */
export async function seedKbSkippedUpload(
    request: APIRequestContext,
    token: string,
    workId: string,
    opts: SeedKbSkippedUploadOptions,
): Promise<SeededKbSkippedUpload> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/kb/uploads`, {
        headers: authedHeaders(token),
        multipart: {
            file: {
                name: opts.filename,
                mimeType: opts.mimeType ?? 'application/octet-stream',
                buffer: opts.body,
            },
            targetClass: opts.targetClass ?? 'freeform',
        },
    });
    if (!res.ok()) {
        const errBody = await res.text();
        throw new Error(`seedKbSkippedUpload failed (${res.status()}): ${errBody}`);
    }
    const json = (await res.json()) as {
        upload?: { id?: string; extractionStatus?: string } | null;
        document?: { id?: string } | null;
    };
    const uploadId = json.upload?.id;
    const extractionStatus = json.upload?.extractionStatus;
    if (!uploadId || typeof extractionStatus !== 'string') {
        throw new Error(
            `seedKbSkippedUpload: upload accepted but response shape missing fields: ${JSON.stringify(json)}`,
        );
    }
    return { uploadId, extractionStatus };
}

export interface SeedOrgKbDocOptions {
    /** Organization UUID. The org-KB controller (`/api/organizations/:orgId/kb/documents`) doesn't enforce membership today — any authenticated user can post for any orgId. */
    orgId: string;
    /** `class/slug.md` style relative path under `.content/kb/<class>/`. Phase 2/e A19 uses `legal/<slug>.md`. */
    path: string;
    /** Optional title — falls back to the slug. */
    title?: string;
    /** KbDocumentClass enum value. Spec D2 restricts org-scope docs to inheritable classes (`legal`, `style`, `seo`). */
    targetClass?: 'legal' | 'style' | 'seo';
    /** Markdown body. */
    body: string;
}

/**
 * POST a single organization-scope KB document via the public REST endpoint
 * (`POST /api/organizations/:orgId/kb/documents`). Used by the A19 + A20
 * Playwright specs to seed an inheritable document that a paired Work
 * (Work.organizationId === orgId) should surface under its "Inherited from
 * organization" tree section.
 *
 * Service-layer guard restricts org-scope documents to the inheritable
 * class set (`legal | style | seo`) per spec D2 — passing another class
 * causes the controller to 400.
 */
export async function seedOrgKbDoc(
    request: APIRequestContext,
    token: string,
    opts: SeedOrgKbDocOptions,
): Promise<{ documentId: string; path: string }> {
    const targetClass = opts.targetClass ?? 'legal';
    const res = await request.post(`${API_BASE}/api/organizations/${opts.orgId}/kb/documents`, {
        headers: authedHeaders(token),
        data: {
            path: opts.path,
            title: opts.title ?? opts.path.split('/').pop()?.replace(/\.md$/, '') ?? opts.path,
            class: targetClass,
            body: opts.body,
        },
    });
    if (!res.ok()) {
        const errBody = await res.text();
        throw new Error(`seedOrgKbDoc failed (${res.status()}): ${errBody}`);
    }
    const json = (await res.json()) as { id?: string; path?: string };
    if (!json.id || !json.path) {
        throw new Error(
            `seedOrgKbDoc: created but response shape missing id/path: ${JSON.stringify(json)}`,
        );
    }
    return { documentId: json.id, path: json.path };
}

/**
 * PATCH `Work.organizationId` via the public `/api/works/:id` update
 * endpoint. Pairs the Work with an organization-scope KB document set so
 * that org docs (seeded via `seedOrgKbDoc`) surface under the Work's KB
 * tree as "inherited" rows (Phase 2/e A19+A20).
 *
 * The endpoint requires editor role on the Work — the access token used
 * must belong to the Work's owner or an editor member.
 */
export async function setWorkOrganizationId(
    request: APIRequestContext,
    token: string,
    workId: string,
    orgId: string | null,
): Promise<void> {
    const res = await request.patch(`${API_BASE}/api/works/${workId}`, {
        headers: authedHeaders(token),
        data: { organizationId: orgId },
    });
    if (!res.ok()) {
        const errBody = await res.text();
        throw new Error(`setWorkOrganizationId failed (${res.status()}): ${errBody}`);
    }
}
