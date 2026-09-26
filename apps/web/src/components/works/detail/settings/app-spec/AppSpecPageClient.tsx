'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { browserApiFetch } from '@/lib/api/browser-api';
import { recheckAppSpecAction } from '@/app/actions/dashboard/app-spec';
import type { WorkAppSpecStateDto } from '@ever-works/contracts';
import { useWorkPermissions } from '../../WorkDetailContext';
import { APP_SPEC_BLUEPRINT_SLOT_ID, AppSpecStatusBanner } from './AppSpecStatusBanner';
import { AppSpecProblemsList } from './AppSpecProblemsList';
import { AppSpecSections } from './AppSpecSections';

/**
 * APW-03 T17 — the App spec tab's layout and its poll (plan §5.2,
 * `plan.md:617`; plan §5.3, `plan.md:629-635`; spec §6.2, `spec.md:567-607`).
 *
 * ```
 *  ┌──────────────────────────────────────────────────────────────┐
 *  │ AppSpecStatusBanner        (six states + checking, FR-67)     │
 *  ├──────────────────────────────────────────────────────────────┤
 *  │ AppSpecProblemsList        (sort, filter, open at the line)   │
 *  ├──────────────────────────────────────────────────────────────┤
 *  │ AppBlueprintCard           ← T31's slot, deliberately empty   │
 *  │ AppLicenseCard             ← T45's slot, deliberately empty   │
 *  ├──────────────────────────────────────────────────────────────┤
 *  │ AppSpecSections            (collapsible, default-marked)      │
 *  └──────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## The first paint is the server's, and the poll only ever replaces it
 *
 * The page reads `GET /api/works/:id/app-spec` and hands the whole answer in as
 * `initialState`, problems included, so the banner never flashes a different
 * state (plan §5.3:631-632). From there the client owns exactly one thing: while
 * `evaluationPending` — the API's own projection of `evaluatedSeq <
 * requestedSeq` — it re-reads that state every {@link APP_SPEC_POLL_INTERVAL_MS}
 * for at most {@link APP_SPEC_POLL_MAX} ticks, and stops the moment an answer
 * comes back not pending (or on unmount). A failed read keeps the last known
 * state and the next tick retries; a read that never stops being pending stops
 * at the cap rather than polling forever.
 *
 * ## Why the poll is a **route handler** and not a second server action
 *
 * The read is `GET /api/works/:id/app-spec`, which is `server-only`, so the
 * browser cannot call it directly and T15 exposed no client-callable read. The
 * BFF handler `apps/web/src/app/api/works/[id]/app-spec/route.ts` is the shape
 * this poll uses — the same one APW-02 T30 gave its own 5-second poll of an App
 * Work surface (`apps/web/src/app/api/works/[id]/upstream/route.ts`), and for the
 * same recorded reason: Next.js queues a server action behind the action already
 * running, and the thing being polled **is** the job the Re-check action just
 * queued. One read, same origin, no rule of its own.
 *
 * ## Re-check is optimistic for the button only
 *
 * `recheckAppSpecAction` answers `202 { evaluationPending: true }` — a claim that
 * the request was **recorded**, not that a verdict changed (ACC-03-13: three
 * presses inside five seconds are one evaluation). So the press marks the state
 * pending, which starts the poll, and the banner changes when the poll returns
 * (plan §5.3:633). Nothing is inferred from a missing field, and a refusal is
 * rendered as the action's own client-safe sentence rather than swallowed.
 */
export const APP_SPEC_POLL_INTERVAL_MS = 5_000;

/** Plan §5.2:617 — "polls … every 5 s while `evaluationPending`, at most 24 polls". */
export const APP_SPEC_POLL_MAX = 24;

export interface AppSpecPageClientProps {
    workId: string;
    /** `GET /api/works/:id/app-spec`, read by the page on the server. */
    initialState: WorkAppSpecStateDto;
}

