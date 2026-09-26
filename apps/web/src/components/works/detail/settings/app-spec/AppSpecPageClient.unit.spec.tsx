import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { WorkAppSpecStateDto } from '@ever-works/contracts';

/**
 * APW-03 T17 — `AppSpecPageClient`, and the one behaviour the two component
 * specs cannot own: **the poll**.
 *
 * T17's test line (`tasks.md:369-371`) puts "polling stops after 24 polls" in
 * this task's spec set; the poll lives here, in the client that owns the state,
 * so it has its own spec rather than being asserted from inside the problems
 * list it renders. The three claims are plan §5.2:617 and §5.3:629-635 read
 * literally:
 *
 *  1. the poll **fires** while `evaluationPending` — and not at all when the
 *     state is settled (a poll on a settled page is a request every five seconds
 *     for nothing);
 *  2. it reads `GET /api/works/:id/app-spec` through the **BFF route** the T17
 *     report names (`apps/web/src/app/api/works/[id]/app-spec/route.ts`) — the
 *     shape chosen over a second server action, because Next queues an action
 *     behind the action already running and the job being polled is the one
 *     Re-check just queued;
 *  3. it **stops** when an answer comes back not pending, **stops at 24 polls**
 *     when it never does, and stops on unmount.
 *
 * Re-check is asserted for exactly what plan §5.3:633 allows it to be: the
 * button's optimistic state. The press marks the state pending — which is what
 * starts the poll — and the verdict itself only ever arrives from a poll.
 */

const { recheckAppSpecActionMock, permissions } = vi.hoisted(() => ({
    recheckAppSpecActionMock: vi.fn(),
    permissions: { canEdit: true },
}));

vi.mock('@/app/actions/dashboard/app-spec', () => ({
    recheckAppSpecAction: recheckAppSpecActionMock,
}));

vi.mock('../../WorkDetailContext', () => ({
    useWorkPermissions: () => permissions,
}));

import {
    APP_SPEC_POLL_INTERVAL_MS,
    APP_SPEC_POLL_MAX,
    AppSpecPageClient,
} from './AppSpecPageClient';

const APP_SPEC_COPY = {
    statusValid: 'App spec is valid.',
    statusMeta: 'Commit {sha} · Checked {ago}',
    statusWarnings: 'App spec is valid, with {count, plural, =1 {1 warning} other {# warnings}}.',
    statusInvalid: 'The App spec on {branch} has {count, plural, =1 {1 error} other {# errors}}.',
    statusInvalidRunning:
        'Still running the last valid spec from commit {sha}. Nothing new is built or deployed until the errors are fixed.',
    statusInvalidNothing: 'Nothing can be built or deployed until the errors are fixed.',
    statusMissing: 'No App spec yet.',
    statusMissingBody: 'Apply a Blueprint or let the App Provisioner write one.',
    statusUnreadable: "We couldn't read .works/works.yml from {branch}.",
    statusUnreadableBody: "We'll try again on the next push, or you can re-check now.",
    statusChecking: 'Checking the App spec…',
    recheck: 'Re-check now',
    recheckBusy: 'Checking…',
    browseBlueprints: 'Browse Blueprints',
    runProvisioner: 'Run the App Provisioner',
    problemsTitle: 'Problems',
    filterAll: 'All ({count})',
    filterErrors: 'Errors ({count})',
    filterWarnings: 'Warnings ({count})',
    problemsTruncated: 'Showing the first 200 problems.',
    severityError: 'Error',
    severityWarning: 'Warning',
    fixPrefix: 'Fix:',
    openInRepository: 'Open in repository',
    defaultMarker: 'default',
    sections: {
        source: 'Source',
        blueprint: 'Blueprint',
        license: 'License',
        build: 'Build',
        components: 'Components',
        dependencies: 'Dependencies',
        env: 'Env',
        jobs: 'Jobs',
        cron: 'Cron',
        domains: 'Domains',
        smoke: 'Smoke tests',
        checks: 'Checks',
        agents: 'Agents',
        upstream: 'Upstream',
    },
    issues: {},
};

const messages = { dashboard: { workDetail: { settings: { appSpec: APP_SPEC_COPY } } } };

const HEAD_SHA = '4f1c2ab999999999999999999999999999999999';
const CHECKED_AT = '2026-09-17T12:00:00.000Z';

