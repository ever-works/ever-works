import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import {
    FLEET_ACTIONS_RUNNER_STATES,
    type FleetActionsRunnerOptionsView,
    type FleetActionsRunnersListView,
    type FleetActionsRunnerView,
    type FleetNodeView,
} from '@ever-works/contracts';

// The REAL English strings: a key a component asks for that `en.json` lacks
// fails the test instead of echoing (see `fleet-test-intl.ts`).
vi.mock('next-intl', async () => {
    const { testTranslations } = await import('../health/fleet-test-intl');
    return { useLocale: () => 'en-GB', useTranslations: testTranslations };
});

const list = vi.fn();
const options = vi.fn();
vi.mock('@/app/actions/fleet/runners', () => ({
    listFleetActionsRunnersAction: (...args: unknown[]) => list(...args),
    fleetActionsRunnerOptionsAction: (...args: unknown[]) => options(...args),
    installFleetActionsRunnersAction: vi.fn(),
    fleetActionsRunnerControlAction: vi.fn(),
    removeFleetActionsRunnerAction: vi.fn(),
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({
        children,
        href,
        className,
        ...rest
    }: {
        children: React.ReactNode;
        href: string;
        className?: string;
    }) => (
        <a href={href} className={className} {...rest}>
            {children}
        </a>
    ),
}));
let search = new URLSearchParams();
vi.mock('next/navigation', () => ({ useSearchParams: () => search }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import RunnersBlock from './RunnersBlock';
import { RUNNER_STATE_GLYPHS } from './runners.shared';

/** Actions runners on computers (FL-18 P1, spec §5.2, T-16) — the computer Overview's Actions runners block. */

function node(overrides: Partial<FleetNodeView> = {}): FleetNodeView {
    return {
        id: 'n1',
        name: 'build-01',
        kind: 'node',
        status: 'online',
        capabilities: ['actions-runner'],
        persisted: true,
        controlPolicy: 'owner',
        controlPolicyFamilies: null,
        ...overrides,
    } as FleetNodeView;
}

function runner(overrides: Partial<FleetActionsRunnerView> = {}): FleetActionsRunnerView {
    return {
        id: 'r1',
        nodeId: 'n1',
        name: 'build-01-1',
        scope: 'repo',
        target: 'acme/api',
        labels: ['gpu'],
        defaultLabels: ['self-hosted', 'Linux', 'X64'],
        mode: 'service',
        state: 'idle',
        stateSource: 'github',
        stoppedByOwner: false,
        phase: null,
        lastError: null,
        githubRunnerId: 7,
        runnerVersion: '2.321.0',
        currentJob: null,
        lastSeenAt: null,
        lastCheckAt: null,
        installedAt: null,
        githubUrl: 'https://github.com/acme/api/settings/actions/runners',
        logSource: 'runner:build-01-1',
        ...overrides,
    };
}

function view(overrides: Partial<FleetActionsRunnersListView> = {}): FleetActionsRunnersListView {
    return {
        node: { id: 'n1', name: 'build-01' },
        runners: [],
        checkedAt: new Date(2026, 9, 26, 9, 41).toISOString(),
        rateLimitedUntil: null,
        killSwitch: false,
        ...overrides,
    };
}

const canHost: FleetActionsRunnerOptionsView = {
    nodeId: 'n1',
    nodeName: 'build-01',
    canHost: true,
    reason: null,
    hint: null,
    os: 'linux',
    arch: 'x64',
    targets: [],
    modes: ['service'],
    defaultLabels: ['self-hosted', 'Linux', 'X64'],
    maxPerNode: 16,
    existing: 0,
    suggestedNames: ['build-01-1'],
    appInstalled: true,
};

beforeEach(() => {
    list.mockReset();
    options.mockReset();
    options.mockResolvedValue({ ok: true, data: canHost });
    search = new URLSearchParams();
});

describe('RunnersBlock', () => {
    it('renders nothing while runners are switched off (the API answers 404)', async () => {
        list.mockResolvedValue({ ok: false, error: { code: 'not_found', hint: '' } });
        const { container } = render(<RunnersBlock nodes={[node()]} flags={{}} />);
        await waitFor(() => expect(list).toHaveBeenCalledWith('n1'));
        await waitFor(() => expect(container).toBeEmptyDOMElement());
        expect(options).not.toHaveBeenCalled();
    });

    it('renders nothing on the hub (more than one computer)', () => {
        const { container } = render(
            <RunnersBlock nodes={[node(), node({ id: 'n2' })]} flags={{}} />,
        );
        expect(container).toBeEmptyDOMElement();
    });

    it('says when a computer has no runners, and offers Install runners', async () => {
        list.mockResolvedValue({ ok: true, data: view() });
        render(<RunnersBlock nodes={[node()]} flags={{}} />);
        expect(await screen.findByText('No Actions runners on build-01')).toBeInTheDocument();
        expect(screen.getByTestId('fleet-runners-checked')).toHaveTextContent('checked 09:41');
        await waitFor(() => expect(screen.getByTestId('fleet-runners-install')).toBeEnabled());
    });

    it('shows every state with its glyph and English label', async () => {
        const runners = FLEET_ACTIONS_RUNNER_STATES.map((state, index) =>
            runner({
                id: `r${index}`,
                name: `build-01-${index + 1}`,
                state,
                stoppedByOwner: state === 'stopped',
                phase: state === 'installing' ? 'verifying' : null,
                lastError:
                    state === 'failed'
                        ? 'checksum mismatch for actions-runner-linux-x64-2.321.0.tar.gz\nmore'
                        : state === 'unknown'
                          ? 'GitHub lists it, build-01 does not'
                          : null,
            }),
        );
        list.mockResolvedValue({ ok: true, data: view({ runners }) });
        render(<RunnersBlock nodes={[node()]} flags={{}} />);
        const rows = await screen.findAllByTestId('fleet-runner-row');
        expect(rows).toHaveLength(FLEET_ACTIONS_RUNNER_STATES.length);
        const byState = (state: string) => rows.find((row) => row.dataset.state === state)!;
        for (const state of FLEET_ACTIONS_RUNNER_STATES) {
            expect(byState(state)).toHaveTextContent(RUNNER_STATE_GLYPHS[state]);
        }
        expect(within(byState('idle')).getByTestId('fleet-runner-state')).toHaveTextContent('idle');
        expect(within(byState('stopped')).getByTestId('fleet-runner-state')).toHaveTextContent(
            'stopped (by you)',
        );
        expect(within(byState('installing')).getByTestId('fleet-runner-state')).toHaveTextContent(
            'installing · verifying',
        );
        expect(within(byState('failed')).getByTestId('fleet-runner-state')).toHaveTextContent(
            'failed — checksum mismatch for actions-runner-linux-x64-2.321.0.tar.gz',
        );
        expect(within(byState('unknown')).getByTestId('fleet-runner-state')).toHaveTextContent(
            'unknown — GitHub lists it, build-01 does not',
        );
        expect(screen.getByText('Actions runners (8)')).toBeInTheDocument();
    });

    it('tells a runner that failed on a missing App permission what to accept (FL-18 A16)', async () => {
        list.mockResolvedValue({
            ok: true,
            data: view({
                runners: [
                    runner({
                        state: 'failed',
                        lastError:
                            'the registration token could not be fetched: the Ever Works GitHub App on acme needs "Administration: Read and write"',
                    }),
                    runner({
                        id: 'r2',
                        name: 'build-01-2',
                        state: 'failed',
                        lastError: 'checksum mismatch for actions-runner-linux-x64-2.321.0.tar.gz',
                    }),
                ],
            }),
        });
        render(<RunnersBlock nodes={[node()]} flags={{}} />);
        const hints = await screen.findAllByTestId('fleet-runner-accept-permission');
        expect(hints).toHaveLength(1);
        expect(hints[0]).toHaveTextContent(
            'The Ever Works GitHub App lacks “Administration: Read and write” here. Accept the App’s updated permissions on GitHub (installation settings → “Review request” → “Accept new permissions”), then Reinstall.',
        );
    });

    it('names the job a working runner is on and links Logs and GitHub', async () => {
        list.mockResolvedValue({
            ok: true,
            data: view({
                runners: [
                    runner({
                        state: 'working',
                        currentJob: {
                            runId: 1,
                            jobId: 2,
                            name: 'test · ubuntu',
                            runNumber: 4821,
                            url: 'https://github.com/acme/api/actions/runs/1/job/2',
                        },
                    }),
                ],
            }),
        });
        render(<RunnersBlock nodes={[node()]} flags={{}} />);
        expect(await screen.findByTestId('fleet-runner-job')).toHaveTextContent(
            '“test · ubuntu” run #4821',
        );
        expect(screen.getByTestId('fleet-runner-open-job')).toHaveAttribute(
            'href',
            'https://github.com/acme/api/actions/runs/1/job/2',
        );
        expect(screen.getByTestId('fleet-runner-logs')).toHaveAttribute(
            'href',
            '/fleet/computers/n1?tab=logs&source=runner%3Abuild-01-1',
        );
        expect(screen.getByTestId('fleet-runner-open-github')).toHaveAttribute(
            'href',
            'https://github.com/acme/api/settings/actions/runners',
        );
        expect(screen.getByTestId('fleet-runner-stop')).toBeEnabled();
        expect(screen.queryByTestId('fleet-runner-start')).toBeNull();
    });

    it('says GitHub is rate-limiting and that the kill switch pauses installing and controls', async () => {
        list.mockResolvedValue({
            ok: true,
            data: view({
                runners: [runner()],
                killSwitch: true,
                rateLimitedUntil: new Date(2026, 9, 26, 9, 52).toISOString(),
            }),
        });
        render(<RunnersBlock nodes={[node()]} flags={{}} />);
        expect(await screen.findByTestId('fleet-runners-kill-switch')).toHaveTextContent(
            'runners keep running',
        );
        expect(screen.getByTestId('fleet-runners-rate-limited')).toHaveTextContent(
            'next check 09:52',
        );
        expect(screen.getByTestId('fleet-runners-install')).toBeDisabled();
        expect(screen.getByTestId('fleet-runner-stop')).toBeDisabled();
    });

    it('disables Install runners with the server’s reason when the computer cannot host runners', async () => {
        list.mockResolvedValue({ ok: true, data: view() });
        options.mockResolvedValue({
            ok: true,
            data: {
                ...canHost,
                canHost: false,
                reason: 'consent-missing',
                hint: 'start the node with --work on build-01',
            },
        });
        render(<RunnersBlock nodes={[node()]} flags={{}} />);
        await waitFor(() => expect(screen.getByTestId('fleet-runners-install')).toBeDisabled());
        expect(screen.getByTestId('fleet-runners-install')).toHaveAttribute(
            'title',
            'start the node with --work on build-01',
        );
        expect(screen.getByTestId('fleet-runners-cannot-host')).toHaveTextContent('--work');
    });

    it('hides Install runners outside the computer’s machines audience and disables the row acts', async () => {
        list.mockResolvedValue({ ok: true, data: view({ runners: [runner()] }) });
        render(<RunnersBlock nodes={[node({ viewerRole: 'org-member' })]} flags={{}} />);
        expect(await screen.findByTestId('fleet-runner-stop')).toBeDisabled();
        expect(screen.queryByTestId('fleet-runners-install')).toBeNull();
        expect(options).not.toHaveBeenCalled();
    });

    it('notes a newer runner build and names the container mode (P3)', async () => {
        list.mockResolvedValue({
            ok: true,
            data: view({
                runners: [
                    runner({
                        mode: 'docker',
                        runnerVersion: '2.321.0',
                        updateAvailable: '2.322.0',
                    }),
                ],
            }),
        });
        render(<RunnersBlock nodes={[node()]} flags={{}} />);
        expect(await screen.findByTestId('fleet-runner-update')).toHaveTextContent(
            'Update available: 2.322.0',
        );
        expect(screen.getByTestId('fleet-runner-row')).toHaveTextContent('container-isolated');
    });
});
