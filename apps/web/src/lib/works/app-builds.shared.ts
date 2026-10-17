/**
 * APW-05 T25–T28 — the pure half of the Builds tab: the list shape the web reads,
 * the poll cadence, and the small formatters both the server page and the client
 * components need.
 *
 * ## Why this module carries no directive
 *
 * The Builds page is a server component and the list, drawer and Overview card
 * are client components. A server module that imports a plain value from a
 * `'use client'` module receives a client reference, not the value (the
 * `/new` + `/works/new` crash `scripts/check-server-client-boundary.mjs` guards
 * against). So everything both sides call lives here: no `'use client'`, and no
 * `server-only` either, because the client components import it too.
 */
import type {
    AppBuildBlockedReason,
    AppBuildStatus,
    AppBuildSummary,
    AppBuildTrigger,
} from '@ever-works/contracts';

/** Poll every 5 s while any listed Build is `queued` or `running`. */
export const APP_BUILDS_POLL_ACTIVE_MS = 5_000;

/** Poll every 30 s otherwise, so a push-triggered Build still appears. */
export const APP_BUILDS_POLL_IDLE_MS = 30_000;

/** Statuses that keep the list polling at the active cadence. */
const ACTIVE_STATUSES: ReadonlySet<AppBuildStatus> = new Set<AppBuildStatus>(['queued', 'running']);

/** Pull access to the pushed image, as the list response reports it (plan §5). */
export interface AppBuildsPullAccess {
    visibility: 'public' | 'private' | 'unknown';
    tokenSet: boolean;
    tokenExpiresAt: string | null;
}

/** The workflow-preparation state the list response carries (plan §5, `APW05-G03`). */
export interface AppBuildsWorkflowState {
    state: string;
    pullRequestUrl: string | null;
}

/**
 * `GET /api/works/:id/builds`, normalised (plan §5): `{ items, total, page,
 * pageSize, provider, repository, imageRepository, workflow, pullAccess }`.
 *
 * Every field the web reads has a defined fallback, because the route ships in
 * another lane (aw-builds) and an older or partial answer must still render.
 */
export interface AppBuildsList {
    items: AppBuildSummary[];
    total: number;
    page: number;
    pageSize: number;
    provider: { pluginId: string; name: string; buildKind: string } | null;
    repository: { fullName: string; visibility: string } | null;
    imageRepository: string | null;
    workflow: AppBuildsWorkflowState;
    pullAccess: AppBuildsPullAccess | null;
}

/** What the Builds page hands its client list on first paint. */
export type AppBuildsListState =
    | { kind: 'ok'; list: AppBuildsList }
    /** The route answered 404 — not deployed on this instance yet. A calm empty state. */
    | { kind: 'unavailable' }
    | { kind: 'error' };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Accepts the plan's `{ items, … }` answer, a `{ builds }` or `{ data }` wrapper,
 * or a bare array — whichever the aw-builds controller ends up shipping — and
 * always returns a complete {@link AppBuildsList}.
 */
