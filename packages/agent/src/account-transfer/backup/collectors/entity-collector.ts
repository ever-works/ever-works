import {
    BACKUP_DEFAULT_LIMITS,
    BACKUP_TRIM_POLICIES,
    type BackupDomainKey,
    type BackupTrimReport,
} from '@ever-works/contracts';
import { redactRow, shouldDropEntirely } from '../redaction';
import type {
    BackupCollectContext,
    BackupCollector,
    BackupDomainSpec,
    BackupEntityQuery,
    BackupFilePlan,
    BackupFileSpec,
    BackupScopeRule,
} from './collector.types';

/**
 * Workspace backup (AW-22) — the one engine that turns a domain's table of
 * file specs into rows.
 *
 * All fifteen collectors are instances of this class over different tables.
 * That is the point: the workspace predicate, the trim cutoff, the paging
 * and the redaction pass are each written ONCE, so a reviewer who believes
 * this file believes all fifteen domains. Fifteen hand-written walks would
 * be fifteen chances to forget an `organizationId IS NULL` — and every one
 * of those is somebody else's row in somebody's downloaded archive.
 *
 * ## Paging
 *
 * Offset paging with a stable `ORDER BY`, not a keyset cursor. A keyset would
 * be faster on the largest tables, but several of them order on a timestamp
 * stored as epoch-millis through a column transformer, and a cursor
 * comparison would have to re-apply that transformer by hand at every call
 * site. Correct and simple beats fast and subtly wrong for a job that runs
 * at most three times a day per workspace and already has an hour to finish.
 */
/**
 * Run one query, retrying a transient failure twice before giving up (spec
 * FR-17). The delay is short and fixed: the point is to ride out a dropped
 * connection or a lock timeout, not to wait out an outage — a backup has an
 * hour in total and fourteen other domains waiting.
 */
export async function withRetries<T>(
    work: () => Promise<T>,
    retries: number = BACKUP_DEFAULT_LIMITS.domainRetries,
): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await work();
        } catch (error) {
            lastError = error;
            if (attempt < retries) {
                await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
            }
        }
    }
    throw lastError;
}

export class EntityBackupCollector implements BackupCollector {
    readonly key: BackupDomainKey;

    constructor(private readonly spec: BackupDomainSpec) {
        this.key = spec.key;
    }

    async plan(context: BackupCollectContext): Promise<BackupFilePlan[]> {
        const plans: BackupFilePlan[] = [];
        for (const file of this.spec.files) {
            plans.push(this.planFile(context, file));
        }
        return plans;
    }

    /**
     * The same file, planned against the registrations as they stand NOW —
     * what makes a same-domain `parent` file see its parent's ids. See
     * {@link BackupCollector.replan}.
     */
    async replan(context: BackupCollectContext, plan: BackupFilePlan): Promise<BackupFilePlan> {
        return this.planFile(context, plan.spec);
    }

    async *rows(
        context: BackupCollectContext,
        plan: BackupFilePlan,
    ): AsyncIterable<Record<string, unknown>> {
        const skipped = this.skipReason(plan);
        if (skipped) {
            // A file that reads nothing still answers for the ids it was
            // supposed to register. These early returns used to sit BEFORE
            // the registration below, so a skipped parent left its name
            // unregistered — and an unregistered name reads as "complete, no
            // rows". A dependent file then wrote zero records with no error
            // and its domain reported `complete`/`empty` for data nobody
            // read: a personal workspace's `webhook-deliveries.jsonl` did
            // exactly that behind a skipped `webhook-subscriptions.jsonl`.
            if (plan.spec.registerIdsAs) {
                context.registerIds(plan.spec.registerIdsAs, [], skipped.complete);
            }
            return;
        }

        const collected: string[] = [];
        const idColumn = plan.spec.idColumn ?? 'id';
        let offset = 0;
        // Registration happens in the `finally` below, so it happens whether
        // this walk ran out of rows, was cancelled, or threw. Only the
        // first of those three means the id list is whole.
        let complete = false;

        try {
            for (;;) {
                if (context.shouldStop()) {
                    return;
                }
                const page = await withRetries(() =>
                    context.source.page(plan.query, offset, context.pageSize),
                );
                if (page.length === 0) {
                    break;
                }

                for (const raw of page) {
                    const row = redactRow(plan.spec.entity, raw);
                    if (!row) {
                        continue;
                    }
                    if (plan.spec.registerIdsAs) {
                        const id = raw[idColumn];
                        if (typeof id === 'string') {
                            collected.push(id);
                        }
                    }
                    if (plan.spec.bytes) {
                        this.queueBytes(context, plan.spec, raw);
                    }
                    yield row;
                }

                offset += page.length;
                if (page.length < context.pageSize) {
                    break;
                }
                // One heartbeat per page keeps a domain with a million rows from
                // looking stalled to the sweeper (spec FR-5).
                await context.heartbeat();
            }
            complete = true;
        } finally {
            // Registration used to sit AFTER the loop, so a page query that
            // spent its retries left the name unregistered entirely. A file
            // in a LATER domain scoped by that name then resolved an empty
            // id list, wrote zero records with no error, and the manifest
            // reported the section `empty` — "you have none of these" for a
            // workspace whose knowledge base was simply never read. Whatever
            // was collected is registered, and the shortfall travels with it.
            if (plan.spec.registerIdsAs) {
                context.registerIds(plan.spec.registerIdsAs, collected, complete);
            }
        }
    }

