import { withWorkspaceScopeQuery, type WorkspaceScope } from '../workspace-scope';

/** The path the API mints for every uploaded file; the only URL family this decorates. */
const SERVE_PATH_PREFIX = '/api/uploads/';

/**
 * Put the tab's workspace on an API-minted serve URL (`/api/uploads/<userId>/
 * <sha256>.<ext>`) at RENDER time, for `<a href>` / `<img src>`, which cannot
 * carry a header. The serve route reads `?scope=` back and runs the lookup in
 * that Organization; without the carrier it runs personal.
 *
 * Render-time on purpose: the URL the API mints, the one stored in chat text,
 * and the one in attachment lists must stay scope-free — a stored scope would
 * freeze a tab context into persisted data. Anything that is not a serve URL
 * (a `blob:` preview, an absolute URL, `undefined`) is returned untouched.
 *
 * Lives apart from `uploads.ts` (the XHR uploader) on purpose: the composer
 * specs mock that module wholesale, and a render helper has no business in
 * a transport module anyway.
 */
export function withUploadServeScope<T extends string | undefined>(
    url: T,
    scope: WorkspaceScope | null,
): T {
    if (!url || !scope || !url.startsWith(SERVE_PATH_PREFIX)) return url;
    return withWorkspaceScopeQuery(url, scope) as T;
}
