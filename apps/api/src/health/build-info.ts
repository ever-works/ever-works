/**
 * Build / release identity for the running API process.
 *
 * Values are injected at GitHub-build time as `--build-arg`s that the API
 * Dockerfile promotes to `ENV` (see `.deploy/docker/api/Dockerfile` and the
 * `docker-build-publish-*` workflows). Locally — or in any build that didn't
 * thread the args — every field degrades gracefully so the endpoint never
 * throws and dev still shows something sensible.
 *
 * The shape is deliberately small and 100% safe to publish: it carries no
 * secrets, only the version string + commit/build coordinates so anyone can
 * answer "which GitHub build is this API running?".
 */

/** Canonical repo, used to build a clickable commit URL. Overridable for forks. */
const REPO_URL = (
    process.env.GITHUB_REPO_URL || 'https://github.com/ever-works/ever-works'
).replace(/\/+$/, '');

export interface BuildInfo {
    /** Which component this describes — always `api` here. */
    name: 'api';
    /** Human-readable semver, e.g. `0.0.1`. */
    version: string;
    /** Full git commit SHA, or `dev` when unknown (local / un-stamped build). */
    gitSha: string;
    /** First 7 chars of `gitSha` for compact display. */
    shortSha: string;
    /** Branch or tag the build came from, e.g. `develop` / `v1.2.3`. */
    gitRef: string;
    /** GitHub Actions run number that produced the build. */
    buildRun: string;
    /** ISO-8601 build timestamp. */
    buildTime: string;
    /** Link to the exact commit on GitHub, or `null` when the SHA is unknown. */
    commitUrl: string | null;
}

function firstNonEmpty(...candidates: Array<string | undefined>): string {
    for (const c of candidates) {
        const v = c?.trim();
        if (v) return v;
    }
    return '';
}

/**
 * Read the build identity from the environment. Pure + cheap — safe to call
 * per request (the `/api/version` handler also sets a short Cache-Control).
 */
export function getBuildInfo(): BuildInfo {
    // `npm_package_version` is set by pnpm/npm when running package scripts
    // (e.g. `pnpm dev:api`), giving local dev a real version with no setup.
    const version = firstNonEmpty(
        process.env.BUILD_VERSION,
        process.env.npm_package_version,
        '0.0.0',
    );
    const gitSha = firstNonEmpty(process.env.GIT_SHA) || 'dev';
    const shortSha = gitSha === 'dev' ? 'dev' : gitSha.slice(0, 7);
    const gitRef = firstNonEmpty(process.env.GIT_REF);
    const buildRun = firstNonEmpty(process.env.BUILD_RUN);
    const buildTime = firstNonEmpty(process.env.BUILD_TIME);
    const isRealSha = /^[0-9a-f]{7,40}$/i.test(gitSha);

    return {
        name: 'api',
        version,
        gitSha,
        shortSha,
        gitRef,
        buildRun,
        buildTime,
        commitUrl: isRealSha ? `${REPO_URL}/commit/${gitSha}` : null,
    };
}