    async trims(
        context: BackupCollectContext,
        plans: readonly BackupFilePlan[],
    ): Promise<BackupTrimReport[]> {
        const reports: BackupTrimReport[] = [];
        for (const plan of plans) {
            if (plan.unavailable || !plan.query.trim) {
                continue;
            }
            if (plan.query.matchesNothing) {
                continue;
            }
            if (plan.query.within && plan.query.within.ids.length === 0) {
                continue;
            }
            const omittedRecords = await withRetries(() => context.source.countTrimmed(plan.query));
            if (omittedRecords > 0) {
                reports.push({
                    field: plan.query.trim.field,
                    cutoff: plan.query.trim.cutoff.toISOString(),
                    omittedRecords,
                });
            }
        }
        return reports;
    }

    /**
     * Why a plan reads no rows at all, and whether "no rows" is the whole
     * truth about it — or `undefined` when there are rows to read.
     *
     * `complete: true` only where the emptiness is PROVEN: an unscopable
     * file whose rows cannot belong to this workspace in the first place, or
     * a child whose finished parent had no ids. Everything else — a table
     * this build does not carry, one on the never-exported list, one whose
     * rows could not be told apart from another account's, a child of an
     * unfinished parent — is a file nobody read, and is registered as such.
     */
    private skipReason(plan: BackupFilePlan): { readonly complete: boolean } | undefined {
        if (plan.unavailable) {
            return { complete: false };
        }
        // A table on the never-exported list yields nothing at all, whatever
        // the spec table says — the drop rule wins over the coverage table.
        if (shouldDropEntirely(plan.spec.entity)) {
            return { complete: false };
        }
        if (plan.query.matchesNothing) {
            return { complete: plan.errorCode === undefined };
        }
        if (plan.query.within && plan.query.within.ids.length === 0) {
            return { complete: plan.errorCode === undefined };
        }
        return undefined;
    }

    /**
     * The rule this run applies to a file: its `personalScope` in a
     * workspace with no organization when it declares one, its `scope`
     * otherwise.
     */
    private ruleFor(context: BackupCollectContext, file: BackupFileSpec): BackupScopeRule {
        if (context.scope.organizationId === null && file.personalScope) {
            return file.personalScope;
        }
        return file.scope;
    }

