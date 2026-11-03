import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { isAppWorkKind, type AppSpec } from '@ever-works/contracts';

import { NotificationRepository } from '../database/repositories/notification.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import type { Work } from '../entities/work.entity';
import { NotificationCategory, NotificationType } from '../entities/notification.types';
import { AppSpecAppliedEvent } from '../events/app-spec-applied.event';
import { NotificationService } from '../notifications/notification.service';
import {
    AppWorkIsolationService,
    type AppWorkIsolationColumn,
    type AppWorkSourceBranchSource,
} from './app-work-isolation.service';

/**
 * APW-08 T11 — **keep the Work in step with the App spec; force isolation** (plan §2.6).
 *
 * On APW-03's `app.spec.applied` (emitted once per effective-hash change, FR-21), for an App
 * Work only:
 *
 * 1. **Isolation (FR-9, APW08-G07).** `taskIsolation = 'worktree'`,
 *    `taskIsolationBaseBranch = <source branch>` and `taskIsolationTargetRepo = 'website'`. The
 *    branch is resolved by {@link AppWorkIsolationService.resolveSourceBranch} — the applied
 *    spec's `source.branch` at `event.commitSha`, else APW-03's tracked branch, else the Work
 *    Repository's default — so a spec that omits `source.branch` never leaves the column null
 *    (ACC-08-43). T50's backfill resolves through the same method; neither owns a copy.
 * 2. **Checks switched on (APW08-G02, ACC-08-41).** In the SAME write: `checksPolicy =
 *    'required'` when the spec declares a required check (an owner's own `'warn'` survives), and
 *    `repoDeclaredCommands = { mode: 'allowlist', allow: <the existing list> }`.
 * 3. **The owner is asked once (APW08-G19, FR-14, ACC-08-44 first half).** When the applied
 *    spec's `checks` changed, ONE notification links the owner to the App Checks admission card
 *    in the Work's Quality gates settings. A re-application whose checks did not change notifies
 *    nobody, and a repeated application of the same spec at the same commit is one notification.
 *
 * ## Idempotent
 *
 * The write is a diff of what the row already says ({@link AppWorkIsolationService}): a second
 * identical event writes nothing. The notification is deduplicated on the applied spec hash and
 * commit (`appChecksNotificationKey`) through the notifications' `(userId, deduplicationKey)`
 * unique key — so the row it writes IS the record of "this application's checks were asked
 * about", read back before asking again (dismissed or not), and it survives a restart and a
 * second replica where an in-memory set would not. The commit is part of the key so that a
 * spec which changes its checks and later changes them BACK (the same content hash again) is
 * asked about again: the owner's last answer was about the other list.
 *
 * ## Why "the checks changed" is APW-03's `changedBlocks`
 *
 * `changedBlocks` is APW-03's own diff of the previous effective spec against this one
 * (`app-spec.service.ts` `changedBlocks`, which reports every declared key when there was no
 * previous spec). Re-deriving it here would be a second diff that could disagree with the one
 * APW-05 already rebuilds on.
 *
 * ## Never throws into the event fan-out
 *
 * Several listeners share this event (APW-05's builds, APW-06's redeploy, APW-07's env,
 * APW-02's upstream schedule). A failure here is logged and reported as `failed`, and the next
 * application — or T50's backfill — writes the columns again.
 */

/** The fragment the App Checks admission card is anchored at in the Work's settings. */
export const APP_CHECKS_ADMISSION_ANCHOR = 'app-checks';

/**
 * Where the checks-change notification sends the owner: the Work's settings page, at the App
 * Checks admission card (T14). The card is mounted in the Quality gates settings for `app` only
 * (lane L9); the link is unprefixed, like every other notification's (`/works/<id>`, `/tasks/<id>`)
 * — the web prefixes the locale.
 */
export function appChecksAdmissionUrl(workId: string): string {
    return `/works/${encodeURIComponent(workId)}/settings#${APP_CHECKS_ADMISSION_ANCHOR}`;
}

/** The `notifications.deduplicationKey` of one checks-change notice (the column is `varchar(100)`). */
export function appChecksNotificationKey(
    workId: string,
    specHash: string,
    commitSha: string,
): string {
    return `app-checks:${workId}:${specHash.slice(0, 16)}:${commitSha.slice(0, 12)}`;
}

