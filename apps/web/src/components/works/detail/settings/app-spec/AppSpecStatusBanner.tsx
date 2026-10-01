'use client';

import { useTranslations } from 'next-intl';
import {
    AlertCircle,
    AlertTriangle,
    CheckCircle2,
    HelpCircle,
    Loader2,
    XCircle,
    type LucideIcon,
} from 'lucide-react';
import type { WorkAppSpecStateDto } from '@ever-works/contracts';
import { formatUpstreamAge } from '@/components/works/app/UpstreamDivergenceBadge';

/**
 * APW-03 T17 — the App spec status banner (spec §6.2, `spec.md:593-603`;
 * FR-67, `spec.md:381-383`; plan §5.2, `plan.md:618`).
 *
 * ## The seven states of §6.2, and the one input that picks them
 *
 * §6.2 fixes **six** states plus **checking**, and the split of `invalid` into
 * two is what makes six: *valid*, *valid with warnings*, *invalid while running
 * the last valid spec*, *invalid with nothing effective*, *missing*,
 * *unreadable* — and *checking*. {@link appSpecBannerState} is the whole
 * decision, as one pure function so it can be asserted directly:
 *
 * | input                                                | state              |
 * | ---------------------------------------------------- | ------------------ |
 * | `evaluationPending` (or the caller's optimistic flag) | `checking`         |
 * | `validationStatus: valid`                             | `valid`            |
 * | `validationStatus: valid_with_warnings`               | `valid_with_warnings` |
 * | `validationStatus: invalid` **and** an effective commit | `invalid_running` |
 * | `validationStatus: invalid` and no effective commit    | `invalid_nothing`  |
 * | `validationStatus: missing`                           | `missing`          |
 * | `validationStatus: unreadable`                        | `unreadable`       |
 *
 * **`evaluationPending` wins over the stored verdict, and that is the spec's
 * own state machine**: `spec.md:492-497` puts an `evaluating` step *before* every
 * verdict, and §5.3 (`plan.md:633`) says the banner changes *when the poll
 * returns* — so while an evaluation is in flight the banner says so and the
 * problems list below keeps showing the last reading. Nothing is hidden: the
 * problems of the previous head stay on screen, and the `unreadable` /
 * `missing` bodies both tell the member what happens next.
 *
 * ## The copy is §6.2's, one leaf per state
 *
 * Every sentence comes from `dashboard.workDetail.settings.appSpec`, the
 * namespace plan §8:746-772 allocates for this surface (T18 lands the leaves in
 * the 21 locale files; this component reads them by name). `Checked {ago}` reuses
 * APW-02's `formatUpstreamAge` — the app has exactly one relative-time formatter
 * and a second copy of it would drift (see that function's own seam note).
 *
 * ## Keyboard, and who may press Re-check
 *
 * §6.4 (`spec.md:641`) gives the banner the `R` shortcut **while it is focused**,
 * so the banner is focusable and handles the key itself — except while a text
 * field has focus, where `R` is a letter the member is typing. The button is
 * rendered **only when the host passes `onRecheck`**: plan §4.1:548 makes
 * `{ source: 'branch' }` an **edit** of the Work's spec state, so a viewer gets
 * no control at all rather than one the API would refuse (ACC-03-41).
 *
 * ## The two recovery actions of the missing state
 *
 * §6.2's missing row names `Browse Blueprints` and `Run the App Provisioner`.
 * Neither is this task's surface: the Blueprint card (plan §5.2:621, T31) is the
 * slot *below* this banner, and the App Provisioner belongs to APW-06. So
 * `Browse Blueprints` is an anchor to that slot's own id
 * ({@link APP_SPEC_BLUEPRINT_SLOT_ID}) — a real destination on this page that
 * T31 fills — and `Run the App Provisioner` is rendered only when the host
 * passes `onRunProvisioner`, which today nothing does: APW-03 exposes no
 * provisioner trigger and inventing one here would be a control that cannot
 * work. Both facts are reported as gaps rather than papered over.
 */

