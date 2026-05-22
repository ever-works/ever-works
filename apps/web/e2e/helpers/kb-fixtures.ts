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
    /** Optional class override; defaults to `knowledge` so the doc lands in a predictable folder. */
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
            targetClass: opts.targetClass ?? 'knowledge',
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
