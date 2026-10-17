import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import {
    APP_BUILD_FAILURE_CLASSES,
    APP_BUILD_FAILURE_COPY_EN,
    type AppBuildDetail,
    type AppBuildSummary,
} from '@ever-works/contracts';
import messages from '../../../../../messages/en.json';

/**
 * APW-05 T27 — the drawer and its failure panel, with the REAL English
 * catalogue: the copy a member reads is what is asserted.
 */

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/app/actions/dashboard/app-builds', () => ({
    getAppBuildAction: getMock,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: any) => (
        <a href={typeof href === 'string' ? href : ''} {...rest}>
            {children}
        </a>
    ),
}));

import { AppBuildDrawer, AppBuildFailurePanel } from './AppBuildDrawer';

const summary: AppBuildSummary = {
    id: 'b14',
    number: 14,
    status: 'failed',
    trigger: 'manual',
    branch: 'main',
    commitSha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432',
    pullRequestNumber: null,
    blockedReason: null,
    blockedDetail: null,
    deployable: false,
    notDeployableReason: 'notSucceeded',
    imageRepository: null,
    imageDigest: null,
    imageTags: [],
    failureClass: 'outOfMemory',
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    durationSeconds: 663,
    logsUrl: 'https://github.com/acme/app/actions/runs/1',
};

const detail: AppBuildDetail = {
    ...summary,
    runnerClass: 'github-public',
    runnerLabel: 'ubuntu-latest',
    buildValueNames: ['DATABASE_URL'],
    failureDetail: { memory: '7 GB', max: '14 GB' },
    failureExcerpt: ['FATAL ERROR: Reached heap limit', 'Allocation failed'],
    verificationResult: null,
    receipt: {
        billableMinutes: 11,
        checksBillableMinutes: null,
        payer: 'workspace',
        costKnown: true,
    },
    triggeredBy: { userId: 'u1', name: 'Maya' },
    canEdit: true,
};

function withIntl(node: React.ReactNode) {
    return (
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            {node}
        </NextIntlClientProvider>
    );
}

beforeEach(() => {
    getMock.mockReset();
});

afterEach(() => {
    cleanup();
});

describe('AppBuildDrawer', () => {
    it('renders the failure title and suggestion with the build values, the excerpt and the receipt', async () => {
        getMock.mockResolvedValue({ success: true, data: detail });

        render(
            withIntl(
                <AppBuildDrawer
                    workId="w1"
                    build={summary}
                    onClose={vi.fn()}
                    canEdit
                    onRebuild={vi.fn()}
                />,
            ),
        );

        expect(await screen.findByText('Ran out of memory')).toBeInTheDocument();
        expect(
            await screen.findByText(
                "Raise build.resources.memory (now 7 GB) or lower the build's heap size. On this runner a build can use at most 14 GB.",
            ),
        ).toBeInTheDocument();
        expect(screen.getByText(/Reached heap limit/)).toBeInTheDocument();
        expect(
            screen.getByText('11 runner minutes · paid by your GitHub account'),
        ).toBeInTheDocument();
        expect(screen.getByText('Manual — by Maya')).toBeInTheDocument();
        expect(getMock).toHaveBeenCalledWith('w1', 'b14');
    });

    it('keeps the row summary on screen when the detail read fails', async () => {
        getMock.mockResolvedValue({ success: false, statusCode: 500 });
        render(withIntl(<AppBuildDrawer workId="w1" build={summary} onClose={vi.fn()} canEdit />));
        expect(await screen.findByText("Couldn't load this build. Try again.")).toBeInTheDocument();
        expect(screen.getByText('Ran out of memory')).toBeInTheDocument();
    });
});

describe('AppBuildFailurePanel', () => {
    it('fills the Dockerfile step params', () => {
        render(
            withIntl(
                <AppBuildFailurePanel
                    failureClass="dockerfileError"
                    failureDetail={{
                        step: 4,
                        total: 9,
                        command: 'RUN pnpm build',
                        dockerfile: 'Dockerfile',
                    }}
                />,
            ),
        );
        expect(screen.getByText('The Dockerfile failed at step 4 of 9')).toBeInTheDocument();
        expect(
            screen.getByText(
                'The failing step was: RUN pnpm build. Fix it in Dockerfile and push, or ask an agent to fix it.',
            ),
        ).toBeInTheDocument();
    });

    it('renders every failure class without a raw key, even with no detail', () => {
        for (const failureClass of APP_BUILD_FAILURE_CLASSES) {
            const view = render(
                withIntl(<AppBuildFailurePanel failureClass={failureClass} failureDetail={null} />),
            );
            const panel = screen.getByTestId(`app-build-failure-${failureClass}`);
            expect(panel.textContent).not.toContain('dashboard.workDetail');
            expect(panel.textContent).not.toContain('{');
            view.unmount();
        }
    });
});

describe('failure copy parity', () => {
    it('en.json carries APP_BUILD_FAILURE_COPY_EN verbatim', () => {
        const leaves = messages.dashboard.workDetail.builds.failure as Record<
            string,
            { title: string; suggestion: string } | string
        >;
        for (const failureClass of APP_BUILD_FAILURE_CLASSES) {
            expect(leaves[failureClass]).toEqual(APP_BUILD_FAILURE_COPY_EN[failureClass]);
        }
    });
});