/** The seven states §6.2 gives copy for, in banner order. */
export type AppSpecBannerState =
    | 'checking'
    | 'valid'
    | 'valid_with_warnings'
    | 'invalid_running'
    | 'invalid_nothing'
    | 'missing'
    | 'unreadable';

/**
 * The translator this component reads with, so the renderer maps below can be
 * declared outside a render body without widening the key type.
 */
type AppSpecTranslator = ReturnType<
    typeof useTranslations<'dashboard.workDetail.settings.appSpec'>
>;

/**
 * The Blueprint slot's id (plan §5.2:621, filled by T31). The page renders the
 * slot with this id; the missing state's **Browse Blueprints** anchor points at
 * it, so the two cannot drift apart.
 */
export const APP_SPEC_BLUEPRINT_SLOT_ID = 'app-spec-blueprint-slot';

/** The banner's title leaf per state (plan §8:749-759). */
export const APP_SPEC_BANNER_TITLE_KEYS = {
    checking: 'statusChecking',
    valid: 'statusValid',
    valid_with_warnings: 'statusWarnings',
    invalid_running: 'statusInvalid',
    invalid_nothing: 'statusInvalid',
    missing: 'statusMissing',
    unreadable: 'statusUnreadable',
} as const satisfies Record<AppSpecBannerState, string>;

/** The icon per state — text carries the meaning, the icon reinforces it (FR-74). */
const APP_SPEC_BANNER_ICONS = {
    checking: Loader2,
    valid: CheckCircle2,
    valid_with_warnings: AlertTriangle,
    invalid_running: AlertCircle,
    invalid_nothing: AlertCircle,
    missing: HelpCircle,
    unreadable: XCircle,
} as const satisfies Record<AppSpecBannerState, LucideIcon>;

/** `text-*` and border tone per state — never the only signal (FR-74). */
const APP_SPEC_BANNER_TONES = {
    checking: 'text-text-secondary dark:text-text-secondary-dark',
    valid: 'text-green-600 dark:text-green-400',
    valid_with_warnings: 'text-amber-600 dark:text-amber-400',
    invalid_running: 'text-red-600 dark:text-red-400',
    invalid_nothing: 'text-red-600 dark:text-red-400',
    missing: 'text-text-secondary dark:text-text-secondary-dark',
    unreadable: 'text-amber-600 dark:text-amber-400',
} as const satisfies Record<AppSpecBannerState, string>;

/**
 * The title, rendered per state.
 *
 * A **renderer map** rather than `t(KEY[bannerState], values)` because
 * `apps/web/src/global.ts:4-9` types every key against `messages/en.json`: a
 * dynamically indexed key widens to `string` and the ICU values to the union of
 * every leaf's parameters, so the type gate rejects both. Each entry below calls
 * `t` with the literal key and exactly the values that leaf declares, which is
 * also what keeps `{sha}` from silently disappearing from a sentence.
 */
const APP_SPEC_BANNER_TITLES = {
    checking: (t) => t(APP_SPEC_BANNER_TITLE_KEYS.checking),
    valid: (t) => t(APP_SPEC_BANNER_TITLE_KEYS.valid),
    valid_with_warnings: (t, state) =>
        t(APP_SPEC_BANNER_TITLE_KEYS.valid_with_warnings, { count: state.warningCount }),
    invalid_running: (t, state) =>
        t(APP_SPEC_BANNER_TITLE_KEYS.invalid_running, {
            branch: state.trackedBranch,
            count: state.errorCount,
        }),
    invalid_nothing: (t, state) =>
        t(APP_SPEC_BANNER_TITLE_KEYS.invalid_nothing, {
            branch: state.trackedBranch,
            count: state.errorCount,
        }),
    missing: (t) => t(APP_SPEC_BANNER_TITLE_KEYS.missing),
    unreadable: (t, state) =>
        t(APP_SPEC_BANNER_TITLE_KEYS.unreadable, { branch: state.trackedBranch }),
} satisfies Record<
    AppSpecBannerState,
    (t: AppSpecTranslator, state: WorkAppSpecStateDto) => string
