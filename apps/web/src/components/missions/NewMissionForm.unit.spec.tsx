import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MissionTemplateManifestView } from '@/lib/api/missions';

/**
 * APW-08 T40 (FR-56…FR-60; APW08-G13) — the **Build on an open-source app** template's fields:
 * rendered only for a template whose manifest has `appWork`; the summary reads the FR-57 values;
 * **Propose these rules** sends ONE evolve request and writes nothing to the App spec; the create
 * carries the template and its inputs; and the catalog's **Use this Template** path
 * (`/new?type=mission&template=…`, `NewPageClient`) renders the same fields.
 */

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
        values ? `${ns}.${key} ${JSON.stringify(values)}` : `${ns}.${key}`,
    useLocale: () => 'en',
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastWarning = vi.fn();
vi.mock('sonner', () => ({
    toast: {
        success: (...args: unknown[]) => toastSuccess(...args),
        error: (...args: unknown[]) => toastError(...args),
        warning: (...args: unknown[]) => toastWarning(...args),
    },
}));

const routerPush = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: routerPush, back: vi.fn() }),
    Link: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
        <a href={href}>{children}</a>
    ),
}));

vi.mock('@/lib/hooks/use-chat-panel', () => ({
    useChatPanel: () => ({ open: false, setOpen: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-start-from-prompt', () => ({
    useStartFromPrompt: () => vi.fn(),
}));

// The Work picker reads the account's Works through a server action and renders the custom
// dropdown; a native <select> stands in for it (as in GoalForm.unit.spec), offering the Works of
// the kinds it is given — so the template's picker is pinned to App Works by its `kinds` prop.
const WORKS = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Cal.com', kind: 'app' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Umami', kind: 'app' },
    { id: 'w-site', name: 'Marketing site', kind: 'website' },
];
const workSelectProps = vi.fn();
vi.mock('@/components/tasks/WorkSelect', () => ({
    WorkSelect: (props: {
        value: string;
        onValueChange: (v: string) => void;
        noneLabel: string;
        testId?: string;
        id?: string;
        kinds?: readonly string[];
    }) => {
        workSelectProps(props);
        const offered = WORKS.filter((work) => !props.kinds || props.kinds.includes(work.kind));
        return (
            <select
                data-testid={props.testId}
                id={props.id}
                value={props.value}
                onChange={(e) => props.onValueChange(e.currentTarget.value)}
            >
                <option value="">{props.noneLabel}</option>
                {offered.map((work) => (
                    <option key={work.id} value={work.id}>
                        {work.name}
                    </option>
                ))}
            </select>
        );
    },
}));

const requestAppChangeAction = vi.fn();
vi.mock('@/app/actions/dashboard/app-changes', () => ({
    requestAppChangeAction: (...args: unknown[]) => requestAppChangeAction(...args),
}));

const createMissionAction = vi.fn();
vi.mock('@/app/actions/dashboard/missions', () => ({
    createMissionAction: (...args: unknown[]) => createMissionAction(...args),
    attachUploadToMissionAction: vi.fn(),
}));

import { NewMissionForm } from './NewMissionForm';
import { NewPageClient } from '@/components/new/NewPageClient';

const APP_WORK_ID = '11111111-1111-4111-8111-111111111111';

const MANIFEST: MissionTemplateManifestView = {
    templateId: 'build-on-open-source-app',
    defaults: {
        cadence: '0 8 * * 1',
        outputMode: 'tasks',
        tasksPerTick: 2,
        openTasksCap: 4,
        maxBudgetCentsPerRun: 1500,
        requireApprovalBeforeCreate: true,
        outstandingIdeasCap: 0,
    },
    appWork: {
        requiredRelation: 'improves',
        maxPullRequestChangedLines: 400,
        requireHumanMergePaths: ['**/migrations/**', '**/*.sql'],
        protectedPaths: ['LICENSE*'],
    },
    suggestedGoals: [
        { title: 'First customised feature live', dodCriteria: ['a'] },
        {
            title: 'Four changes live in a month, none closed without deploying',
            dodCriteria: ['b'],
        },
    ],
    warnings: [],
};

const TEMPLATE = { id: 'build-on-open-source-app', manifest: MANIFEST };

beforeEach(() => {
    vi.clearAllMocks();
    requestAppChangeAction.mockResolvedValue({ success: true, data: { taskId: 't1' } });
    createMissionAction.mockResolvedValue({ id: 'm1' });
});

