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

// Mirrors `GIT_PROVIDER_PATTERNS` in `import/source-repo-analyzer.service.ts`
// so a URL the import analyser accepts is accepted here too.
const HOST_RULES: readonly HostRule[] = [
    {
        host: /^(www\.)?github\.com$/i,
        gitProvider: 'github',
        storageProvider: 'user-github',
        canonicalHost: 'github.com',
    },
    {
        host: /^(www\.)?gitlab\.com$/i,
        gitProvider: 'gitlab',
        storageProvider: 'user-gitlab',
        canonicalHost: 'gitlab.com',
    },
    {
        host: /^(www\.)?bitbucket\.org$/i,
        gitProvider: 'bitbucket',
        storageProvider: 'user-git',
        canonicalHost: 'bitbucket.org',
    },
];

const SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

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
    if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) {
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
