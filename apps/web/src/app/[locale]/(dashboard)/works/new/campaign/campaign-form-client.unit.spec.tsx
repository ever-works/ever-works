import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
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

const push = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push, refresh: vi.fn() }),
    Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));

const createCampaignWork = vi.fn();
vi.mock('@/app/actions/dashboard/works', () => ({
    createCampaignWork: (...args: unknown[]) => createCampaignWork(...args),
}));

import CampaignFormClient, { parseChannels } from './campaign-form-client';

const OK = {
    success: true,
    campaign: {
        work: { id: 'w1', slug: 'q3-launch', name: 'Q3 launch', kind: 'campaign' },
        goal: { id: 'g1', title: 'Q3 launch', metricId: 'conversions', targetValue: 25 },
        agents: [],
        tasks: [],
        pipeline: { id: 'gtm-pipeline', applied: true },
    },
};

/**
 * "Start a campaign" — the activation surface for the `campaign` Work
 * kind. One brief in; the API provisions Work + Goal + Agents + Tasks +
 * pipeline preference atomically.
 */
describe('CampaignFormClient', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        createCampaignWork.mockResolvedValue(OK);
    });

    it('lists what activation provisions so the brief is not a black box', () => {
        render(<CampaignFormClient />);
        const form = screen.getByTestId('campaign-brief-form');

        for (const key of ['work', 'goal', 'agents', 'tasks', 'pipeline']) {
            expect(form.textContent).toContain(`provisions.${key}`);
        }
    });

    it('keeps submit disabled until both name and objective are filled', async () => {
        const user = userEvent.setup();
        render(<CampaignFormClient />);

        const submit = screen.getByTestId('campaign-submit') as HTMLButtonElement;
        expect(submit.disabled).toBe(true);

        await user.type(screen.getByLabelText('nameLabel'), 'Q3 launch');
        expect((screen.getByTestId('campaign-submit') as HTMLButtonElement).disabled).toBe(true);

        await user.type(screen.getByLabelText('objectiveLabel'), 'Book 25 demos');
        expect((screen.getByTestId('campaign-submit') as HTMLButtonElement).disabled).toBe(false);
    });

    it('submits the brief, then routes to the new campaign Work', async () => {
        const user = userEvent.setup();
        render(<CampaignFormClient />);

        await user.type(screen.getByLabelText('nameLabel'), 'Q3 launch');
        await user.type(screen.getByLabelText('objectiveLabel'), 'Book 25 demos');
        await user.type(screen.getByLabelText('targetLabel'), '25');
        await user.type(screen.getByLabelText('targetUnitPlaceholder'), 'demos');
        await user.type(screen.getByLabelText('channelsLabel'), 'email, LinkedIn, email');
        await user.click(screen.getByTestId('campaign-submit'));

        expect(createCampaignWork).toHaveBeenCalledWith({
            name: 'Q3 launch',
            objective: 'Book 25 demos',
            target: { value: 25, unit: 'demos' },
            // Comma-separated, trimmed, de-duplicated.
            channels: ['email', 'LinkedIn'],
        });
        expect(toastSuccess).toHaveBeenCalledWith('success:{"name":"Q3 launch"}');
        expect(push).toHaveBeenCalledWith('/works/w1');
    });

    it('omits the target entirely when no positive value was entered', async () => {
        const user = userEvent.setup();
        render(<CampaignFormClient />);

        await user.type(screen.getByLabelText('nameLabel'), 'Q3 launch');
        await user.type(screen.getByLabelText('objectiveLabel'), 'Book demos');
        await user.click(screen.getByTestId('campaign-submit'));

        expect(createCampaignWork.mock.calls[0][0].target).toBeUndefined();
    });

    it('warns (but still navigates) when the pipeline preference could not be pinned', async () => {
        const user = userEvent.setup();
        createCampaignWork.mockResolvedValue({
            ...OK,
            campaign: {
                ...OK.campaign,
                pipeline: { id: 'gtm-pipeline', applied: false, reason: 'plugin not found' },
            },
        });
        render(<CampaignFormClient />);

        await user.type(screen.getByLabelText('nameLabel'), 'Q3 launch');
        await user.type(screen.getByLabelText('objectiveLabel'), 'Book demos');
        await user.click(screen.getByTestId('campaign-submit'));

        expect(toastWarning).toHaveBeenCalledWith('pipelineNotPinned');
        expect(push).toHaveBeenCalledWith('/works/w1');
    });

    it('surfaces an activation failure and stays on the form', async () => {
        const user = userEvent.setup();
        createCampaignWork.mockResolvedValue({ success: false, error: 'slug already taken' });
        render(<CampaignFormClient />);

        await user.type(screen.getByLabelText('nameLabel'), 'Q3 launch');
        await user.type(screen.getByLabelText('objectiveLabel'), 'Book demos');
        await user.click(screen.getByTestId('campaign-submit'));

        expect(toastError).toHaveBeenCalledWith('slug already taken');
        expect(push).not.toHaveBeenCalled();
    });
});

describe('parseChannels', () => {
    it('trims, drops blanks and de-duplicates case-insensitively', () => {
        expect(parseChannels(' email , LinkedIn ,, email,')).toEqual(['email', 'LinkedIn']);
    });

    it('caps the list at ten channels', () => {
        const many = Array.from({ length: 15 }, (_, i) => `ch${i}`).join(',');
        expect(parseChannels(many)).toHaveLength(10);
    });
});
