import { Logger } from '@nestjs/common';

/**
 * Asks the provider whether an App Work's repository is public, right now.
 *
 * ## Why this exists (2026-10-18, live App Works E2E)
 *
 * Nothing in the tree records a repository's visibility, so
 * `UpstreamBuildFactsSource` answers `private` as its documented fail-safe. That
 * answer is not only slower for a public repository: it selects the private
 * runner class (2 vCPU / 7 GiB), so a public App whose Blueprint declares more
 * build memory is blocked `runnerTooSmall` although the public runner
 * (4 vCPU / 16 GiB) fits it. Cal (`calcom/cal.diy` forked to `ever-works`,
 * `build.resources.memory: 12Gi`) was refused on prod for exactly that.
 *
 * ## Fail-safe, still
 *
 * Only an explicit `private: false` + `visibility: "public"` from GitHub upgrades
 * the answer. Every other outcome — no token, a non-200, a timeout, a malformed
 * body — returns `null` and the caller keeps the facts source's answer. A private
 * repository can therefore never be routed to the public runner by this probe.
 *
 * Answers are cached per repository for {@link VISIBILITY_CACHE_TTL_MS} because
 * the watch runner resolves the binding on every poll.
 */
export type RepositoryVisibilityProbe = (input: {
    readonly owner: string;
    readonly repo: string;
    readonly token: string;
}) => Promise<'public' | 'private' | null>;

/** How long a provider answer is reused. Short: a repository can be made private. */
export const VISIBILITY_CACHE_TTL_MS = 5 * 60 * 1000;

/** Per-request ceiling; the probe never holds a prepare or a poll for longer. */
const PROBE_TIMEOUT_MS = 5000;

const GITHUB_API_URL = 'https://api.github.com';

export function createGitHubRepositoryVisibilityProbe(
    fetchImpl: typeof fetch = globalThis.fetch,
    now: () => number = Date.now,
): RepositoryVisibilityProbe {
    const logger = new Logger('RepositoryVisibilityProbe');
    const cache = new Map<string, { visibility: 'public' | 'private'; expiresAt: number }>();

    return async ({ owner, repo, token }) => {
        if (!owner || !repo || !token || typeof fetchImpl !== 'function') return null;
        const key = `${owner}/${repo}`.toLowerCase();
        const cached = cache.get(key);
        if (cached && cached.expiresAt > now()) return cached.visibility;

        try {
            const response = await fetchImpl(
                `${GITHUB_API_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
                {
                    headers: {
                        Accept: 'application/vnd.github+json',
                        Authorization: `Bearer ${token}`,
                        'User-Agent': 'ever-works-app-builds',
                        'X-GitHub-Api-Version': '2022-11-28',
                    },
                    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
                },
            );
            if (!response.ok) {
                logger.warn(
                    `Visibility of ${key}: GitHub answered ${response.status}; keeping the safe default.`,
                );
                return null;
            }
            const body = (await response.json()) as { private?: unknown; visibility?: unknown };
            const visibility: 'public' | 'private' =
                body?.private === false && body?.visibility === 'public' ? 'public' : 'private';
            cache.set(key, { visibility, expiresAt: now() + VISIBILITY_CACHE_TTL_MS });
            return visibility;
        } catch (error) {
            logger.warn(
                `Visibility of ${key}: the lookup failed (${
                    error instanceof Error ? error.message : String(error)
                }); keeping the safe default.`,
            );
            return null;
        }
    };
}
