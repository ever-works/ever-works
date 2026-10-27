import { Logger } from '@nestjs/common';
import { isAppWorkKind } from '@ever-works/contracts';

import { NotificationCategory, NotificationType } from '../entities/notification.types';
import type {
    AppDeletionObjectRef,
    AppWorkDeletionCompletion,
    AppWorkDeletionCompletionReport,
} from './app-runtime-deletion.service';

/** The one read this completion makes of the Work. */
export interface AppWorkDeletionCompletionWorks {
    findById(workId: string): Promise<{
        id: string;
        kind?: string | null;
        userId?: string | null;
        name?: string | null;
        slug?: string | null;
    } | null>;
}

/** The one read this completion makes of the runtime-state row (`WORK_APP_RUNTIME_STATES`). */
export interface AppWorkDeletionClaimReader {
    getOrCreate(workId: string): Promise<{
        deletionRequestedAt?: Date | string | number | null;
        deletionRequestedByUserId?: string | null;
    } | null>;
}

/** The owner notification writer (`NotificationService.create`, narrowed). */
export interface AppWorkDeletionNotifier {
    create(dto: {
        userId: string;
        type: NotificationType;
        category: NotificationCategory;
        title: string;
        message: string;
        isPersistent?: boolean;
        deduplicationKey?: string;
        metadata?: Record<string, unknown>;
    }): Promise<unknown>;
}

/**
 * APW-01's `WorkLifecycleService.completeAppWorkDeletion`, resolved LAZILY by the caller (§9.8:
 * never a constructor edge — `WorkLifecycleService` injects the deletion port, which is this
 * cycle). `undefined` ⇔ APW-01 is not in the container.
 */
export type AppWorkDeletionLifecycleResolver = () =>
    | { completeAppWorkDeletion(workId: string): Promise<boolean> }
    | undefined;

/** Why a completion was refused — reason codes only. */
export type AppWorkDeletionCompletionRefusal =
    | 'not_an_app_work'
    | 'not_deleting'
    | 'runtime_state_unreadable'
    | 'lifecycle_unavailable';

/** The completion's typed refusal; the deletion service turns a throw into `completed: false`. */
export class AppWorkDeletionCompletionRefusedError extends Error {
    constructor(readonly code: AppWorkDeletionCompletionRefusal) {
        super(`The App Work deletion was not completed: ${code}`);
        this.name = 'AppWorkDeletionCompletionRefusedError';
    }
}

/**
 * APW-06 T58 / plan §9.8 (lane aw-safety, 2026-10-26) — **the API's `APP_WORK_DELETION_COMPLETION`**:
 * the one place a finished App runtime removal turns into APW-01's
 * `WorkLifecycleService.completeAppWorkDeletion(workId)`, which deletes the Work row.
 *
 * It is reached from the isolated worker: the `delete-app-work` op's `finishDeletion` dials the
 * API's `AppRuntimeDeletionService.finishDeletion` over the internal channel (`remoteMap`), and
 * that method calls this binding. Because the hop ends in a destructive call, the binding is a
 * guard first:
 *
 * 1. **A Work that is already gone** is a no-op (idempotent — a retried hop cannot fail).
 * 2. **Only an App Work** — any other kind is refused `not_an_app_work`.
 * 3. **Only a Work whose runtime-state row records a deletion** (`deletionRequestedAt`, the claim
 *    §9.7:1490 takes when the OWNER confirms the delete). A row without one is refused
 *    `not_deleting`, and a row that cannot be read `runtime_state_unreadable`: whatever calls this
 *    hop, it cannot delete a Work nobody asked to delete.
 * 4. **The owner is told** what was removed and what may remain on which target (FR-40a: "the
 *    member MUST be told what may remain on which target") — a notification, because it outlives
 *    the Work row, the Deploy tab and the Activity link that go with it.
 * 5. Only then APW-01's completion, through the lazy resolver.
 *
 * Every refusal THROWS; `AppRuntimeDeletionService.finishDeletion` catches and answers
 * `completed: false`, so the Work row is kept and the worker reports the removal as unfinished.
 *
 * A plain class: the API's `AppRuntimePortsModule` builds it with a factory (the collaborators
 * plus the `ModuleRef` lookup of `WorkLifecycleService`), so this package never imports the
 * lifecycle service and closes no import cycle.
 */
export class AppWorkDeletionCompletionService implements AppWorkDeletionCompletion {
    private readonly logger = new Logger(AppWorkDeletionCompletionService.name);

    constructor(
        private readonly works?: AppWorkDeletionCompletionWorks,
        private readonly states?: AppWorkDeletionClaimReader,
        private readonly notifications?: AppWorkDeletionNotifier,
        private readonly lifecycle?: AppWorkDeletionLifecycleResolver,
    ) {}

