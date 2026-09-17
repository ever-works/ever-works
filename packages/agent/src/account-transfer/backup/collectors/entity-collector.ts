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

    async *rows(
        context: BackupCollectContext,
        plan: BackupFilePlan,
    ): AsyncIterable<Record<string, unknown>> {
        if (plan.unavailable) {
            return;
        }
        // A table on the never-exported list yields nothing at all, whatever
        // the spec table says — the drop rule wins over the coverage table.
        if (shouldDropEntirely(plan.spec.entity)) {
            return;
        }
        if (plan.query.matchesNothing) {
            return;
        }
        if (plan.query.within && plan.query.within.ids.length === 0) {
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
        // Set to the registration name when this file's parent did not
        // finish producing its ids.
        let incompleteParent: string | undefined;

        switch (file.scope.by) {
            case 'owner':
                // A single identity row matched on its primary key: the
                // account for D1, the organization descriptor for D2. A
                // personal workspace has no organization row at all, so the
                // file comes out empty — asked as `id IS NULL` it would
                // merely HAPPEN to match nothing, because a primary key is
                // never null, and "it happens to be safe" is not the
                // property this file wants to rest on.
                if (file.scope.of === 'organization' && context.scope.organizationId === null) {
                    matchesNothing = true;
                    break;
                }
                equals.id =
                    file.scope.of === 'account'
                        ? context.scope.userId
                        : (context.scope.organizationId as string);
                break;
            case 'user':
                equals.userId = context.scope.userId;
                break;
            case 'workspace':
                equals.userId = context.scope.userId;
                if (context.source.hasColumn(file.entity, 'organizationId')) {
                    equals.organizationId = context.scope.organizationId;
                }
                break;
            case 'organization':
                // CROSS-ACCOUNT GUARD. `organizationId` is the ONLY column
                // this rule narrows on, so a workspace with no organization
                // has nothing to narrow with. Four of the tables this rule
                // covers — OnboardingRequest, EmailConversation,
                // GitHubAppInstallation, WebhookSubscription — declare
                // `organizationId` nullable and document NULL as the default
                // state until the owner creates their first organization, so
                // `organizationId IS NULL` would select every other
                // account's rows: contact emails, conversation participants,
                // code-host installation payloads and webhook URLs, into a
                // zip the requester downloads. There is no narrowing
                // available here, so the file yields nothing.
                if (context.scope.organizationId === null) {
                    matchesNothing = true;
                    break;
                }
                equals.organizationId = context.scope.organizationId;
                break;
            case 'parent':
                within = { column: file.scope.column, ids: context.idsFor(file.scope.from) };
                // An id list its producer never finished is a gap, not an
                // absence. Recorded on the plan so the domain reports it.
                if (context.idsComplete?.(file.scope.from) === false) {
                    incompleteParent = file.scope.from;
                }
                break;
        }

        const trim = this.resolveTrim(context, file);

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
            ...(incompleteParent ? { errorCode: 'parent_ids_incomplete' } : {}),
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