export function AppSpecPageClient({ workId, initialState }: AppSpecPageClientProps) {
    const permissions = useWorkPermissions();

    const [state, setState] = useState(initialState);
    const [failure, setFailure] = useState<string | null>(null);
    const [recheckStarting, setRecheckStarting] = useState(false);
    const polls = useRef(0);

    // A `revalidatePath` from the action re-renders the page with a fresh
    // answer; the client follows it rather than keeping a stale copy of its own.
    useEffect(() => {
        setState(initialState);
    }, [initialState]);

    const refresh = useCallback(async (): Promise<WorkAppSpecStateDto | null> => {
        try {
            const response = await browserApiFetch(`/api/works/${workId}/app-spec`);
            if (!response.ok) {
                return null;
            }

            const next = (await response.json()) as WorkAppSpecStateDto;
            setState(next);
            return next;
        } catch {
            // Best effort: a failed poll leaves the last known state on screen.
            return null;
        }
    }, [workId]);

    const pending = state.evaluationPending;

    useEffect(() => {
        if (!pending) {
            return;
        }

        polls.current = 0;

        const interval = window.setInterval(async () => {
            if (polls.current >= APP_SPEC_POLL_MAX) {
                window.clearInterval(interval);
                return;
            }

            polls.current += 1;
            const next = await refresh();

            if (next && next.evaluationPending !== true) {
                window.clearInterval(interval);
            }
        }, APP_SPEC_POLL_INTERVAL_MS);

        return () => window.clearInterval(interval);
    }, [pending, refresh]);

    const onRecheck = async () => {
        setFailure(null);
        setRecheckStarting(true);

        try {
            const result = await recheckAppSpecAction(workId);
            if (result.success) {
                // Optimistic for the button and the poll only (plan §5.3:633):
                // the request is recorded, so the state reads as pending and the
                // poll starts — the verdict itself arrives from the server, so no
                // second read is issued here beyond the poll's own cadence.
                setState((current) => ({ ...current, evaluationPending: true }));
            } else {
                setFailure(result.error);
            }
        } finally {
            setRecheckStarting(false);
        }
    };

    const bannerState = state.validationStatus;
    const now = Date.now();

    return (
        <div data-testid="app-spec-page" className="max-w-4xl space-y-6">
            <AppSpecStatusBanner
                state={state}
                checking={state.evaluationPending}
                recheckBusy={state.evaluationPending || recheckStarting}
                // Plan §4.1:548 — `{ source: 'branch' }` is an **edit**, so a
                // viewer gets no control at all rather than one the API refuses
                // (FR-76, ACC-03-41).
                onRecheck={permissions.canEdit ? onRecheck : undefined}
                now={now}
            />

            {failure && (
                <p
                    data-testid="app-spec-recheck-failure"
                    className="text-sm text-red-600 dark:text-red-400"
                >
                    {failure}
                </p>
            )}

            <AppSpecProblemsList
                issues={state.issues ?? []}
                errorCount={state.errorCount}
                warningCount={state.warningCount}
                truncated={state.issuesTruncated}
                links={state.links}
            />

            {/*
             * T31's slot: the Blueprint card (chips, breaking notice, pending
             * pull request) and its upgrade dialog (plan §5.2:621-622). The id is
             * exported by the banner, which anchors the missing state's **Browse
             * Blueprints** action at it — so the two cannot drift apart.
             */}
            <div id={APP_SPEC_BLUEPRINT_SLOT_ID} data-testid="app-spec-blueprint-slot" />

            {/*
             * T45's slot: the licence card — headline, mixed evidence,
             * eligibility, source offer and disclaimer (plan §5.2:623-624).
             */}
            <div data-testid="app-spec-license-slot" />

            <AppSpecSections spec={state.effectiveSpec} />

            {/*
             * The status the banner is showing, mirrored as a hidden data
             * attribute for the e2e lane: `data-state` on the page lets a spec
             * assert the rendered state without reading copy (plan §10.3:876-888,
             * ACC-03-40).
             */}
            <span data-testid="app-spec-validation-status" data-status={bannerState} hidden />
            <span data-testid="app-spec-evaluation-pending" data-pending={pending} hidden />
        </div>
    );
}
