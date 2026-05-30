/**
 * Build / release identity for the running WEB bundle.
 *
 * Unlike the API (which reads build info from runtime env), Next.js inlines
 * `NEXT_PUBLIC_*` values into the client bundle at `next build` time. The
 * docker-build-publish-* workflows pass them as `--build-arg`s which the web
 * Dockerfile promotes to `ENV` before `turbo build` runs.
 *
 * Each `process.env.NEXT_PUBLIC_*` MUST be referenced as a full static
 * literal (not via a computed key) or Next won't inline it. Hence the
 * explicit per-field reads below. Everything degrades to a `dev` fallback so
 * local `pnpm dev:web` still renders something sensible.
 */

const REPO_URL = (
    process.env.NEXT_PUBLIC_GITHUB_REPO_URL || 'https://github.com/ever-works/ever-works'
).replace(/\/+$/, '');

export interface WebBuildInfo {
    name: 'web';
    version: string;
    gitSha: string;
    shortSha: string;
    gitRef: string;
    buildRun: string;
    buildTime: string;
    commitUrl: string | null;
}

function clean(value: string | undefined): string {
    return value?.trim() || '';
}

export function getWebBuildInfo(): WebBuildInfo {
    const version =
        clean(process.env.NEXT_PUBLIC_BUILD_VERSION) ||
        clean(process.env.NEXT_PUBLIC_APP_VERSION) ||
        '0.0.0';
    const gitSha = clean(process.env.NEXT_PUBLIC_BUILD_SHA) || 'dev';
    const shortSha = gitSha === 'dev' ? 'dev' : gitSha.slice(0, 7);
    const gitRef = clean(process.env.NEXT_PUBLIC_BUILD_REF);
    const buildRun = clean(process.env.NEXT_PUBLIC_BUILD_RUN);
    const buildTime = clean(process.env.NEXT_PUBLIC_BUILD_TIME);
    const isRealSha = /^[0-9a-f]{7,40}$/i.test(gitSha);

    return {
        name: 'web',
        version,
        gitSha,
        shortSha,
        gitRef,
        buildRun,
        buildTime,
        commitUrl: isRealSha ? `${REPO_URL}/commit/${gitSha}` : null,
    };
}