function appSpecState(over: Partial<WorkAppSpecStateDto> = {}): WorkAppSpecStateDto {
    return {
        id: 'state-1',
        workId: 'w1',
        tenantId: null,
        organizationId: null,
        trackedBranch: 'main',
        dispatchedAt: null,
        headCommitSha: HEAD_SHA,
        headSpecHash: null,
        validationStatus: 'valid',
        issues: null,
        errorCount: 0,
        warningCount: 0,
        issuesTruncated: false,
        effectiveCommitSha: HEAD_SHA,
        effectiveSpecHash: null,
        effectiveSpec: null,
        effectiveAt: CHECKED_AT,
        lastEvaluatedAt: CHECKED_AT,
        lastEvaluationTrigger: 'push',
        lastEvaluationError: null,
        blueprintId: null,
        blueprintVersion: null,
        blueprintRepo: null,
        blueprintSha: null,
        blueprintMatchSource: null,
        blueprintApplyStatus: null,
        blueprintMatchedAt: null,
        blueprintApplyError: null,
        blueprintApplyRef: null,
        blueprintLatestVersion: null,
        blueprintUpgradeDismissedVersion: null,
        blueprintUpgradePr: null,
        licenseSpdx: null,
        licenseClass: null,
        licenseSource: null,
        licenseMixed: false,
        licenseScanIncomplete: false,
        licenseEvidence: null,
        licenseObligations: null,
        licenseCommitSha: null,
        licenseRegistryHash: null,
        licenseRegistrySource: null,
        licenseEvaluatedAt: null,
        attestation: null,
        sourceOfferRequired: false,
        displayName: null,
        trademarkNotice: null,
        protectedPaths: null,
        createdAt: CHECKED_AT,
        updatedAt: CHECKED_AT,
        evaluationPending: false,
        links: {
            file: {
                base: `https://github.com/acme/app/blob/${HEAD_SHA}/.works/works.yml`,
                commitSha: HEAD_SHA,
                path: '.works/works.yml',
            },
            lineAnchor: '#L{line}',
        },
        ...over,
    };
}

/** The stubbed BFF read: one JSON body per call, in order. */
function stubReads(bodies: WorkAppSpecStateDto[]) {
    const fetchMock = vi.fn(async () => {
        const next = bodies.length > 1 ? bodies.shift() : bodies[0];
        return {
            ok: true,
            status: 200,
            json: async () => next,
        };
    });

    vi.stubGlobal('fetch', fetchMock);

    return fetchMock;
}

/** The URLs the stubbed read was called with. */
function readUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
    return fetchMock.mock.calls.map((call) => String(call[0]));
}

function renderClient(state: WorkAppSpecStateDto) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <AppSpecPageClient workId="w1" initialState={state} />
        </NextIntlClientProvider>,
    );
}

describe('AppSpecPageClient — the 5-second poll (plan §5.2:617)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        window.history.replaceState({}, '', '/works/w1/settings/app-spec');
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('names the poll cadence and the cap plan §5.2 fixes', () => {
        expect(APP_SPEC_POLL_INTERVAL_MS).toBe(5_000);
        expect(APP_SPEC_POLL_MAX).toBe(24);
    });

    it('does not poll at all when no evaluation is pending', async () => {
        const fetchMock = stubReads([appSpecState({ evaluationPending: false })]);

        renderClient(appSpecState({ evaluationPending: false }));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_SPEC_POLL_INTERVAL_MS * 5);
        });

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('polls every five seconds while an evaluation is pending, through the BFF route', async () => {
        const fetchMock = stubReads([
            appSpecState({ evaluationPending: true }),
            appSpecState({ evaluationPending: true }),
        ]);

        renderClient(appSpecState({ evaluationPending: true }));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_SPEC_POLL_INTERVAL_MS);
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(readUrls(fetchMock)).toEqual(['/api/works/w1/app-spec']);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_SPEC_POLL_INTERVAL_MS);
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('stops the moment an answer comes back not pending', async () => {
        const fetchMock = stubReads([
            appSpecState({ evaluationPending: false, validationStatus: 'invalid', errorCount: 2 }),
            appSpecState({ evaluationPending: false }),
        ]);

        renderClient(appSpecState({ evaluationPending: true }));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_SPEC_POLL_INTERVAL_MS);
        });

        expect(screen.getByTestId('app-spec-validation-status').dataset.status).toBe('invalid');
        expect(screen.getByTestId('app-spec-evaluation-pending').dataset.pending).toBe('false');

        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_SPEC_POLL_INTERVAL_MS * 5);
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('stops after 24 polls when the evaluation never settles', async () => {
        const fetchMock = stubReads([appSpecState({ evaluationPending: true })]);

        renderClient(appSpecState({ evaluationPending: true }));

        // 23 more ticks after the first: each of the next 24 ticks is made, and
        // the 25th must not issue a request.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_SPEC_POLL_INTERVAL_MS * (APP_SPEC_POLL_MAX + 3));
        });

        expect(fetchMock).toHaveBeenCalledTimes(APP_SPEC_POLL_MAX);
    });

    it('stops polling on unmount', async () => {
        const fetchMock = stubReads([appSpecState({ evaluationPending: true })]);

        const view = renderClient(appSpecState({ evaluationPending: true }));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_SPEC_POLL_INTERVAL_MS);
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);

        view.unmount();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_SPEC_POLL_INTERVAL_MS * 5);
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('keeps the last known state when a poll fails', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
        );

        renderClient(
            appSpecState({ evaluationPending: true, validationStatus: 'invalid', errorCount: 2 }),
        );

        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_SPEC_POLL_INTERVAL_MS * 2);
        });

        expect(screen.getByTestId('app-spec-status-banner').dataset.state).toBe('checking');
        expect(screen.getByTestId('app-spec-validation-status').dataset.status).toBe('invalid');
    });
});