function chooseAppWork() {
    const select = screen.getByTestId('build-on-app-work');
    // The picker offers App Works only.
    expect(workSelectProps).toHaveBeenLastCalledWith(expect.objectContaining({ kinds: ['app'] }));
    expect(select.querySelector(`option[value="${APP_WORK_ID}"]`)).not.toBeNull();
    expect(select.querySelector('option[value="w-site"]')).toBeNull();
    fireEvent.change(select, { target: { value: APP_WORK_ID } });
}

describe('NewMissionForm — Build on an open-source app (APW-08 T40)', () => {
    it('renders no template fields without a template, or for a template without appWork', () => {
        const { unmount } = render(<NewMissionForm createMission={vi.fn()} />);
        expect(screen.queryByTestId('build-on-app-fields')).toBeNull();
        unmount();
        render(
            <NewMissionForm
                createMission={vi.fn()}
                template={{
                    id: 'starter-business',
                    manifest: { ...MANIFEST, appWork: null, suggestedGoals: [] },
                }}
            />,
        );
        expect(screen.queryByTestId('build-on-app-fields')).toBeNull();
        render(<NewMissionForm createMission={vi.fn()} template={{ id: 'x', manifest: null }} />);
        expect(screen.queryByTestId('build-on-app-fields')).toBeNull();
    });

    it('renders the three fields and a summary that reads the FR-57 values', async () => {
        render(<NewMissionForm createMission={vi.fn()} template={TEMPLATE} />);
        expect(screen.getByTestId('build-on-app-product')).toBeInTheDocument();
        expect(screen.getByTestId('build-on-app-business')).toBeInTheDocument();
        expect(screen.getByTestId('build-on-app-work')).toBeInTheDocument();
        expect(screen.getByTestId('build-on-app-summary-line').textContent).toBe(
            'dashboard.missionsPage.buildOnApp.summary {"count":2,"amount":"$15.00"}',
        );
        expect(screen.getByTestId('build-on-app-backlog-note')).toBeInTheDocument();
        expect(screen.getByTestId('build-on-app-goals').querySelectorAll('li')).toHaveLength(2);
        expect(screen.getByTestId('build-on-app-rules').textContent).toBe(
            'dashboard.missionsPage.buildOnApp.rules {"lines":400}',
        );
        // The template's cadence is the starting schedule, and the person can change it (FR-60).
        expect(screen.getByLabelText('dashboard.missionsPage.newPage.typeLabel')).toHaveValue(
            'scheduled',
        );
        expect(screen.getByLabelText('dashboard.missionsPage.newPage.scheduleLabel')).toHaveValue(
            '0 8 * * 1',
        );
    });

    it('Propose these rules sends one evolve request and no App spec write', async () => {
        const proposeRules = vi.fn(async () => ({ success: true }));
        render(
            <NewMissionForm
                createMission={vi.fn()}
                template={TEMPLATE}
                proposeRules={proposeRules}
            />,
        );
        // Without an App Work it asks for one and sends nothing.
        fireEvent.click(screen.getByTestId('build-on-app-propose-rules'));
        expect(proposeRules).not.toHaveBeenCalled();
        expect(toastError).toHaveBeenCalledWith(
            'dashboard.missionsPage.buildOnApp.proposeNeedsAppWork',
        );

        chooseAppWork();
        fireEvent.click(screen.getByTestId('build-on-app-propose-rules'));
        await waitFor(() => expect(proposeRules).toHaveBeenCalledTimes(1));
        const [workId, request] = proposeRules.mock.calls[0] as unknown as [string, string];
        expect(workId).toBe(APP_WORK_ID);
        expect(request).toContain('by pull request');
        expect(request).toContain('`agents.requireHumanMergePaths`');
        expect(request).toContain('`**/migrations/**`');
        expect(request).toContain('`agents.maxPullRequestChangedLines`: 400');
        expect(request).toContain('`display.protectedPaths`');
        expect(request.length).toBeLessThanOrEqual(4000);
        await waitFor(() =>
            expect(toastSuccess).toHaveBeenCalledWith(
                'dashboard.missionsPage.buildOnApp.rulesProposed',
            ),
        );
        // A second click files nothing more for the same App Work...
        fireEvent.click(screen.getByTestId('build-on-app-propose-rules'));
        expect(proposeRules).toHaveBeenCalledTimes(1);
        // ...while another App Work can still get its own request.
        fireEvent.change(screen.getByTestId('build-on-app-work'), {
            target: { value: '22222222-2222-4222-8222-222222222222' },
        });
        expect(screen.getByTestId('build-on-app-propose-rules')).not.toBeDisabled();
    });

    it('by default Propose these rules is the App change request action, called once', async () => {
        render(<NewMissionForm createMission={vi.fn()} template={TEMPLATE} />);
        chooseAppWork();
        fireEvent.click(screen.getByTestId('build-on-app-propose-rules'));
        await waitFor(() => expect(requestAppChangeAction).toHaveBeenCalledTimes(1));
        const [workId, request] = requestAppChangeAction.mock.calls[0] as [string, string];
        expect(workId).toBe(APP_WORK_ID);
        expect(request).toContain('`.works/works.yml`');
        expect(request).toContain('by pull request');
    });

    it('a template that was only partly applied is said after the create', async () => {
        const createMission = vi.fn(async () => ({
            id: 'm7',
            warnings: ['templateGoalsNotCreated'],
        }));
        render(
            <NewMissionForm
                createMission={createMission as never}
                template={TEMPLATE}
                initialDescription="Build my own product on top of an open-source app."
            />,
        );
        fireEvent.change(screen.getByTestId('build-on-app-product'), {
            target: { value: 'Booking' },
        });
        fireEvent.change(screen.getByTestId('build-on-app-business'), {
            target: { value: 'Yoga Loft' },
        });
        chooseAppWork();
        fireEvent.click(screen.getByTestId('new-mission-submit'));
        await waitFor(() =>
            expect(toastWarning).toHaveBeenCalledWith(
                'dashboard.missionsPage.buildOnApp.templatePartial',
            ),
        );
    });

    it('the summary line describes the template cadence only while the schedule is that cadence', () => {
        render(<NewMissionForm createMission={vi.fn()} template={TEMPLATE} />);
        expect(screen.getByTestId('build-on-app-summary-line')).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('dashboard.missionsPage.newPage.scheduleLabel'), {
            target: { value: '0 6 * * 3' },
        });
        expect(screen.queryByTestId('build-on-app-summary-line')).toBeNull();
    });

    it('creates the Mission with the template and its inputs; the rest comes from the manifest', async () => {
        const createMission = vi.fn(async () => ({ id: 'm42' }));
        render(
            <NewMissionForm
                createMission={createMission as never}
                template={TEMPLATE}
                initialDescription="Build my own product on top of an open-source app."
            />,
        );
        const submit = screen.getByTestId('new-mission-submit');
        expect(submit).toBeDisabled();
        fireEvent.change(screen.getByTestId('build-on-app-product'), {
            target: { value: ' Booking ' },
        });
        fireEvent.change(screen.getByTestId('build-on-app-business'), {
            target: { value: 'Yoga Loft' },
        });
        chooseAppWork();
        await waitFor(() => expect(submit).not.toBeDisabled());
        fireEvent.click(submit);
        await waitFor(() => expect(createMission).toHaveBeenCalledTimes(1));
        expect(createMission).toHaveBeenCalledWith({
            description: 'Build my own product on top of an open-source app.',
            type: 'scheduled',
            schedule: '0 8 * * 1',
            missionTemplateRepo: 'build-on-open-source-app',
            templateInputs: { product: 'Booking', business: 'Yoga Loft', appWorkId: APP_WORK_ID },
        });
        await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/missions/m42'));
    });

    it('the /new?type=mission&template=… path renders the same fields (APW08-G13)', async () => {
        render(
            <NewPageClient
                initialType="mission"
                initialTemplateId="build-on-open-source-app"
                missionTemplate={TEMPLATE}
                missionTemplateDescription="From the catalog."
                disabledKinds={['store', 'app']}
            />,
        );
        expect(screen.getByTestId('build-on-app-fields')).toBeInTheDocument();
        expect(screen.getByTestId('build-on-app-product')).toBeInTheDocument();
        expect(screen.getByTestId('build-on-app-summary-line')).toBeInTheDocument();
        expect(screen.getByTestId('new-mission-form')).toBeInTheDocument();
        expect(screen.queryByTestId('new-prompt')).toBeNull();
    });

    it('a template without appWork keeps the /new prompt composer path', () => {
        render(
            <NewPageClient
                initialType="mission"
                initialTemplateId="starter-business"
                missionTemplate={{ id: 'starter-business', manifest: null }}
                disabledKinds={['store', 'app']}
            />,
        );
        expect(screen.queryByTestId('build-on-app-fields')).toBeNull();
        expect(screen.getByTestId('new-prompt')).toBeInTheDocument();
    });
});
