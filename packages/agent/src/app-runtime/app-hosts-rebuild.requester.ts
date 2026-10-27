import type { AppHostsRebuildAnswer, AppHostsRebuildRequester } from './app-hosts.service';

/** APW-05's `AppBuildsService.requestRebuild`, as narrow as this adapter calls it. */
export interface AppBuildsRebuildLike {
    requestRebuild(
        workId: string,
        userId: string,
    ): Promise<
        | { ok: true; build: { id?: string | null; status?: string | null }; deduped?: boolean }
        | { ok: false; code: string; retryAfterMinutes?: number }
    >;
}

/**
 * APW-05 → APW-06 T26 (lane aw-safety, 2026-10-26) — `APP_HOSTS_REBUILD_REQUESTER`, the binding
 * `app-hosts.service.ts` was written against and nothing provided: a primary-domain change under
 * the `rebuild` policy (§8.2:1110-1114) answered `rebuild_unavailable` for every App Work, so a
 * build-time host could never be changed.
 *
 * It maps APW-05's real signature onto the port's: `requestRebuild(workId, userId)` answering
 * `{ ok, build, deduped }` / `{ ok: false, code }` becomes `{ build, deduped, status }` /
 * `{ code, message }`, with `rebuildRateLimited` spelled `rate_limited` (what `isRateLimited`
 * reads). A request without a person (an event) acts as the Work's owner — the Build runs with the
 * owner's repository credential either way. APW-05 resolved LAZILY (`AppBuildsModule` and the
 * deploy request module must not import each other).
 */
export function appHostsRebuildRequester(
    resolveBuilds: () => AppBuildsRebuildLike | undefined,
    works?: { findById(id: string): Promise<{ userId?: string | null } | null> },
): AppHostsRebuildRequester {
    return {
        async requestRebuild(
            workId: string,
            opts: { userId?: string | null },
        ): Promise<AppHostsRebuildAnswer | null> {
            const builds = resolveBuilds();
            if (!builds || typeof builds.requestRebuild !== 'function') {
                throw new Error('APW-05 App Builds is not in this container.');
            }
            let userId = typeof opts?.userId === 'string' ? opts.userId : '';
            if (!userId && works) {
                const work = await works.findById(workId).catch(() => null);
                userId = String(work?.userId ?? '');
            }
            if (!userId) {
                return { code: 'rebuild_blocked', message: 'The Work has no owner to rebuild as.' };
            }

            const result = await builds.requestRebuild(workId, userId);
            if (result.ok === true) {
                const build = (result as { build: { id?: string | null; status?: string | null } })
                    .build;
                return {
                    build: { id: build?.id ?? null, status: build?.status ?? null },
                    deduped: (result as { deduped?: boolean }).deduped === true,
                    status: build?.status ?? null,
                };
            }
            const code = String((result as { code?: string }).code ?? 'rebuild_blocked');
            if (code === 'rebuildRateLimited') {
                return {
                    code: 'rate_limited',
                    message: 'Rebuilds are rate-limited right now; try again in a few minutes.',
                };
            }
            return { code, message: `The rebuild was refused (${code.slice(0, 60)}).` };
        },
    };
}