describe('AppSpecPageClient — Re-check is optimistic for the button only (plan §5.3:633)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        permissions.canEdit = true;
        window.history.replaceState({}, '', '/works/w1/settings/app-spec');
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('marks the state pending on a successful press, which is what starts the poll', async () => {
        recheckAppSpecActionMock.mockResolvedValue({
            success: true,
            data: { evaluationPending: true },
            error: null,
        });
        const fetchMock = stubReads([
            appSpecState({ evaluationPending: true }),
            appSpecState({ evaluationPending: true }),
        ]);

        renderClient(appSpecState({ evaluationPending: false }));

        expect(screen.getByTestId('app-spec-evaluation-pending').dataset.pending).toBe('false');

        await act(async () => {
            screen.getByTestId('app-spec-recheck').click();
        });

        expect(recheckAppSpecActionMock).toHaveBeenCalledWith('w1');
        expect(screen.getByTestId('app-spec-recheck')).toHaveTextContent('Checking…');

        // The press itself issues no read: the poll's own cadence is what asks
        // the server for the new verdict (plan §5.3:633).
        expect(fetchMock).not.toHaveBeenCalled();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_SPEC_POLL_INTERVAL_MS);
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('renders the action’s refusal instead of swallowing it', async () => {
        recheckAppSpecActionMock.mockResolvedValue({
            success: false,
            data: null,
            error: 'Re-check is limited to 6 times a minute per App Work. Please try again shortly.',
        });
        const fetchMock = stubReads([appSpecState()]);

        renderClient(appSpecState({ evaluationPending: false }));

        await act(async () => {
            screen.getByTestId('app-spec-recheck').click();
            // The handler awaits the action, so the refusal lands on the next
            // microtask; `act` flushes it rather than a `waitFor` racing the
            // page's fake timers.
            await Promise.resolve();
        });

        expect(screen.getByTestId('app-spec-recheck-failure')).toHaveTextContent(
            'Re-check is limited to 6 times a minute per App Work. Please try again shortly.',
        );

        // A refused press is not a pending evaluation, so nothing polls.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(APP_SPEC_POLL_INTERVAL_MS * 3);
        });

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('offers no Re-check to a viewer (ACC-03-41)', async () => {
        permissions.canEdit = false;

        renderClient(appSpecState({ evaluationPending: false }));

        expect(screen.queryByTestId('app-spec-recheck')).not.toBeInTheDocument();
    });
});

describe('AppSpecPageClient — the layout of §6.2', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        permissions.canEdit = true;
        window.history.replaceState({}, '', '/works/w1/settings/app-spec');
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('renders the banner, the problems, the two card slots and the sections', () => {
        renderClient(
            appSpecState({
                validationStatus: 'invalid',
                errorCount: 1,
                issues: [
                    {
                        code: 'unknown_field',
                        severity: 'error',
                        path: 'spec.components[0].replica',
                        pointer: '/spec/components/0/replica',
                        displayPath: 'components › web › replica',
                        line: 41,
                        column: 7,
                        message: 'Unknown field `replica`. Did you mean `replicas`?',
                    },
                ],
                effectiveSpec: {
                    kind: 'app',
                    appSpecVersion: 1,
                    build: { dockerfile: 'Dockerfile' },
                },
            }),
        );

        expect(screen.getByTestId('app-spec-status-banner')).toBeInTheDocument();
        expect(screen.getByTestId('app-spec-problems')).toBeInTheDocument();
        expect(screen.getByTestId('app-spec-blueprint-slot')).toBeInTheDocument();
        expect(screen.getByTestId('app-spec-license-slot')).toBeInTheDocument();
        expect(screen.getByTestId('app-spec-sections')).toBeInTheDocument();
    });

    it('renders no sections while no spec is effective, and no problems when there are none', () => {
        renderClient(
            appSpecState({ validationStatus: 'missing', effectiveSpec: null, issues: null }),
        );

        expect(screen.queryByTestId('app-spec-sections')).not.toBeInTheDocument();
        expect(screen.queryByTestId('app-spec-problems')).not.toBeInTheDocument();
    });
});
