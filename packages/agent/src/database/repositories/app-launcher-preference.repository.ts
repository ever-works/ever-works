import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Not, Repository } from 'typeorm';
import { APP_LAUNCHER_MAX_PREFERENCE_ROWS } from '@ever-works/contracts';
import { AppLauncherPreference } from '../../entities/app-launcher-preference.entity';

/**
 * APW-11 App Launcher — the preference store (plan §3.2, §4.2 step 4).
 *
 * Every query is keyed by `userId` and never by a workspace scope alone
 * (spec FR-53): a save can only ever read or write the caller's own rows, and
 * the same per-item reason is returned for "does not exist" and "not yours"
 * because this repository never asks which of the two it was.
 *
 * Everything here is portable across Postgres and better-sqlite3 — no `unnest`,
 * no dialect-specific SQL — because the unit and e2e lanes run the latter, which
 * is what `app-launcher-preference.repository.spec.ts` executes against.
 */
@Injectable()
export class AppLauncherPreferenceRepository {
    constructor(
        @InjectRepository(AppLauncherPreference)
        private readonly repository: Repository<AppLauncherPreference>,
    ) {}

    /**
     * The caller's rows in the scopes of one request — for a panel open that is
     * `['global', <active scope>]`, spec FR-62's merged view (plan §4.1 step 3).
     *
     * A row whose scope is not asked for is not returned, which is the whole
     * mechanism behind "a pin made in Organization B never renumbers
     * Organization A": A's read never sees B's rows.
     *
     * Ordered by `updatedAt ASC` then `itemKey ASC` so the result is a total
     * order and two identical reads return identical arrays — `updatedAt` is
     * also FR-62's pin-time tie-break.
     */
    findForUser(
        userId: string,
        scopeKeys: ReadonlyArray<string>,
    ): Promise<AppLauncherPreference[]> {
        const scopes = uniqueScopes(scopeKeys);
        if (!userId || scopes.length === 0) {
            return Promise.resolve([]);
        }
        return this.repository.find({
            where: { userId, scopeKey: In(scopes) },
            order: { updatedAt: 'ASC', itemKey: 'ASC' },
        });
    }

    /**
     * Insert or merge-patch one row per `(scopeKey, itemKey)` with
     * `ON CONFLICT ("userId","scopeKey","itemKey") DO UPDATE` — spec FR-29's
     * last-write-wins **per item**, which is what lets two tabs changing
     * different tiles both persist (ACC-11-20).
     *
     * The conflict target is the table's unique constraint, named explicitly so
     * an unrelated constraint can never swallow a genuine failure.
     *
     * `updatedAt` is both written and overwritten deliberately: it is FR-62's
     * pin-time tie-break, so a row that keeps its original timestamp while its
     * `pinned` flag changes would render in the wrong position on the next
     * read.
     *
     * Rows are de-duplicated by `(scopeKey, itemKey)` first, last one winning,
     * because a single `INSERT … ON CONFLICT` statement cannot touch the same
     * key twice (Postgres: "ON CONFLICT DO UPDATE command cannot affect row a
     * second time") — and a caller building a batch from a UI can legitimately
     * emit two changes for one item.
     *
     * Returns the number of rows written.
     */
    async upsertMany(
        userId: string,
        rows: ReadonlyArray<AppLauncherPreferenceUpsert>,
        manager?: EntityManager,
    ): Promise<number> {
        if (!userId) {
            return 0;
        }

        const byKey = new Map<string, AppLauncherPreferenceUpsert>();
        for (const row of rows ?? []) {
            if (!row || typeof row.scopeKey !== 'string' || typeof row.itemKey !== 'string') {
                continue;
            }
            byKey.set(`${row.scopeKey}\u0000${row.itemKey}`, row);
        }
        if (byKey.size === 0) {
            return 0;
        }

        const now = new Date();
        const values = [...byKey.values()].map((row) => ({
            userId,
            scopeKey: row.scopeKey,
            itemKey: row.itemKey,
            visible: row.visible ?? true,
            pinned: row.pinned ?? false,
            pinOrder: row.pinOrder ?? null,
            sortOrder: row.sortOrder ?? null,
            updatedAt: now,
        }));

        await this.repoFor(manager)
            .createQueryBuilder()
            .insert()
            .into(AppLauncherPreference)
            .values(values)
            .orUpdate(
                ['visible', 'pinned', 'pinOrder', 'sortOrder', 'updatedAt'],
                ['userId', 'scopeKey', 'itemKey'],
            )
            .execute();

        return values.length;
    }