/** How many check names the notice and its metadata carry. */
const NOTIFIED_CHECK_NAMES_MAX = 20;

/** What one `app.spec.applied` did here — never a silent no-op. */
export interface AppWorkSpecAppliedOutcome {
    readonly workId: string;
    /**
     * `synced` (the columns were written) · `unchanged` (they already said this) ·
     * `invalid_payload` · `no_work` · `not_app` · `unbound` · `failed`.
     */
    readonly reason: string;
    /** The columns written, sorted; `[]` when nothing was. */
    readonly written: readonly AppWorkIsolationColumn[];
    /** The resolved source branch, or `null`. */
    readonly branch: string | null;
    readonly branchSource: AppWorkSourceBranchSource | null;
    /** Why the branch is unresolved (`repository_unreadable`, …), or `null`. */
    readonly branchReason: string | null;
    /** `true` when a checks-change notification was created by THIS event. */
    readonly notified: boolean;
    /**
     * `notified` · `checks_unchanged` · `no_checks` · `spec_unreadable` · `no_owner` ·
     * `already_notified` · `unbound` · `failed` · `skipped`.
     */
    readonly notifyReason: string;
}

@Injectable()
export class AppWorkSpecAppliedListener {
    private readonly logger = new Logger(AppWorkSpecAppliedListener.name);

    constructor(
        /** The App Work row — required. */
        private readonly works: WorkRepository,
        /**
         * The shared resolver + ownership-scoped write (also T50's). `@Optional()` so a reduced
         * graph composes; absent, the listener answers `unbound` and writes nothing.
         */
        @Optional() private readonly isolation?: AppWorkIsolationService,
        /** The in-app store the owner is asked through. Absent, nobody is notified (`unbound`). */
        @Optional() private readonly notifications?: NotificationService,
        /**
         * The notice rows themselves, read for ONE thing: whether this application was already
         * asked about (`findByDeduplicationKey`), dismissed or not. `NotificationService.create`
         * re-arms a dismissed key by design ("a user who dismissed an alert can see a fresh one");
         * FR-14's promise is "asked once", so the listener checks first. Appended LAST and
         * `@Optional()`: absent, `create`'s own dedup is the only guard.
         */
        @Optional() private readonly notificationRows?: NotificationRepository,
    ) {}

    @OnEvent(AppSpecAppliedEvent.EVENT_NAME, { async: true })
    async onSpecApplied(event: AppSpecAppliedEvent): Promise<AppWorkSpecAppliedOutcome> {
        const workId = text(event?.workId);
        try {
            return await this.handle(event, workId);
        } catch (error) {
            this.logger.warn(
                `APW-08: keeping App Work ${workId || '<none>'} in step with its App spec failed (${errorText(error)}).`,
            );
            return outcome(workId, 'failed');
        }
    }

    private async handle(
        event: AppSpecAppliedEvent,
        workId: string,
    ): Promise<AppWorkSpecAppliedOutcome> {
        const commitSha = text(event?.commitSha);
        if (!workId || !commitSha) return outcome(workId, 'invalid_payload');
        if (!this.isolation) return outcome(workId, 'unbound');

        const work = await this.works.findById(workId);
        if (!work) return outcome(workId, 'no_work');
        // 🛑 `app` only. No other kind is read further, let alone written (plan §2.3: "This
        // touches `app` only; every other kind keeps `'off'`").
        if (!isAppWorkKind(work.kind)) return outcome(workId, 'not_app');

        const resolved = await this.isolation.resolveSourceBranch(work, { commitSha });
        const patch = {
            ...this.isolation.isolationPatch(work, resolved.branch),
            ...this.isolation.checksPatch(work, resolved.spec),
        };
        const written = (await this.isolation.apply(work, patch))
            ? AppWorkIsolationService.columnsOf(patch)
            : [];
        if (written.length > 0) {
            this.logger.log(
                `APW-08: App Work ${workId} kept in step with its App spec at ${commitSha.slice(0, 12)} (${written.join(', ')}).`,
            );
        }
        if (!resolved.branch) {
            this.logger.warn(
                `APW-08: App Work ${workId} has no resolvable source branch (${resolved.reason}); its Task base branch was left as it is.`,
            );
        }

        const notice = await this.notifyChecksChanged(work, event, commitSha, resolved.spec);
        return {
            workId,
            reason: written.length > 0 ? 'synced' : 'unchanged',
            written,
            branch: resolved.branch,
            branchSource: resolved.source,
            branchReason: resolved.reason,
            notified: notice.notified,
            notifyReason: notice.reason,
        };
    }

