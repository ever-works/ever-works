import type { BackupDomainKey, BackupTrimPolicyKey, BackupTrimReport } from '@ever-works/contracts';

/**
 * Workspace backup (AW-22) — what a domain collector is, and what it is
 * given.
 *
 * A collector's whole job is to yield rows. It does not open the archive, it
 * does not know about zip entries, it does not decide whether the backup
 * succeeded and it does not catch its own errors — the runner owns all of
 * that, so a domain that throws costs its domain and nothing else (spec
 * FR-17).
 *
 * The fifteen collectors are DECLARATIVE rather than fifteen hand-written
 * classes: each one is a table of `{ file, entity, scope }` rows interpreted
 * by one engine. That is deliberate. Fifteen bespoke query walks over a
 * hundred tables would be a hundred chances to forget a workspace predicate,
 * and every one of those would be a row from somebody else's workspace in
 * somebody's downloaded archive. One engine means one place where the scope
 * predicate is written, and one place a reviewer has to read to believe it.
 */

/**
 * How a table is narrowed to one workspace.
 *
 * - `owner` — a single identity row matched on its primary key: the
 *   account itself, or the active organization's descriptor.
 * - `user` — rows that follow the person and carry no organization column.
 * - `workspace` — rows that carry BOTH `userId` and `organizationId`: the
 *   person AND the active organization, or `organizationId IS NULL` for the
 *   un-organized workspace. This is the common case and the strict one.
 * - `organization` — rows that carry only `organizationId`. A personal
 *   workspace has none, and the file comes out empty rather than unscoped:
 *   `organizationId IS NULL` is not a narrowing on a nullable column, it is
 *   "every row nobody has backfilled yet", so the plan is marked
 *   {@link BackupEntityQuery.matchesNothing} instead of queried.
 * - `parent` — child rows reached through ids their parent registered, so a
 *   table with no scope column of its own can still never cross a workspace.
 */
export type BackupScopeRule =
    | { readonly by: 'owner'; readonly of: 'account' | 'organization' }
    | { readonly by: 'user' }
    | { readonly by: 'workspace' }
    | { readonly by: 'organization' }
    | { readonly by: 'parent'; readonly column: string; readonly from: string };

/** One `*.jsonl` file inside a domain's directory. */
export interface BackupFileSpec {
    /** File name within the domain directory, e.g. `agents.jsonl`. */
    readonly file: string;
    /** Entity class name, as `AGENT_ENTITY_NAMES` spells it. */
    readonly entity: string;
    readonly scope: BackupScopeRule;
    /** Trim policy from the format module, applied when the table is history-shaped. */
    readonly trim?: BackupTrimPolicyKey;
    /**
     * Register this file's row ids under a name, so a later file in the SAME
     * domain (or a later domain) can scope itself by `parent`.
     */
    readonly registerIdsAs?: string;
    /** Column whose value is registered. Defaults to `id`. */
    readonly idColumn?: string;
    /**
     * This table points at stored file bytes. The runner queues them for
     * `files/<id>/<filename>` up to the attachment budget (spec FR-15, FR-23).
     */
    readonly bytes?: {
        readonly keyColumn: string;
        readonly nameColumn: string;
        readonly sizeColumn: string;
    };
}

/** One domain's table of files, in the order they are written. */
export interface BackupDomainSpec {
    readonly key: BackupDomainKey;
    readonly files: readonly BackupFileSpec[];
}

/** A file's bytes, queued while its metadata row was written. */
export interface QueuedBackupFile {
    readonly id: string;
    readonly storageKey: string;
    readonly filename: string;
    readonly sizeBytes: number;
}

/** The workspace one backup may see. */
export interface BackupScope {
    readonly userId: string;
    readonly organizationId: string | null;
    readonly tenantId: string | null;
}

