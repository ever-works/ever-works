/**
 * Prompt-injection hardening — repository paths an Agent may NEVER change,
 * whatever kind of Work it is working on, on every path its changes take to
 * the remote: the `commitToRepo` / `openPullRequest` tools, the cloud
 * workspace finalize (`TaskWorkspaceService.finalizeRun`) and the pull request
 * opened for a fleet-pushed branch.
 *
 * A workflow file is what RUNS a repository's checks, deploys and releases,
 * and a composite action under `.github/actions/` is code those workflows
 * execute with the repository's secrets. An Agent that can change either can
 * switch the checks off, or run arbitrary code in CI with the Work's tokens —
 * and for a non-App Work the push goes out on the owner's OAuth token, whose
 * `workflow` scope exists precisely so it CAN change these files.
 *
 * App Works additionally keep their change gate's own rules
 * (`app-change-guard.ts`); this floor applies to every kind.
 *
 * ## The opt-in (gate, don't remove)
 *
 * `AGENT_WORKFLOW_CHANGES_ALLOWED_WORKS` — a comma-separated list of Work ids
 * whose Agents MAY change these paths (default: empty, i.e. none). It lifts
 * only this floor; an App Work's change gate still applies its own rules.
 */
export const ALWAYS_PROTECTED_REPO_PREFIXES: readonly string[] = Object.freeze([
    '.github/workflows/',
    '.github/actions/',
]);

/** Operator switch naming the Works whose Agents may change protected paths. */
export const AGENT_WORKFLOW_CHANGES_ALLOWED_WORKS_ENV = 'AGENT_WORKFLOW_CHANGES_ALLOWED_WORKS';

/** Whether the operator lifted the protected-path floor for this Work. */
export function workflowChangesAllowedForWork(
    workId: string | null | undefined,
    env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
    if (!workId) return false;
    const listed = (env[AGENT_WORKFLOW_CHANGES_ALLOWED_WORKS_ENV] ?? '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);
    return listed.includes(workId.trim().toLowerCase());
}

/** `text` without trailing `/` characters — a loop, not a regex (linear on any input). */
function withoutTrailingSlashes(text: string): string {
    let end = text.length;
    while (end > 0 && text.charCodeAt(end - 1) === 47 /* '/' */) end -= 1;
    return text.slice(0, end);
}

/** A repository path in the form the guard compares: posix, no `./`, lower-cased. */
function comparable(path: string): string {
    let out = path.trim().replace(/\\/g, '/');
    while (out.startsWith('./')) out = out.slice(2);
    while (out.startsWith('/')) out = out.slice(1);
    return out.toLowerCase();
}

/**
 * Whether one repository path is under an always-protected prefix — or IS one
 * of the directories on the way to it. A change to the bare `.github`,
 * `.github/workflows` or `.github/actions` entry itself (turning it into a
 * symlink or a submodule) would swap every file under it at once.
 */
export function isAlwaysProtectedRepoPath(path: string | null | undefined): boolean {
    if (typeof path !== 'string' || !path.trim()) return false;
    const candidate = comparable(path);
    const bare = withoutTrailingSlashes(candidate);
    return ALWAYS_PROTECTED_REPO_PREFIXES.some((prefix) => {
        if (candidate.startsWith(prefix)) return true;
        // Every ancestor directory of the prefix: `.github`, `.github/workflows`.
        const parts = withoutTrailingSlashes(prefix).split('/');
        return parts.some((_, index) => bare === parts.slice(0, index + 1).join('/'));
    });
}

/** The distinct always-protected paths among `paths`, in first-seen order. */
export function alwaysProtectedRepoPaths(
    paths: ReadonlyArray<string | null | undefined>,
): string[] {
    const out: string[] = [];
    for (const path of paths) {
        if (isAlwaysProtectedRepoPath(path) && !out.includes(path as string)) {
            out.push(path as string);
        }
    }
    return out;
}

/** The refusal sentence shared by every path, naming the paths (never content). */
export function protectedRepoPathsRefusal(hits: readonly string[]): string {
    return (
        `agents may not change GitHub workflow or action files ` +
        `(${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ', …' : ''}). ` +
        `These run the repository's checks and deploys with its secrets; a person ` +
        `changes them (an operator can allow a Work with ${AGENT_WORKFLOW_CHANGES_ALLOWED_WORKS_ENV}).`
    );
}