    async completeAppWorkDeletion(
        workId: string,
        report?: AppWorkDeletionCompletionReport,
    ): Promise<boolean> {
        const id = typeof workId === 'string' ? workId.trim() : '';
        if (!id || !this.works) {
            throw new AppWorkDeletionCompletionRefusedError('runtime_state_unreadable');
        }

        const work = await this.works.findById(id);
        if (!work) {
            // Already deleted — a replayed hop. Nothing to do and nothing to tell.
            return false;
        }
        if (!isAppWorkKind(work.kind)) {
            throw new AppWorkDeletionCompletionRefusedError('not_an_app_work');
        }

        const claim = await this.readClaim(id);
        if (claim.claimed !== true) {
            // Read through a cast: this package compiles without `strictNullChecks`, which turns
            // off discriminated-union narrowing on `claim.claimed`.
            const code = (claim as { code: 'not_deleting' | 'runtime_state_unreadable' }).code;
            this.logger.warn(
                `Refused to complete the deletion of work ${id}: ${code}. The row is kept.`,
            );
            throw new AppWorkDeletionCompletionRefusedError(code);
        }

        const lifecycle = this.resolveLifecycle();
        if (!lifecycle) {
            throw new AppWorkDeletionCompletionRefusedError('lifecycle_unavailable');
        }

        await this.tellOwner({
            userId:
                (claim as { requestedByUserId: string | null }).requestedByUserId ||
                String(work.userId ?? ''),
            workId: id,
            workName: String(work.name || work.slug || 'Your App'),
            report,
        });

        return lifecycle.completeAppWorkDeletion(id);
    }

    private resolveLifecycle(): ReturnType<AppWorkDeletionLifecycleResolver> {
        try {
            const lifecycle = this.lifecycle?.();
            return lifecycle && typeof lifecycle.completeAppWorkDeletion === 'function'
                ? lifecycle
                : undefined;
        } catch (error) {
            this.logger.warn(
                `APW-01's completion could not be resolved: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return undefined;
        }
    }

    /** The claim, or the reason there is none. A read that fails is never taken as a claim. */
    private async readClaim(
        workId: string,
    ): Promise<
        | { claimed: true; requestedByUserId: string | null }
        | { claimed: false; code: 'not_deleting' | 'runtime_state_unreadable' }
    > {
        if (!this.states || typeof this.states.getOrCreate !== 'function') {
            return { claimed: false, code: 'runtime_state_unreadable' };
        }
        try {
            const row = await this.states.getOrCreate(workId);
            if (!row || !isSet(row.deletionRequestedAt)) {
                return { claimed: false, code: 'not_deleting' };
            }
            const by =
                typeof row.deletionRequestedByUserId === 'string'
                    ? row.deletionRequestedByUserId
                    : '';
            return { claimed: true, requestedByUserId: by || null };
        } catch (error) {
            this.logger.warn(
                `The runtime state of work ${workId} could not be read: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return { claimed: false, code: 'runtime_state_unreadable' };
        }
    }

    /**
     * The owner's notification — kinds, names and the target only (never a host, an address, a
     * value or a token: the report was already reduced to `{ kind, name }` refs). A failure here
     * never blocks the completion: the Activity row is the second record.
     */
    private async tellOwner(input: {
        userId: string;
        workId: string;
        workName: string;
        report?: AppWorkDeletionCompletionReport;
    }): Promise<void> {
        if (!this.notifications?.create || !input.userId) {
            return;
        }
        const mayRemain = refsOf(input.report?.mayRemain);
        const target = targetLabel(input.report?.target);
        const name = input.workName.slice(0, 120);

        try {
            await this.notifications.create({
                userId: input.userId,
                type: mayRemain.length > 0 ? NotificationType.WARNING : NotificationType.SUCCESS,
                category: NotificationCategory.SYSTEM,
                title:
                    mayRemain.length > 0
                        ? `App Work deleted — some resources may remain on ${target}`
                        : 'App Work deleted',
                message:
                    mayRemain.length > 0
                        ? `"${name}" was deleted, but these could not be removed from ${target} and may ` +
                          `still be running there: ${mayRemain.join(', ')}. Remove them on ${target} ` +
                          'yourself if they are still there.'
                        : `"${name}" was deleted and its App was removed from ${target}.`,
                isPersistent: mayRemain.length > 0,
                deduplicationKey: `app-work-deleted:${input.workId}`,
                metadata: {
                    eventKey:
                        mayRemain.length > 0 ? 'app_work_deleted_may_remain' : 'app_work_deleted',
                    workId: input.workId,
                    target: input.report?.target ?? null,
                    code: input.report?.code ?? null,
                    mayRemain,
                },
            });
        } catch (error) {
            this.logger.warn(
                `The deletion notification for work ${input.workId} could not be written: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}

function refsOf(refs?: readonly AppDeletionObjectRef[]): string[] {
    const out: string[] = [];
    for (const ref of refs ?? []) {
        if (typeof ref?.kind === 'string' && typeof ref?.name === 'string') {
            out.push(`${ref.kind.slice(0, 80)} ${ref.name.slice(0, 120)}`);
        }
        if (out.length >= 20) break;
    }
    return out;
}

function targetLabel(target?: string): string {
    if (target === 'ever-works-apps') return 'Ever Works Apps';
    if (target === 'your-cluster') return 'your cluster';
    return 'its deploy target';
}

function isSet(value: unknown): boolean {
    if (value === null || value === undefined || value === '') return false;
    if (value instanceof Date) return Number.isFinite(value.getTime());
    return true;
}