>;

/**
 * The state row plus whether an evaluation is in flight → the one banner state
 * of §6.2 (see the table in this module's header).
 *
 * `checking` arrives as an argument rather than being read off the row so the
 * caller can also say "I have just pressed Re-check and the first poll has not
 * come back yet" (plan §5.3:633) without inventing a second state row.
 *
 * `validationStatus` is a closed union (`APP_SPEC_VALIDATION_STATUSES`), so the
 * final `default` is unreachable; it exists so a status added to the contract
 * later renders **something** instead of crashing, and it is deliberately the
 * `missing` copy: an unknown verdict is only honest as "we have no reading",
 * never as "valid".
 */
export function appSpecBannerState(
    state: WorkAppSpecStateDto,
    checking: boolean,
): AppSpecBannerState {
    if (checking) {
        return 'checking';
    }

    switch (state.validationStatus) {
        case 'valid':
            return 'valid';
        case 'valid_with_warnings':
            return 'valid_with_warnings';
        case 'invalid':
            // FR-20: only a zero-error evaluation becomes effective, so an
            // effective commit is exactly "there is still a last valid spec".
            return state.effectiveCommitSha ? 'invalid_running' : 'invalid_nothing';
        case 'unreadable':
            return 'unreadable';
        case 'missing':
        default:
            return 'missing';
    }
}

/** The first seven characters, as §6.2's copy shows them (`4f1c2ab`). */
export function shortCommitSha(sha: string | null): string | null {
    return sha ? sha.slice(0, 7) : null;
}

export interface AppSpecStatusBannerProps {
    /** The App spec state this page was rendered from. */
    state: WorkAppSpecStateDto;
    /**
     * `true` while an evaluation is queued or running — the banner's *checking*
     * state. The row's own `evaluationPending` means the same thing and is ORed
     * with this flag, so the banner cannot show a settled verdict for a state
     * that says an evaluation is on its way, and a host that has only just
     * pressed Re-check can say so before the first poll returns.
     */
    checking: boolean;
    /** `true` while the Re-check press itself is still in flight — the button's *Checking…*. */
    recheckBusy: boolean;
    /** Absent ⇒ no Re-check control at all (a viewer, ACC-03-41). */
    onRecheck?: () => void;
    /**
     * Runs the App Provisioner for the missing state. Only APW-06 can own this
     * trigger, so the control is rendered when — and only when — a host supplies
     * it.
     */
    onRunProvisioner?: () => void;
    /**
     * The instant `Checked {ago}` is measured against, **passed in**: the banner
     * reads no clock of its own, so a spec pins "Checked 2 minutes ago" instead
     * of the wall clock (the pattern `UpstreamDivergenceBadge` fixes for the
     * same sentence).
     */
    now: number;
}

