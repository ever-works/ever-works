import { scanForSecrets, type AppSpec } from '@ever-works/contracts';
import type { GitDiffFile } from '@ever-works/plugin';

import { diffGuardedSpecBlocks } from '../app-spec/app-spec-guarded-blocks';
import { TASK_ORIGIN_APP_PROVISIONING } from '../entities/task-origin';

/**
 * APW-04 T10 / T57 (FR-28, FR-29, FR-30 — ACC-04-07, ACC-04-08, ACC-04-09,
 * ACC-04-34 guard half, ACC-NEG-05) — what an App provisioning run may put on its
 * branch, enforced in code.
 *
 * Until this module the rule lived only in the provisioner's brief ("Writable
 * paths are exactly `.works/works.yml` and `.works/overlay/**`"), and the provisioning Agent
 * reads an upstream repository whose README, `AGENTS.md` or source comments are
 * third-party text: a brief is a request, not a fence. These are the pure halves
 * of the fence; `AppChangeGuard.evaluate` applies them to every judgement of a
 * Task whose server-written `Task.origin` is `app-provisioning` (the finalize
 * path, the cloud path's pre-push `checkPaths`, the mount gate and the merge
 * gate), and the agent git tools apply {@link isProvisioningWritablePath} before
 * they write anything.
 *
 * ## The three rules
 *
 *   1. **Paths (FR-28) and size (FR-29)** — every changed path, and a rename's
 *      OLD path, is exactly `.works/works.yml` or under `.works/overlay/`
 *      ({@link isProvisioningWritablePath}); at most
 *      {@link APP_PROVISIONING_MAX_FILES} files and
 *      {@link APP_PROVISIONING_MAX_LINES} changed lines. Text tricks do not
 *      escape the set: a backslash, an absolute path, a drive letter, an empty,
 *      `.` or `..` segment, a control character, a nested `.git` and a case
 *      variant (`.WORKS/`) are all refused rather than normalised — a path a run
 *      had to disguise is not one it should write.
 *   2. **Secret literals** — the head App spec and the added lines of every
 *      `.works/**` patch carry no credential-shaped literal (the shared
 *      `scanForSecrets` table, minus its two prose-prone `key-` / `token-`
 *      prefixes). A refusal names the PATTERN, never the value.
 *   3. **Owner-owned spec switches** (T57) — the guarded-spec-block exemption
 *      provisioning keeps (it legitimately writes `source` / `blueprint`) no
 *      longer covers the blocks that decide what reaches the running App
 *      unattended: a provisioning run never switches ON
 *      `upstreamPullRequests.enabled` or `provisioning.autoReprovision`, never
 *      turns `upstreamPullRequests.requireApproval` off, and — when the base
 *      commit has a valid App spec — never changes `upstreamSync` or `license`
 *      and never removes an entry from `display.protectedPaths` /
 *      `agents.requireHumanMergePaths` (FR-30; additions stay allowed).
 *      With no valid base spec the base is "schema-safe defaults", so a hostile
 *      pre-seeded head spec is not inherited (ACC-NEG-05).
 *
 * ## The kill switch
 *
 * `APP_PROVISIONING_OUTPUT_GUARD_ENFORCED` — ON unless it is exactly `false`
 * (the works-security switches' rule). Off restores the brief-only behaviour.
 */

/** The directory every provisioning write is inside. */
export const APP_PROVISIONING_WRITABLE_ROOT = '.works';

/** FR-28 — the App spec itself, the one file outside the overlay a run may write. */
export const APP_PROVISIONING_SPEC_PATH = '.works/works.yml';

/** FR-28 — the overlay directory (an overlay Dockerfile and its context). */
export const APP_PROVISIONING_OVERLAY_DIR = '.works/overlay';

/** FR-29 — at most this many files in one proposal. */
export const APP_PROVISIONING_MAX_FILES = 12;

/** FR-29 — at most this many changed lines (additions + deletions) in one proposal. */
export const APP_PROVISIONING_MAX_LINES = 3000;

/** Operator switch for the whole guard. Default ON. */
export const APP_PROVISIONING_OUTPUT_GUARD_ENV = 'APP_PROVISIONING_OUTPUT_GUARD_ENFORCED' as const;

