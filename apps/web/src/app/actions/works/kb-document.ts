'use server';

import { revalidatePath } from 'next/cache';
import { kbAPI } from '@/lib/api/kb';
import type { ActionResult } from '@/app/actions/plugins';
import type {
    KbDocumentBodyDto,
    KbDocumentClass,
    UpdateKbDocumentInput,
} from '@ever-works/contracts';

/**
 * EW-641 Phase 1B/d row 5 — server action that the client-side
 * `KbEditor` calls when the operator clicks "Save".
 *
 * The Next.js `KbEditor` is a client component, so it can't reach the
 * server-only `kbAPI.updateDocument` helper directly — bouncing through
 * a server action keeps the JWT cookie + API base URL handling on the
 * server side and gives the client a clean `ActionResult` envelope to
 * branch on. Spec §14 "Manual save" — autosave arrives in row 6.
 *
 * `revalidatePath` busts the cache for both the index page and the
 * nested detail route so the tree panel + viewer reflect the new
 * title / body / status without a full reload.
 */
export async function updateKbDocumentAction(args: {
    workId: string;
    docId: string;
    body: UpdateKbDocumentInput;
}): Promise<ActionResult<KbDocumentBodyDto>> {
    const { workId, docId, body } = args;
    try {
        const doc = await kbAPI.updateDocument(workId, docId, body);
        revalidatePath(`/works/${workId}/kb`);
        revalidatePath(`/works/${workId}/kb/${doc.path}`);
        return { success: true, data: doc };
    } catch (error) {
        console.error('[kb-editor] failed to update KB document:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to save document',
        };
    }
}

/**
 * EW-641 KB workbench follow-up — "+ Add document" server action.
 *
 * Powers the `KbAddDocModal` flow on the KB index + detail pages. The
 * modal collects `{ class, title, description, tags }`; we derive a
 * slug from the title, build the canonical `<class>/<slug>.md` path,
 * and POST through `kbAPI.createDocument`. The agent's `createDocument`
 * already enqueues the per-Work git mirror (row 1B/a) + the embed task
 * (row 29c), so the new row lights up everywhere without extra
 * plumbing here.
 *
 * Returns `{ id, path }` so the client can `router.push` to the brand
 * new doc's editor route (Tiptap surface) immediately on success.
 *
 * Slugging mirrors the convention used by `Spec §8`: lowercase, ASCII
 * alnum, single-dash separators, trimmed to 96 chars. We trim trailing
 * dashes so titles with punctuation tails don't produce `foo-.md`.
 */
export async function createKbDocumentAction(args: {
    workId: string;
    class: KbDocumentClass;
    title: string;
    description?: string | null;
    tags?: string[];
}): Promise<ActionResult<{ id: string; path: string }>> {
    const { workId, class: docClass, title, description, tags } = args;
    try {
        const trimmedTitle = title.trim();
        if (trimmedTitle.length === 0) {
            return { success: false, error: 'Title is required' };
        }

        // Canonical slug — keep aligned with spec §8 path shape so the
        // git mirror + embed pipeline pick up the new row exactly the
        // same way uploaded docs do.
        const slug = trimmedTitle
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 96);
        if (slug.length === 0) {
            return {
                success: false,
                error: 'Title must contain at least one alphanumeric character',
            };
        }
        const path = `${docClass}/${slug}.md`;

        const created = await kbAPI.createDocument(workId, {
            path,
            title: trimmedTitle,
            class: docClass,
            body: '',
            description: description ?? null,
            tags: tags && tags.length > 0 ? tags : undefined,
        });

        revalidatePath(`/works/${workId}/kb`);
        revalidatePath(`/works/${workId}/kb/${created.path}`);

        return { success: true, data: { id: created.id, path: created.path } };
    } catch (error) {
        console.error('[kb-add-doc] failed to create KB document:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to create document',
        };
    }
}

/**
 * EW-641 KB workbench follow-up — delete a KB document.
 *
 * Powers the per-row trash in the tree (`KbTreeDocRow`), the per-class
 * bulk delete (`KbTreeClassDeleteButton`), and the detail-page
 * `KbDeleteDocButton`. All three call this server action with the
 * doc id (the backend accepts either id or path, but we surface the
 * id from the tree row to keep the route param deterministic + avoid
 * URL-encoding edge cases).
 *
 * Returns `{ id }` on success so the caller can correlate failures in
 * a `Promise.all` (the per-class bulk delete uses the id to surface
 * which rows didn't delete). On error, the envelope's `error` is a
 * short human-readable message — the UI surfaces a generic
 * `errorFallback` toast unless the response includes something more
 * specific.
 *
 * `revalidatePath` covers both the KB index (tree refresh) and the
 * deleted doc's URL (so any open detail tab gets a fresh 404 instead
 * of a stale render).
 */
