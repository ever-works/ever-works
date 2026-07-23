/**
 * Display name for a git-provider slug.
 *
 * The repository a Work publishes for people to browse is labelled after
 * the host it lives on ("GitHub Repository", "GitLab Repository"), so the
 * casing has to be the vendor's own — a naive `capitalize()` would render
 * "Github", which reads as a typo.
 *
 * Unknown providers fall back to simple capitalization rather than being
 * dropped: `work.gitProvider` is backed by the git-provider plugin
 * registry, which third parties can extend.
 */
const GIT_PROVIDER_NAMES: Record<string, string> = {
    github: 'GitHub',
    gitlab: 'GitLab',
    bitbucket: 'Bitbucket',
    gitea: 'Gitea',
    codeberg: 'Codeberg',
};

/** Provider assumed when a Work has no explicit `gitProvider`. */
export const DEFAULT_GIT_PROVIDER_NAME = GIT_PROVIDER_NAMES.github;

export function formatGitProviderName(provider?: string | null): string {
    if (!provider) {
        return DEFAULT_GIT_PROVIDER_NAME;
    }
    const key = provider.trim().toLowerCase();
    if (!key) {
        return DEFAULT_GIT_PROVIDER_NAME;
    }
    return GIT_PROVIDER_NAMES[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}