    /**
     * How many of the caller's rows in these scopes are pinned — spec FR-25's
     * count, taken over the merged view FR-62 defines.
     *
     * The caller passes the same `scopeKeys` it read with, so the number the
     * save path enforces and the number the panel renders cannot disagree.
     * `manager` is accepted because the save path re-counts **inside** its own
     * transaction (plan §4.2 step 3), which is what makes two racing saves
     * resolve to one winner rather than both seeing room for a seventh pin.
     */
    countPinned(
        userId: string,
        scopeKeys: ReadonlyArray<string>,
        manager?: EntityManager,
    ): Promise<number> {
        const scopes = uniqueScopes(scopeKeys);
        if (!userId || scopes.length === 0) {
            return Promise.resolve(0);
        }
        return this.repoFor(manager).count({
            where: { userId, scopeKey: In(scopes), pinned: true },
        });
    }

    /**
     * Spec FR-28's ceiling: each person holds at most
     * {@link APP_LAUNCHER_MAX_PREFERENCE_ROWS} stored rows, and the rows removed
     * first are the oldest whose item is **not** eligible any more — a Work that
     * was deleted or is no longer accessible (plan §4.2 step 5).
     *
     * An eligible item is never pruned, so a person at the ceiling who keeps
     * using the launcher never loses the arrangement they can still see.
     *
     * An **empty** `eligibleKeys` refuses the prune outright rather than reading
     * as "nothing is eligible": an empty set means the caller could not resolve
     * the eligible items at all (a catalog outage with no candidate Works, say),
     * and deleting rows on that answer would silently destroy an arrangement.
     * `ProductChangelogReadRepository.deleteBySlugsNotIn` takes the same posture
     * for the same reason.
     *
     * Returns the number of rows removed.
     */
    async pruneIneligible(
        userId: string,
        eligibleKeys: ReadonlyArray<string>,
        keep: number = APP_LAUNCHER_MAX_PREFERENCE_ROWS,
        manager?: EntityManager,
    ): Promise<number> {
        const eligible = [
            ...new Set((eligibleKeys ?? []).filter((key) => typeof key === 'string')),
        ];
        if (!userId || eligible.length === 0) {
            return 0;
        }

        const repository = this.repoFor(manager);
        const total = await repository.count({ where: { userId } });
        const ceiling = Number.isFinite(keep) ? Math.max(0, Math.trunc(keep)) : 0;
        if (total <= ceiling) {
            return 0;
        }

        const stale = await repository.find({
            select: { id: true },
            where: { userId, itemKey: Not(In(eligible)) },
            // Oldest first: the rows nobody has touched longest go first.
            order: { updatedAt: 'ASC', itemKey: 'ASC' },
            take: total - ceiling,
        });
        if (stale.length === 0) {
            return 0;
        }

        const result = await repository.delete({ id: In(stale.map((row) => row.id)) });
        return result.affected ?? 0;
    }

    /**
     * The transaction's repository when one was supplied, otherwise the
     * injected connection-scoped default — the established pattern in this
     * package (`AgentMembershipRepository.repoFor`).
     */
    private repoFor(manager?: EntityManager): Repository<AppLauncherPreference> {
        return manager?.getRepository(AppLauncherPreference) ?? this.repository;
    }
}

/**
 * One row of a save, as the service resolved it from a merge patch (plan §4.2
 * steps 3-4). `visible`/`pinned` default to the column defaults when omitted, so
 * a change that only moves an item still writes a complete, valid row.
 */
export interface AppLauncherPreferenceUpsert {
    scopeKey: string;
    itemKey: string;
    visible?: boolean;
    pinned?: boolean;
    pinOrder?: number | null;
    sortOrder?: number | null;
}

function uniqueScopes(scopeKeys: ReadonlyArray<string>): string[] {
    return [
        ...new Set(
            (scopeKeys ?? []).filter((scope) => typeof scope === 'string' && scope.length > 0),
        ),
    ];
}