export async function deleteKbDocumentAction(args: {
    workId: string;
    docId: string;
    /** Optional doc path — used purely to bust the detail-page route cache. */
    path?: string;
}): Promise<ActionResult<{ id: string }>> {
    const { workId, docId, path } = args;
    try {
        await kbAPI.deleteDocument(workId, docId);
        revalidatePath(`/works/${workId}/kb`);
        if (path) {
            revalidatePath(`/works/${workId}/kb/${path}`);
        }
        return { success: true, data: { id: docId } };
    } catch (error) {
        console.error('[kb-delete] failed to delete KB document:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to delete document',
        };
    }
}

/**
 * EW-641 Phase 2/e row 38d — "Override locally" server action.
 *
 * Forks an inherited org-overlay KB document into a new Work-scope
 * row at the same path/class so the operator can edit a local copy
 * while the upstream org doc keeps living in the inheritable layer.
 *
 * Flow:
 *   1. Fetch the inherited body via `kbAPI.getInheritedDocument`
 *      (row 38c-2 endpoint) — the user's session cookie carries
 *      through, so the gate is `ensureCanView(workId)`.
 *   2. POST to `/api/works/:id/kb/documents` via `kbAPI.createDocument`
 *      with `{ path, title, class, body, description, tags,
 *      categories, language }` copied from the org doc. The agent's
 *      `createDocument` enqueues the per-Work git mirror + embed
 *      pipeline automatically (rows 1B/a + 29c), so the new row
 *      lights up everywhere on its own.
 *   3. Revalidate the Work's KB index + the new doc's detail path
 *      so the next render shows the Work-scope row.
 *   4. Return `data.path` so the client can `router.push` to the
 *      new editable URL.
 *
 * The new row is intentionally NOT marked `locked` — the whole point
 * of "Override locally" is to land in an editable Tiptap surface.
 *
 * Conflict semantics: if the Work already has a row at `path`, the
 * agent will throw a `KbPathCollisionError`-style failure; we surface
 * that as a generic error message rather than catching specifically
 * (collisions shouldn't happen because the inherited row is only
 * shown when no Work-scope row exists at the same path; the
 * inherited tree section disappears the moment an override exists).
 *
 * NOTE: status/locked/lockMode propagation from the inherited row is
 * intentionally NOT preserved — the override is always a fresh,
 * unlocked, active doc. If the org doc was archived, the override
 * starts active; the operator can re-archive after copying.
 */
export async function overrideInheritedKbDocumentAction(args: {
    workId: string;
    orgId: string;
    idOrPath: string;
}): Promise<ActionResult<{ path: string; id: string }>> {
    const { workId, orgId, idOrPath } = args;
    try {
        // Step 1 — read the inherited body (row 38c-2 endpoint).
        const inherited = await kbAPI.getInheritedDocument(workId, orgId, idOrPath);

        // Step 2 — clone into Work scope. Casting the contract's
        // string-union `class` field through the boundary keeps the
        // standing rule (cumulative gotcha #5) intact — the contract
        // ships a closed string union; the agent re-validates against
        // its own enum so an unknown value 400s rather than slipping
        // into the DB. Tags/categories default to empty arrays when
        // null on the source doc.
        const cloned = await kbAPI.createDocument(workId, {
            path: inherited.path,
            title: inherited.title || inherited.path,
            class: inherited.class as KbDocumentClass,
            body: inherited.body ?? '',
            description: inherited.description ?? null,
            tags: inherited.tags ?? undefined,
            categories: inherited.categories ?? undefined,
            language: inherited.language || 'en',
        });

        // Step 3 — bust caches so the tree + detail page reflect the
        // new Work-scope row on the next render (the inherited section
        // also drops it because resolveInheritableDocuments prefers
        // Work overrides by path).
        revalidatePath(`/works/${workId}/kb`);
        revalidatePath(`/works/${workId}/kb/${cloned.path}`);

        // Step 4 — return the new doc path so the client can navigate.
        return { success: true, data: { path: cloned.path, id: cloned.id } };
    } catch (error) {
        console.error('[kb-inherited] failed to override inherited doc:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to override inherited document',
        };
    }
}
