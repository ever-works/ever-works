// Short-circuit the transitive `@ever-works/agent/*` import chains so the
// test doesn't pull `@src/entities` (which only resolves inside apps/api)
// through the agent-package barrels. House pattern — mirrors
// work-runs.controller.spec.ts. The campaign catalog is re-declared here
// with the real shape so the preview assertions stay meaningful.
jest.mock('@ever-works/agent/campaigns', () => ({
    __esModule: true,
    CampaignActivationService: class {},
    CAMPAIGN_PIPELINE_ID: 'gtm-pipeline',
    CAMPAIGN_GOAL_METRIC_IDS: ['agents', 'open-tasks', 'conversions', 'days-active'],
    CAMPAIGN_GOAL_DEFAULTS: {
        metricId: 'conversions',
        comparator: 'gte',
        targetValue: 10,
        unit: 'conversions',
        window: 'month',
    },
    CAMPAIGN_SEED_STAGES: [
        { stageId: 'research', title: 'Research', description: 'collect' },
        { stageId: 'qualify', title: 'Qualify', description: 'score' },
    ],
    listCampaignAgentTemplates: () => [
        {
            slug: 'lead-researcher',
            name: 'Lead Researcher',
            title: 'Lead research',
            category: 'sales',
        },
    ],
}));
jest.mock('../auth', () => ({
    __esModule: true,
    AuthService: class {},
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { WorkCampaignsController } from './work-campaigns.controller';

/**
 * `POST /api/works/from-campaign-template` — the only path that mints a
 * `campaign` Work. The controller is deliberately thin: resolve the
 * authenticated user, hand the brief to the activation service. The
 * load-bearing assertions are that it resolves the ACTING user (never a
 * client-supplied id) and that the brief is forwarded verbatim.
 */
describe('WorkCampaignsController', () => {
    const auth = { userId: 'u1' } as never;
    const user = { id: 'u1', username: 'founder' };

    let authService: { getUser: jest.Mock };
    let activation: { activate: jest.Mock };
    let controller: WorkCampaignsController;

    beforeEach(() => {
        authService = { getUser: jest.fn().mockResolvedValue(user) };
        activation = {
            activate: jest.fn().mockResolvedValue({
                work: { id: 'w1', slug: 'q3-launch', name: 'Q3 launch', kind: 'campaign' },
                goal: { id: 'g1', title: 'Q3 launch', metricId: 'conversions', targetValue: 10 },
                agents: [],
                tasks: [],
                pipeline: { id: 'gtm-pipeline', applied: true },
            }),
        };
        controller = new WorkCampaignsController(authService as never, activation as never);
    });

    it('activates a brief for the ACTING user and returns the provisioning summary', async () => {
        const result = await controller.createFromCampaignTemplate(auth, {
            name: 'Q3 launch',
            objective: 'Book 25 demos',
            channels: ['email'],
        } as never);

        expect(authService.getUser).toHaveBeenCalledWith('u1');
        expect(activation.activate).toHaveBeenCalledWith(user, {
            name: 'Q3 launch',
            objective: 'Book 25 demos',
            slug: null,
            target: null,
            channels: ['email'],
        });
        expect(result.work.kind).toBe('campaign');
    });

    it('forwards an explicit slug and target instead of defaulting them', async () => {
        await controller.createFromCampaignTemplate(auth, {
            name: 'Q3 launch',
            objective: 'Book 25 demos',
            slug: 'q3-launch',
            target: { metricId: 'conversions', value: 25, unit: 'demos', window: 'month' },
        } as never);

        expect(activation.activate.mock.calls[0][1]).toMatchObject({
            slug: 'q3-launch',
            target: { metricId: 'conversions', value: 25, unit: 'demos', window: 'month' },
        });
    });

    it('previews what activation will provision (agents, stages, metric vocabulary)', () => {
        const preview = controller.getCampaignTemplate();

        expect(preview.pipelineId).toBe('gtm-pipeline');
        expect(preview.metricIds).toContain('conversions');
        expect(preview.defaults.metricId).toBe('conversions');
        expect(preview.agents).toEqual([
            {
                slug: 'lead-researcher',
                name: 'Lead Researcher',
                title: 'Lead research',
                category: 'sales',
            },
        ]);
        expect(preview.stages.map((s) => s.stageId)).toEqual(['research', 'qualify']);
    });

    it('does not touch the activation service just to render the preview', () => {
        controller.getCampaignTemplate();
        expect(activation.activate).not.toHaveBeenCalled();
        expect(authService.getUser).not.toHaveBeenCalled();
    });
});
