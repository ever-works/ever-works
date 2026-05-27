/**
 * EW-641 Phase 2/c row 35e — pull a Work id out of the current
 * `usePathname()` result so the row 35d `<KbCitationRenderer>` /
 * `<KbCitationFooter>` can resolve citations against the right
 * Work without threading a prop through `ChatProvider`.
 *
 * Why a path-derived approach: the `ChatProvider` is mounted in the
 * dashboard root layout and the conversation surface is generic
 * (not Work-scoped). Threading a `workId` prop would require either
 * a per-page provider remount (loses chat history continuity) or a
 * cross-cutting context everyone is forced to think about. The
 * pathname already carries the Work scope when relevant — the same
 * `sendMessage()` path already passes `currentPageUrl` to the API
 * for the agent's KB grounding — so reading it here is symmetric
 * and avoids invasive plumbing.
 *
 * Path shape (current): `/works/<id>/...` — the platform serves the
 * dashboard without a locale prefix (`localePrefix: 'never'`).
 * Path shape (legacy, still accepted): `/<locale>/works/<id>/...` —
 * any older bookmark / cached path that still carries the prefix
 * resolves the same way, so the helper survives the migration.
 *
 * Returns `null` for:
 *  - any path NOT matching one of the two shapes above,
 *  - the `/works` index without an id,
 *  - non-string input,
 *  - paths where the captured id is empty / whitespace-only.
 *
 * **Pure function.** No I/O, no module state. Safe in any client
 * component render path.
 */

/**
 * Match either `/works/<id>` (current, unprefixed) or
 * `/<locale>/works/<id>` (legacy, locale-prefixed) optionally followed
 * by `/...` or end. The id capture excludes `/` so nested KB paths
 * (`/kb/brand/voice`) don't accidentally claim a multi-segment id.
 */
const WORK_PATH_RE = /^(?:\/[^/]+)?\/works\/([^/?#]+)(?:[/?#]|$)/;

export function extractWorkIdFromPath(pathname: string | null | undefined): string | null {
    if (typeof pathname !== 'string') return null;
    const trimmed = pathname.trim();
    if (trimmed.length === 0) return null;
    const m = trimmed.match(WORK_PATH_RE);
    if (!m) return null;
    const id = m[1].trim();
    return id.length > 0 ? id : null;
}