    /**
     * APW08-G19 / FR-14 — ask the owner, once, to review the checks the App spec now declares.
     * Never throws: a notice that could not be written is logged, and the columns stand.
     */
    private async notifyChecksChanged(
        work: Work,
        event: AppSpecAppliedEvent,
        commitSha: string,
        spec: AppSpec | null,
    ): Promise<{ notified: boolean; reason: string }> {
        const changed = Array.isArray(event?.changedBlocks) ? event.changedBlocks : [];
        if (!changed.includes('checks')) return { notified: false, reason: 'checks_unchanged' };
        if (!spec) return { notified: false, reason: 'spec_unreadable' };
        const checks = Array.isArray(spec.checks) ? spec.checks : [];
        // A list that went EMPTY leaves nothing to admit, so nothing to ask.
        if (checks.length === 0) return { notified: false, reason: 'no_checks' };
        if (!work.userId) return { notified: false, reason: 'no_owner' };
        if (!this.notifications) {
            this.logger.warn(
                `APW-08: no NotificationService is bound, so the owner of App Work ${work.id} was not asked to review its changed checks.`,
            );
            return { notified: false, reason: 'unbound' };
        }

        const specHash = text(event?.specHash) || commitSha;
        const names = checks
            .map((check) => label(check?.name))
            .filter((name) => name.length > 0)
            .slice(0, NOTIFIED_CHECK_NAMES_MAX);
        const workName = label(work.name) || 'your app';
        const count = checks.length;
        const deduplicationKey = appChecksNotificationKey(work.id, specHash, commitSha);
        try {
            if (
                await this.notificationRows?.findByDeduplicationKey(work.userId, deduplicationKey)
            ) {
                return { notified: false, reason: 'already_notified' };
            }
            await this.notifications.create({
                userId: work.userId,
                type: NotificationType.WARNING,
                category: NotificationCategory.TASK,
                title: `Review the checks of ${workName}`,
                message:
                    `The App spec of ${workName} changed its checks (${count} ${count === 1 ? 'check' : 'checks'}` +
                    `${names.length > 0 ? `: ${names.join(', ')}` : ''}). Each one runs on your machines only ` +
                    'after you admit it, and until then the quality gate is never green.',
                actionUrl: appChecksAdmissionUrl(work.id),
                actionLabel: 'Review checks',
                metadata: {
                    // APW-08 plan §5.2 — the card renders its own translation of the same ask.
                    code: 'appRules.reviewChecks',
                    event: 'app_checks_changed',
                    workId: work.id,
                    specHash,
                    commitSha,
                    checkCount: count,
                    checks: names,
                },
                // The `(userId, deduplicationKey)` unique key: two replicas racing past the read
                // above still write one row (`create` re-reads on the constraint violation).
                deduplicationKey,
                isPersistent: false,
            });
            return { notified: true, reason: 'notified' };
        } catch (error) {
            this.logger.warn(
                `APW-08: asking the owner of App Work ${work.id} to review its changed checks failed (${errorText(error)}).`,
            );
            return { notified: false, reason: 'failed' };
        }
    }
}

function outcome(workId: string, reason: string): AppWorkSpecAppliedOutcome {
    return {
        workId,
        reason,
        written: [],
        branch: null,
        branchSource: null,
        branchReason: null,
        notified: false,
        notifyReason: 'skipped',
    };
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * A name fit for a notification's text: control characters and angle brackets removed, one line,
 * at most 80 characters. Check names come from the member's repository (`.works/works.yml`).
 */
function label(value: unknown): string {
    if (typeof value !== 'string') return '';
    return (
        value
            // eslint-disable-next-line no-control-regex
            .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80)
    );
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
