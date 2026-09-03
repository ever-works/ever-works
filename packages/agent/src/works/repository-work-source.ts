/**
 * Repository Work source resolution (self-build slice D, EW-766).
 *
 * A `repo`-kind Work wraps an EXISTING code repository — the platform
 * monorepo, a template repo, the website repo — so Tasks, Goals and fleet
 * runs can attach to it. Nothing is provisioned for it: the repository the
 * user points at IS the Work's data repository, and `Work.getDataRepo()` /
 * `getRepoOwner()` must resolve to it verbatim because that is what
 * `TaskWorkspaceService` derives the isolated worktree from.
 *
 * Pure, dependency-free, so both the create path and its tests can use it
 * without standing up `SourceRepoAnalyzerService` (which needs the git
 * facade and exists to analyse awesome-list / data-repo imports — a job a
 * Repository Work never needs done).
 */

export interface RepositoryWorkSource {
    /** Canonical `https://<host>/<owner>/<repo>` form, `.git` and trailing slash stripped. */
    readonly url: string;
    readonly owner: string;
    readonly repo: string;
    /** Git provider plugin id — what `work.gitProvider` should carry. */
    readonly gitProvider: 'github' | 'gitlab' | 'bitbucket';
    /** Storage choice matching the provider — what `work.storageProvider` should carry. */
    readonly storageProvider: 'user-github' | 'user-gitlab' | 'user-git';
}

interface HostRule {
    readonly host: RegExp;
    readonly gitProvider: RepositoryWorkSource['gitProvider'];
    readonly storageProvider: RepositoryWorkSource['storageProvider'];
    readonly canonicalHost: string;
}

/**
 * Hosts a Repository Work may point at.
 *
 * GitHub only, on purpose. `packages/plugins/` ships exactly one git-provider
 * plugin (`github`), so a Work persisted with `gitProvider: 'gitlab'` would
 * be one no Task can ever clone: `TaskWorkspaceService.provisionForRun`
 * asks the git facade for a token for that provider and dies with "no git
 * credentials are available for provider gitlab" on every fleet run, with
 * no hint at creation time. Refusing the URL here is the honest failure.
 *
 * When a GitLab / Bitbucket plugin lands, add its rule here AND revisit the
 * path parsing below: GitLab allows nested groups
 * (`https://gitlab.com/group/subgroup/project`), so `owner` must become
 * every segment but the last rather than requiring exactly two. The
 * `gitProvider` / `storageProvider` unions on `RepositoryWorkSource`
 * already carry the future values so nothing downstream has to widen.
 */
const HOST_RULES: readonly HostRule[] = [
    {
        host: /^(www\.)?github\.com$/i,
        gitProvider: 'github',
        storageProvider: 'user-github',
        canonicalHost: 'github.com',
    },
];

// GitHub owners (users and orgs) must start alphanumeric; repository names
// may not — `.github` (org profile / shared workflows) and `.dotfiles`-style
// repos are common and legitimate. Both stay bounded at 100 characters, and
// a repo of only dots is rejected because `.` / `..` are path components,
// not names.
const OWNER_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
const REPO_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/**
 * Parse a repository URL into the coordinates a Repository Work persists.
 *
 * Accepts `https://github.com/owner/repo`, the same with `.git` / a
 * trailing slash / `http`, and the scheme-less `github.com/owner/repo`.
 * Returns `null` for anything else — never throws, so the create path can
 * turn a bad URL into a 400 instead of a 500.
 *
 * Owner and repo are kept in the case the user wrote them: GitHub treats
 * them case-insensitively, but `getDataRepo()` is used verbatim in clone
 * URLs and display, and lower-casing would silently rewrite a repo the
 * user knows as `Ever-Works/ever-works`.
 */
export function parseRepositoryWorkSource(
    input: string | null | undefined,
): RepositoryWorkSource | null {
    if (typeof input !== 'string') {
        return null;
    }
    const trimmed = input.trim();
    if (!trimmed || trimmed.length > 400) {
        return null;
    }
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return null;
    }
    // A credential or query/fragment in a repo URL is never intentional
    // here and would otherwise be persisted into `sourceRepository.url`.
    if (url.username || url.password || url.search || url.hash) {
        return null;
    }

    const rule = HOST_RULES.find((candidate) => candidate.host.test(url.hostname));
    if (!rule) {
        return null;
    }

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 2) {
        return null;
    }
    const owner = segments[0];
    const repo = segments[1].replace(/\.git$/i, '');
    if (!OWNER_SEGMENT.test(owner) || !REPO_SEGMENT.test(repo)) {
        return null;
    }

    return {
        url: `https://${rule.canonicalHost}/${owner}/${repo}`,
        owner,
        repo,
        gitProvider: rule.gitProvider,
        storageProvider: rule.storageProvider,
    };
}