/** How many offending paths / patterns a refusal lists. */
export const APP_PROVISIONING_MAX_LISTED = 10;

/** Longest path text this guard will consider (anything longer is refused). */
const MAX_PATH_LENGTH = 1024;

/**
 * `TASK_ORIGIN_APP_PROVISIONING` when `origin` is exactly it, else `null` — for a
 * caller (the agent git tools) that must pass the origin on only for a
 * provisioning Task and must not import the entity graph to compare it.
 */
export function appProvisioningTaskOrigin(
    origin: unknown,
): typeof TASK_ORIGIN_APP_PROVISIONING | null {
    return origin === TASK_ORIGIN_APP_PROVISIONING ? TASK_ORIGIN_APP_PROVISIONING : null;
}

/** Default-safe: only an explicit `false` turns the provisioning output guard off. */
export function appProvisioningOutputGuardEnforced(
    env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
    return (env[APP_PROVISIONING_OUTPUT_GUARD_ENV] ?? '').trim().toLowerCase() !== 'false';
}

/**
 * May a provisioning run write `path` (FR-28)? `true` only for a plain,
 * relative, forward-slash path that is exactly `.works/works.yml` or names
 * something INSIDE `.works/overlay/` (`.works`, `.works/overlay` themselves — a
 * symlink or submodule swap of the directory — are refused).
 */
export function isProvisioningWritablePath(path: unknown): boolean {
    if (typeof path !== 'string') return false;
    if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
    // Control characters (NUL included), DEL and the C1 range: never a real path.
    if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) return false;
    // A backslash is a separator on Windows checkouts: `.works\..\src\x.ts`.
    if (path.includes('\\')) return false;
    // Absolute, or a drive-qualified Windows path.
    if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;

    const segments = path.split('/');
    for (const segment of segments) {
        if (segment === '' || segment === '.' || segment === '..') return false;
        // Windows drops trailing dots and spaces, so `.. ` / `..` alias.
        if (/[. ]$/.test(segment) && segment !== APP_PROVISIONING_WRITABLE_ROOT) return false;
        // A nested repository's metadata is never App spec content.
        if (segment.toLowerCase() === '.git') return false;
    }
    if (path === APP_PROVISIONING_SPEC_PATH) return true;
    return segments.length >= 3 && path.startsWith(`${APP_PROVISIONING_OVERLAY_DIR}/`);
}

/** FR-29 — the size half: `null` when within the limits, else which limit and the measure. */
export function provisioningSizeViolation(
    files: ReadonlyArray<Pick<GitDiffFile, 'additions' | 'deletions'>>,
    totalFiles?: number,
): { code: 'tooManyFiles' | 'tooManyLines'; count: number } | null {
    const list = files ?? [];
    const fileCount = Math.max(list.length, typeof totalFiles === 'number' ? totalFiles : 0);
    if (fileCount > APP_PROVISIONING_MAX_FILES) return { code: 'tooManyFiles', count: fileCount };
    const lines = list.reduce(
        (sum, file) => sum + (Number(file?.additions) || 0) + (Number(file?.deletions) || 0),
        0,
    );
    if (lines > APP_PROVISIONING_MAX_LINES) return { code: 'tooManyLines', count: lines };
    return null;
}

/**
 * The changed paths a provisioning run may NOT write, first-seen order, a
 * rename's old path included. Bounded by {@link APP_PROVISIONING_MAX_LISTED}.
 */
export function provisioningPathViolations(
    files: ReadonlyArray<Pick<GitDiffFile, 'path' | 'previousPath'>>,
): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const file of files ?? []) {
        for (const candidate of [file?.path, file?.previousPath]) {
            if (candidate === undefined || candidate === null) continue;
            if (isProvisioningWritablePath(candidate)) continue;
            const shown = displayPath(candidate);
            if (seen.has(shown)) continue;
            seen.add(shown);
            if (out.length < APP_PROVISIONING_MAX_LISTED) out.push(shown);
        }
    }
    return out;
}

/**
 * The secret patterns found in what a provisioning run writes: the head App
 * spec's text (every value, serialised) and the added lines of each
 * `.works/**` patch the diff carries. Pattern names only, de-duplicated —
 * never the matched text.
 */