export function AppSpecStatusBanner({
    state,
    checking,
    recheckBusy,
    onRecheck,
    onRunProvisioner,
    now,
}: AppSpecStatusBannerProps) {
    const t = useTranslations('dashboard.workDetail.settings.appSpec');

    const bannerState = appSpecBannerState(state, checking || state.evaluationPending);
    const Icon = APP_SPEC_BANNER_ICONS[bannerState];
    const title = APP_SPEC_BANNER_TITLES[bannerState](t, state);

    // FR-67's "evaluated commit and Checked {ago}": the head the verdict was
    // read at, and when. Both are absent before the first evaluation, and the
    // three states that have nothing to date (checking, missing, unreadable)
    // deliberately show no line at all rather than a stale one.
    const showsMeta =
        (bannerState === 'valid' ||
            bannerState === 'valid_with_warnings' ||
            bannerState === 'invalid_running' ||
            bannerState === 'invalid_nothing') &&
        state.lastEvaluatedAt !== null &&
        state.headCommitSha !== null;

    const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
        if (!onRecheck || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
            return;
        }
        if (event.key.toLowerCase() !== 'r') {
            return;
        }

        const target = event.target as HTMLElement | null;
        const tag = target?.tagName;
        if (
            target?.isContentEditable ||
            tag === 'INPUT' ||
            tag === 'TEXTAREA' ||
            tag === 'SELECT'
        ) {
            // `R` is a letter the member is typing, not a shortcut.
            return;
        }

        event.preventDefault();
        onRecheck();
    };

    return (
        <section
            data-testid="app-spec-status-banner"
            data-state={bannerState}
            role="status"
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="rounded-lg border border-card-border bg-card px-5 py-4 outline-none focus:ring-2 focus:ring-primary/40 dark:border-border-secondary-dark dark:bg-transparent"
        >
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                    <Icon
                        aria-hidden="true"
                        data-testid="app-spec-status-icon"
                        className={`mt-0.5 h-5 w-5 shrink-0 ${APP_SPEC_BANNER_TONES[bannerState]} ${
                            bannerState === 'checking' ? 'animate-spin' : ''
                        }`}
                    />
                    <div className="space-y-1">
                        <p
                            data-testid="app-spec-status-title"
                            className={`text-sm font-semibold ${APP_SPEC_BANNER_TONES[bannerState]}`}
                        >
                            {title}
                        </p>

                        {bannerState === 'invalid_running' && state.effectiveCommitSha && (
                            <p
                                data-testid="app-spec-status-body"
                                className="text-sm text-text-secondary dark:text-text-secondary-dark"
                            >
                                {t('statusInvalidRunning', {
                                    sha: shortCommitSha(state.effectiveCommitSha) ?? '',
                                })}
                            </p>
                        )}

                        {bannerState === 'invalid_nothing' && (
                            <p
                                data-testid="app-spec-status-body"
                                className="text-sm text-text-secondary dark:text-text-secondary-dark"
                            >
                                {t('statusInvalidNothing')}
                            </p>
                        )}

                        {bannerState === 'unreadable' && (
                            <p
                                data-testid="app-spec-status-body"
                                className="text-sm text-text-secondary dark:text-text-secondary-dark"
                            >
                                {t('statusUnreadableBody')}
                            </p>
                        )}

                        {bannerState === 'missing' && (
                            <>
                                <p
                                    data-testid="app-spec-status-body"
                                    className="text-sm text-text-secondary dark:text-text-secondary-dark"
                                >
                                    {t('statusMissingBody')}
                                </p>
                                <p className="flex flex-wrap items-center gap-3 text-sm">
                                    <a
                                        data-testid="app-spec-browse-blueprints"
                                        href={`#${APP_SPEC_BLUEPRINT_SLOT_ID}`}
                                        className="font-medium text-primary underline hover:no-underline dark:text-gray-100"
                                    >
                                        {t('browseBlueprints')}
                                    </a>
                                    {onRunProvisioner && (
                                        <button
                                            type="button"
                                            data-testid="app-spec-run-provisioner"
                                            onClick={onRunProvisioner}
                                            className="font-medium text-primary underline hover:no-underline dark:text-gray-100"
                                        >
                                            {t('runProvisioner')}
                                        </button>
                                    )}
                                </p>
                            </>
                        )}

                        {showsMeta && (
                            <p
                                data-testid="app-spec-status-meta"
                                className="text-xs text-text-muted dark:text-text-muted-dark"
                            >
                                {t('statusMeta', {
                                    sha: shortCommitSha(state.headCommitSha) ?? '',
                                    ago: formatUpstreamAge(state.lastEvaluatedAt as string, now),
                                })}
                            </p>
                        )}
                    </div>
                </div>

                {onRecheck && (
                    <button
                        type="button"
                        data-testid="app-spec-recheck"
                        onClick={onRecheck}
                        disabled={recheckBusy}
                        className="rounded-md border border-card-border px-3 py-1.5 text-sm font-medium hover:bg-surface-hover disabled:opacity-60 dark:border-border-secondary-dark dark:hover:bg-surface-hover-dark"
                    >
                        {recheckBusy ? t('recheckBusy') : t('recheck')}
                    </button>
                )}
            </div>
        </section>
    );
}
