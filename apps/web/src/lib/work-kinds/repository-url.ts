/**
 * Repository coordinates for a `kind: 'repo'` Work, parsed on the client.
 *
 * Mirrors `parseRepositoryWorkSource` on the API closely enough to derive the
 * name, slug and description before the round trip; the API remains the
 * authority and re-parses everything it is given.
 *
 * This lives outside the form component because the two composers that route
 * INTO that form need it as well: whatever the user typed must be reduced to
 * canonical coordinates before it can go anywhere near a URL. See
 * `canonicalRepositoryUrl` for why.
 */

/**
 * Only GitHub is registrable today, and only `github.com/<owner>/<repo>`.
 *
 * Repository names may start with a dot (`.github`, `.dotfiles`); owners may
 * not — same rule as GitHub itself. The pattern is anchored and allows no
 * user-info, port, query or fragment, so a credential-bearing remote such as
 * `https://user:token@github.com/o/r` does not match at all.
 */
const REPOSITORY_URL_PATTERN =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]*?)(?:\.git)?\/?$/i;

export interface RepositoryCoordinates {
    owner: string;
    repo: string;
}

export function parseRepositoryUrl(value: string): RepositoryCoordinates | null {
    const match = REPOSITORY_URL_PATTERN.exec(value.trim());
    if (!match) return null;
    const [, owner, repo] = match;
    // `.` / `..` are path components, not repository names.
    if (!repo || repo === '.' || repo === '..') return null;
    return { owner, repo };
}

/**
 * The one form of a repository reference that is safe to put in a URL.
 *
 * Why this exists: the create composers hand the user's raw text to the
 * Repository form through the query string, and that text is often pasted
 * straight from a terminal — including remotes that carry a token in the
 * user-info section. A query parameter reaches browser history, the referrer
 * of every subsequent request, and any proxy or server access log, so the raw
 * value must never travel that way. Anything that does not reduce to
 * `owner/repo` returns null and the caller routes without a seed; the user
 * then types into the form field, which posts over TLS and is not logged.
 */
export function canonicalRepositoryUrl(value: string): string | null {
    const coords = parseRepositoryUrl(value);
    return coords ? `https://github.com/${coords.owner}/${coords.repo}` : null;
}

/** Same rules as the API slug regex: lowercase letters, digits, hyphens. */
export function slugifyForWork(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * A slug the API will accept: already canonical, so the value the user sees is
 * the value that gets stored. The `pattern` attribute on the input cannot be
 * relied on here because the form submits from a button handler rather than a
 * native `<form>`, so nothing enforces it.
 */
export function isCanonicalWorkSlug(value: string): boolean {
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed === slugifyForWork(trimmed);
}