export function provisioningSecretFindings(input: {
    readonly headSpec?: AppSpec | null;
    readonly files?: ReadonlyArray<Pick<GitDiffFile, 'path' | 'patch'>>;
}): string[] {
    const bodies: string[] = [];
    if (input.headSpec) {
        try {
            bodies.push(JSON.stringify(input.headSpec));
        } catch {
            // A spec that cannot be serialised was not parsed from YAML; nothing to scan.
        }
    }
    for (const file of input.files ?? []) {
        if (typeof file?.patch !== 'string' || !isProvisioningWritablePath(file.path)) continue;
        const added = file.patch
            .split('\n')
            .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
            .map((line) => line.slice(1))
            .join('\n');
        if (added) bodies.push(added);
    }

    const patterns = new Set<string>();
    for (const body of bodies) {
        for (const match of scanForSecrets(body)) {
            // The shared table's `generic` row also matches prose such as
            // `key-value-store` or `token-refresh`; in a spec those are names, not
            // credentials. `sk-…` and `Bearer …` stay in.
            if (match.pattern === 'generic' && /^(key-|token-)/i.test(match.matched)) continue;
            patterns.add(match.pattern);
        }
    }
    return [...patterns].slice(0, APP_PROVISIONING_MAX_LISTED);
}

/** The owner-owned spec fields a provisioning run changed (rule 3). */
export type ProvisioningSpecViolation =
    | 'upstreamPullRequests.enabled'
    | 'upstreamPullRequests.requireApproval'
    | 'provisioning.autoReprovision'
    | 'upstreamSync'
    | 'license'
    | 'display.protectedPaths'
    | 'agents.requireHumanMergePaths';

/**
 * Rule 3 — the owner-owned App spec switches a provisioning run changed.
 *
 * `base` is the validated spec at the base commit, or `null` when the base has
 * none (first provisioning) or it did not validate — in which case the base is
 * the schema-safe defaults (`upstreamPullRequests.enabled: false`,
 * `requireApproval: true`, `autoReprovision: false`), so a hostile pre-seeded
 * head is judged as a change, never inherited.
 */
export function provisioningSpecViolations(
    base: AppSpec | null | undefined,
    head: AppSpec | null | undefined,
): ProvisioningSpecViolation[] {
    if (!head) return [];
    const before = (base ?? null) as AppSpecLike | null;
    const after = head as AppSpecLike;
    const out: ProvisioningSpecViolation[] = [];

    if (
        after.upstreamPullRequests?.enabled === true &&
        before?.upstreamPullRequests?.enabled !== true
    ) {
        out.push('upstreamPullRequests.enabled');
    }
    if (
        after.upstreamPullRequests?.requireApproval === false &&
        before?.upstreamPullRequests?.requireApproval !== false
    ) {
        out.push('upstreamPullRequests.requireApproval');
    }
    if (
        after.provisioning?.autoReprovision === true &&
        before?.provisioning?.autoReprovision !== true
    ) {
        out.push('provisioning.autoReprovision');
    }
    if (before) {
        // With a valid base, these two are copied from it by the draft, verbatim.
        if (!sameJson(before.upstreamSync, after.upstreamSync)) out.push('upstreamSync');
        if (!sameJson(before.license, after.license)) out.push('license');
        // FR-30: protection is the owner's — tightening is fine, loosening is not.
        const removals = diffGuardedSpecBlocks(base, head);
        if (removals.removedProtectedPaths.length > 0) out.push('display.protectedPaths');
        if (removals.removedRequireHumanMergePaths.length > 0) {
            out.push('agents.requireHumanMergePaths');
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface AppSpecLike {
    upstreamPullRequests?: { enabled?: unknown; requireApproval?: unknown } | null;
    provisioning?: { autoReprovision?: unknown } | null;
    upstreamSync?: unknown;
    license?: unknown;
}

/** A path as a refusal may show it: no control characters, at most 300 characters. */
function displayPath(path: unknown): string {
    const text = typeof path === 'string' ? path : String(path);
    return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, 300);
}

/** Structural equality for JSON-shaped values, key order ignored. */
function sameJson(a: unknown, b: unknown): boolean {
    return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
    if (value === undefined || value === null) return 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