export function normalizeAppBuildsList(raw: unknown): AppBuildsList {
    const body = isRecord(raw) ? raw : {};
    const itemsSource = Array.isArray(raw)
        ? raw
        : Array.isArray(body.items)
          ? body.items
          : Array.isArray(body.builds)
            ? body.builds
            : Array.isArray(body.data)
              ? body.data
              : [];
    const items = itemsSource.filter(
        (entry): entry is AppBuildSummary => isRecord(entry) && typeof entry.id === 'string',
    );

    const provider = isRecord(body.provider)
        ? {
              pluginId: String(body.provider.pluginId ?? ''),
              name: String(body.provider.name ?? ''),
              buildKind: String(body.provider.buildKind ?? ''),
          }
        : null;
    const repository =
        isRecord(body.repository) && typeof body.repository.fullName === 'string'
            ? {
                  fullName: body.repository.fullName,
                  visibility: String(body.repository.visibility ?? ''),
              }
            : null;
    const workflow: AppBuildsWorkflowState = isRecord(body.workflow)
        ? {
              state: String(body.workflow.state ?? 'none'),
              pullRequestUrl: stringOrNull(body.workflow.pullRequestUrl),
          }
        : { state: 'none', pullRequestUrl: null };
    const pullAccess: AppBuildsPullAccess | null = isRecord(body.pullAccess)
        ? {
              visibility:
                  body.pullAccess.visibility === 'public' ||
                  body.pullAccess.visibility === 'private'
                      ? body.pullAccess.visibility
                      : 'unknown',
              tokenSet: body.pullAccess.tokenSet === true,
              tokenExpiresAt: stringOrNull(body.pullAccess.tokenExpiresAt),
          }
        : null;

    return {
        items,
        total: finiteNumber(body.total, items.length),
        page: finiteNumber(body.page, 1),
        pageSize: finiteNumber(body.pageSize, Math.max(items.length, 20)),
        provider,
        repository,
        imageRepository: stringOrNull(body.imageRepository),
        workflow,
        pullAccess,
    };
}

/**
 * `POST /api/works/:id/builds` answers `202 { build, deduped }` (plan §5); a
 * `{ buildId }` answer or a bare Build are tolerated as well.
 */
export function normalizeStartBuildAnswer(raw: unknown): {
    build: AppBuildSummary | null;
    buildId: string | null;
    deduped: boolean;
} {
    const body = isRecord(raw) ? raw : {};
    const candidate = isRecord(body.build)
        ? body.build
        : isRecord(raw) && 'status' in body
          ? body
          : null;
    const build =
        candidate && typeof candidate.id === 'string'
            ? (candidate as unknown as AppBuildSummary)
            : null;
    return {
        build,
        buildId: build?.id ?? stringOrNull(body.buildId),
        deduped: body.deduped === true,
    };
}

export function isAppBuildActive(status: AppBuildStatus): boolean {
    return ACTIVE_STATUSES.has(status);
}

export function hasActiveAppBuild(items: readonly AppBuildSummary[]): boolean {
    return items.some((build) => isAppBuildActive(build.status));
}

/** The poll interval for the current list. */
export function appBuildsPollInterval(items: readonly AppBuildSummary[]): number {
    return hasActiveAppBuild(items) ? APP_BUILDS_POLL_ACTIVE_MS : APP_BUILDS_POLL_IDLE_MS;
}

/** First 7 characters of a commit SHA, the way GitHub shows it. */
export function shortSha(sha: string | null | undefined): string {
    return typeof sha === 'string' ? sha.slice(0, 7) : '';
}

/** `sha256:4f1c…` — the digest prefix plus 4 hex characters, for a row. */
export function shortDigest(digest: string | null | undefined): string {
    if (typeof digest !== 'string' || digest.length === 0) return '';
    const [algorithm, hex] = digest.includes(':') ? digest.split(':', 2) : ['sha256', digest];
    return `${algorithm}:${hex.slice(0, 4)}…`;
}

/** `ghcr.io/acme/app/ever-works-app@sha256:…`, or `null` when nothing was pushed. */
export function appBuildImageReference(
    build: Pick<AppBuildSummary, 'imageRepository' | 'imageDigest'>,
): string | null {
    if (!build.imageRepository || !build.imageDigest) return null;
    return `${build.imageRepository}@${build.imageDigest}`;
}