    private planFile(context: BackupCollectContext, file: BackupFileSpec): BackupFilePlan {
        if (!context.source.hasEntity(file.entity)) {
            // This build does not carry the entity — a plugin-provided table
            // in a deployment that does not install it. The file is written
            // empty rather than skipped, so a reader can still tell "you have
            // none of these" from "we did not export these".
            return {
                file: file.file,
                spec: file,
                query: { entity: file.entity, equals: {} },
                unavailable: true,
            };
        }

        const equals: Record<string, string | null> = {};
        let within: BackupEntityQuery['within'];
        // Set when the rule needs an organization this workspace does not
        // have. The file is written empty; see BackupEntityQuery.matchesNothing.
        let matchesNothing = false;
        // Set when that emptiness cannot be proven, so the domain has to
        // report a gap rather than an absence.
        let unresolved = false;
        // Set to the registration name when this file's parent did not
        // finish producing its ids.
        let incompleteParent: string | undefined;

        const rule = this.ruleFor(context, file);

        switch (rule.by) {
            case 'owner':
                // A single identity row matched on its primary key: the
                // account for D1, the organization descriptor for D2. A
                // personal workspace has no organization row at all, so the
                // file comes out empty — asked as `id IS NULL` it would
                // merely HAPPEN to match nothing, because a primary key is
                // never null, and "it happens to be safe" is not the
                // property this file wants to rest on.
                if (rule.of === 'organization' && context.scope.organizationId === null) {
                    matchesNothing = true;
                    break;
                }
                equals.id =
                    rule.of === 'account'
                        ? context.scope.userId
                        : (context.scope.organizationId as string);
                break;
            case 'user':
                equals.userId = context.scope.userId;
                break;
            case 'workspace':
                equals[rule.userColumn ?? 'userId'] = context.scope.userId;
                if (context.source.hasColumn(file.entity, 'organizationId')) {
                    equals.organizationId = context.scope.organizationId;
                }
                break;
            case 'organization':
                // CROSS-ACCOUNT GUARD. `organizationId` is the ONLY column
                // this rule narrows on, so a workspace with no organization
                // has nothing to narrow with: `organizationId IS NULL` on a
                // nullable column selects every other account's
                // not-yet-organized rows too — contact emails, conversation
                // participants, code-host installation payloads, webhook
                // URLs — into a zip the requester downloads. It is never
                // asked.
                //
                // A table that has an owner column declares a
                // `personalScope` and never reaches this branch without an
                // organization (see `ruleFor`). What does reach it has no
                // way to find this workspace's rows, and the file is written
                // empty. Whether that empty is the TRUTH depends on the
                // column: NOT NULL means no row can belong to an un-organized
                // workspace ("you have none of these"); nullable, or a
                // source that cannot say, means rows may exist that were
                // simply not read — a gap the domain has to report.
                if (context.scope.organizationId === null) {
                    matchesNothing = true;
                    if (context.source.isNullable?.(file.entity, 'organizationId') !== false) {
                        unresolved = true;
                    }
                    break;
                }
                equals.organizationId = context.scope.organizationId;
                break;
            case 'parent':
                within = { column: rule.column, ids: context.idsFor(rule.from) };
                // An id list its producer never finished is a gap, not an
                // absence. Recorded on the plan so the domain reports it.
                if (context.idsComplete?.(rule.from) === false) {
                    incompleteParent = rule.from;
                }
                break;
        }

        const trim = this.resolveTrim(context, file);
        const errorCode = incompleteParent
            ? 'parent_ids_incomplete'
            : unresolved
              ? 'scope_unresolved'
              : undefined;

        return {
            file: file.file,
            spec: file,
            query: {
                entity: file.entity,
                equals,
                ...(within ? { within } : {}),
                ...(trim ? { trim } : {}),
                ...(matchesNothing ? { matchesNothing: true } : {}),
            },
            ...(errorCode ? { errorCode } : {}),
        };
    }

    private resolveTrim(
        context: BackupCollectContext,
        file: BackupFileSpec,
    ): { field: string; cutoff: Date } | undefined {
        if (!file.trim) {
            return undefined;
        }
        const policy = BACKUP_TRIM_POLICIES[file.trim];
        if (!policy || !context.source.hasColumn(file.entity, policy.field)) {
            return undefined;
        }
        const days = context.includeFullHistory ? policy.fullHistoryDays : policy.defaultDays;
        const cutoff = new Date(context.now.getTime() - days * 24 * 60 * 60 * 1000);
        return { field: policy.field, cutoff };
    }

    /**
     * Queue an uploaded file's bytes. The metadata row is written either way
     * — a file too large to carry is still DESCRIBED (spec FR-15, S-11) —
     * and the runner decides what actually fits.
     */
    private queueBytes(
        context: BackupCollectContext,
        file: BackupFileSpec,
        raw: Record<string, unknown>,
    ): void {
        const bytes = file.bytes;
        if (!bytes) return;

        const id = raw.id;
        const storageKey = raw[bytes.keyColumn];
        if (typeof id !== 'string' || typeof storageKey !== 'string' || storageKey.length === 0) {
            return;
        }
        const nameValue = raw[bytes.nameColumn];
        const sizeValue = raw[bytes.sizeColumn];
        context.enqueueFile({
            id,
            storageKey,
            filename: typeof nameValue === 'string' && nameValue.length > 0 ? nameValue : id,
            sizeBytes: Number(sizeValue) || 0,
        });
    }
}