/** What a collector is handed for one run. */
export interface BackupCollectContext {
    readonly scope: BackupScope;
    readonly includeFullHistory: boolean;
    /** The instant the backup started. Every trim cutoff is measured from it. */
    readonly now: Date;
    readonly source: BackupRowSource;
    /** Rows per query. Never load a whole table. */
    readonly pageSize: number;
    /** Queue an uploaded file's bytes for `files/`. */
    enqueueFile(file: QueuedBackupFile): void;
    /**
     * Ids registered by an earlier file, for `parent` scoping.
     *
     * `complete` is `false` when the file that produced them did not finish
     * — a page query that spent its retries, or a cancelled run. The ids
     * collected so far are still registered, because a partial list is the
     * best any dependent file can do, but the SHORTFALL has to travel with
     * them: a `parent` file planned off an incomplete list would otherwise
     * be indistinguishable from one whose parent genuinely had no rows, and
     * the manifest would report "you have none of these" for a section that
     * was never read. Defaults to `true`.
     */
    registerIds(name: string, ids: readonly string[], complete?: boolean): void;
    idsFor(name: string): readonly string[];
    /**
     * Did the file that registered `name` finish? `true` when nothing was
     * registered under that name at all — an absent registration is the
     * "no rows" case, which is already honest.
     *
     * Optional so an existing hand-built context keeps compiling; a context
     * that does not implement it is treated as complete.
     */
    idsComplete?(name: string): boolean;
    /** Cooperative cancellation, checked between pages (spec FR-8). */
    shouldStop(): boolean;
    /** Progress report, at least every 30 s inside a long domain (spec FR-5). */
    heartbeat(): Promise<void>;
}

/** A query the row source can answer, already narrowed to one workspace. */
export interface BackupEntityQuery {
    readonly entity: string;
    /** `column = value`, or `column IS NULL` when the value is `null`. */
    readonly equals: Readonly<Record<string, string | null>>;
    /**
     * Set when the scope rule cannot be satisfied at all for this run, so the
     * file is written EMPTY rather than queried.
     *
     * The case that matters is an `organization`-scoped file in a workspace
     * with no organization. The obvious predicate — `organizationId IS NULL`
     * — reads like "this workspace's rows" and is in fact "every row in the
     * table that has not been assigned an organization yet", which on the
     * four `organization`-scoped tables whose `organizationId` is nullable
     * is every OTHER account's rows. There is no narrowing to be had, so the
     * honest answer is no rows at all: `collector.types.ts` documents the
     * rule as "a personal workspace has none, and the file comes out empty
     * rather than unscoped", and this flag is what makes that true.
     *
     * A query carrying it never reaches SQL — the collector stops before
     * paging and the row source returns an empty page — so it cannot
     * degenerate into a predicate again downstream.
     */
    readonly matchesNothing?: boolean;
    /** `column IN (...)`. An empty id list means the query matches nothing. */
    readonly within?: { readonly column: string; readonly ids: readonly string[] };
    /** Rows older than the cutoff are left out and counted (spec FR-14). */
    readonly trim?: { readonly field: string; readonly cutoff: Date };
}

/**
 * Where rows come from. An interface rather than a `DataSource` so the
 * collectors and the runner are testable without a database, and so the
 * engine has exactly one query shape to build.
 */
export interface BackupRowSource {
    /** Does this build know this entity at all? */
    hasEntity(entity: string): boolean;
    /** Does this entity carry this column? Guards the scope predicate. */
    hasColumn(entity: string, column: string): boolean;
    /** One page of rows, ordered stably so two archives of unchanged data match. */
    page(
        query: BackupEntityQuery,
        offset: number,
        limit: number,
    ): Promise<Record<string, unknown>[]>;
    /** How many rows the trim cutoff excluded, for the manifest. */
    countTrimmed(query: BackupEntityQuery): Promise<number>;
}

/** One file a collector will produce, resolved for this run. */
export interface BackupFilePlan {
    /** Path inside the domain directory, e.g. `agents.jsonl`. */
    readonly file: string;
    readonly spec: BackupFileSpec;
    readonly query: BackupEntityQuery;
    /** Set when the entity is not in this build; the file is written empty. */
    readonly unavailable?: boolean;
    /**
     * Set when the file can be written but the reader must not read it as
     * whole — today, a `parent` file whose id list came from a registration
     * that did not finish. The runner turns this into the domain's error
     * code, so the coverage table says so rather than reporting `empty`.
     */
    readonly errorCode?: string;
}

/**
 * One of the fifteen. The runner walks `BACKUP_DOMAINS`, looks each key up in
 * the registry, and drives whatever it finds.
 */
export interface BackupCollector {
    readonly key: BackupDomainKey;
    /** Which files this domain writes for this run, in order. */
    plan(context: BackupCollectContext): Promise<BackupFilePlan[]>;
    /** The rows of one planned file, paged. */
    rows(
        context: BackupCollectContext,
        plan: BackupFilePlan,
    ): AsyncIterable<Record<string, unknown>>;
    /** Every trim this domain applied, for the manifest. */
    trims(
        context: BackupCollectContext,
        plans: readonly BackupFilePlan[],
    ): Promise<BackupTrimReport[]>;
}