/** `45s`, `4m 10s`, `1h 2m` — the spec's duration format (spec §6.1). */
export function formatAppBuildDuration(seconds: number | null | undefined): string {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
    const total = Math.round(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${rest}s`;
    return `${rest}s`;
}

/** The i18n leaf under `builds.trigger.*` for a trigger (`pull_request` → `pullRequest`). */
export function appBuildTriggerKey(
    trigger: AppBuildTrigger,
): 'push' | 'pullRequest' | 'manual' | 'verification' {
    return trigger === 'pull_request' ? 'pullRequest' : trigger;
}

/**
 * Every placeholder any Builds message may reference, with a neutral default,
 * overlaid by the values a Build actually carries (`failureDetail`,
 * `blockedDetail`). next-intl reports a missing ICU argument as an error and
 * renders the key instead of the sentence, so a detail bag that omits `max`
 * must still produce readable copy.
 */
const PARAM_DEFAULTS: Record<string, string | number> = {
    memory: '—',
    max: '—',
    step: '?',
    total: '?',
    command: '—',
    dockerfile: 'Dockerfile',
    names: '—',
    name: '—',
    minutes: '—',
    failed: '?',
    hosts: '—',
    count: 0,
    needed: '—',
    visibility: '—',
    service: '—',
    image: '—',
    kind: '—',
    strategy: '—',
    repository: '—',
    perWork: '—',
    perAccount: '—',
};

export function appBuildMessageParams(
    ...details: Array<Record<string, unknown> | null | undefined>
): Record<string, string | number> {
    const params: Record<string, string | number> = { ...PARAM_DEFAULTS };
    for (const detail of details) {
        if (!detail) continue;
        for (const [key, value] of Object.entries(detail)) {
            if (typeof value === 'number' && Number.isFinite(value)) params[key] = value;
            else if (typeof value === 'string') params[key] = value;
            else if (Array.isArray(value)) {
                params[key] = value.map(String).join(', ');
                if (key === 'names' && !('count' in detail)) params.count = value.length;
            }
        }
    }
    return params;
}

/** Map a blocked reason to a link target, or `null` when it is a plain notice. */
export type AppBuildBlockedLink =
    | { kind: 'external'; href: string }
    | { kind: 'internal'; href: string }
    | { kind: 'rebuild' }
    | null;

/**
 * The i18n key + values for a refused Build mutation (plan §5's stable codes),
 * so the list, the drawer and the Overview card say the same thing.
 */
export type AppBuildRefusalKey =
    | 'errors.rebuildRateLimited'
    | 'errors.commitNotReachable'
    | 'errors.nothingToBuild'
    | 'errors.notCancellable'
    | 'errors.providerUnavailable'
    | 'errors.startFailed'
    | 'viewerDisabled'
    | 'empty.unavailable';

export function appBuildRefusalMessage(result: {
    code?: string;
    statusCode?: number;
    details?: Record<string, unknown>;
}): { key: AppBuildRefusalKey; values?: Record<string, string | number> } {
    switch (result.code) {
        case 'rebuildRateLimited': {
            const minutes = Number(result.details?.retryAfterMinutes);
            return {
                key: 'errors.rebuildRateLimited',
                values: { minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 60 },
            };
        }
        case 'commitNotReachable':
            return { key: 'errors.commitNotReachable' };
        case 'nothingToBuild':
            return { key: 'errors.nothingToBuild' };
        case 'notCancellable':
            return { key: 'errors.notCancellable' };
        case 'buildProviderUnavailable':
            return { key: 'errors.providerUnavailable' };
        default:
            break;
    }
    if (result.statusCode === 403) return { key: 'viewerDisabled' };
    if (result.statusCode === 404) return { key: 'empty.unavailable' };
    if (result.statusCode === 503) return { key: 'errors.providerUnavailable' };
    return { key: 'errors.startFailed' };
}

/** Insert a Build at the top of a list, or replace it in place when it is already there. */
export function upsertAppBuild(list: AppBuildsList, build: AppBuildSummary): AppBuildsList {
    const index = list.items.findIndex((entry) => entry.id === build.id);
    if (index >= 0) {
        const items = list.items.slice();
        items[index] = build;
        return { ...list, items };
    }
    return { ...list, items: [build, ...list.items], total: list.total + 1 };
}

/** The blocked reasons the contract knows, as a guard for an unknown value off the wire. */
export function isKnownBlockedReason(
    reason: string | null | undefined,
    known: readonly AppBuildBlockedReason[],
): reason is AppBuildBlockedReason {
    return typeof reason === 'string' && (known as readonly string[]).includes(reason);
}
