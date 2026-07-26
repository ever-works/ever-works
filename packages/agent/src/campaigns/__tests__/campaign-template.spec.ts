import { WORK_KINDS, WORK_KIND_CAPABILITIES, WORK_METRIC_IDS } from '@ever-works/contracts';
import { getAgentTemplate } from '../../agents/agent-templates';
import { TaskStatus } from '../../entities/task.entity';
import {
    CAMPAIGN_GOAL_DEFAULTS,
    CAMPAIGN_GOAL_METRIC_IDS,
    CAMPAIGN_PIPELINE_ID,
    CAMPAIGN_SEED_STAGES,
    CAMPAIGN_WORK_KIND,
    listCampaignAgentTemplates,
    listCampaignAgentTemplateSlugs,
} from '../campaign-template';

describe('campaign template catalog', () => {
    it('targets the shipped `campaign` Work kind', () => {
        expect(WORK_KINDS).toContain(CAMPAIGN_WORK_KIND);
        expect(WORK_KIND_CAPABILITIES[CAMPAIGN_WORK_KIND]).toBeDefined();
    });

    it('resolves the go-to-market agent templates from the prebuilt catalog', () => {
        const templates = listCampaignAgentTemplates();

        expect(templates.length).toBeGreaterThan(0);
        for (const template of templates) {
            // Every activated template must actually exist in the shipped
            // catalog (createFromTemplate 404s on an unknown slug).
            expect(getAgentTemplate(template.slug)).toBeDefined();
            expect(template.suggestedPipeline).toBe(CAMPAIGN_PIPELINE_ID);
        }
        expect(listCampaignAgentTemplateSlugs()).toEqual(templates.map((t) => t.slug));
        // The set is derived, never hand-listed: no duplicates.
        expect(new Set(listCampaignAgentTemplateSlugs()).size).toBe(templates.length);
    });

    it('draws its goal metric vocabulary from the campaign kind, not a new list', () => {
        expect(CAMPAIGN_GOAL_METRIC_IDS).toEqual(WORK_KIND_CAPABILITIES.campaign.metrics);
        for (const metricId of CAMPAIGN_GOAL_METRIC_IDS) {
            expect(WORK_METRIC_IDS).toContain(metricId);
        }
        expect(CAMPAIGN_GOAL_METRIC_IDS).toContain(CAMPAIGN_GOAL_DEFAULTS.metricId);
        expect(CAMPAIGN_GOAL_DEFAULTS.targetValue).toBeGreaterThan(0);
    });

    it('seeds the first gtm-pipeline stages up to and including the human review gate', () => {
        expect(CAMPAIGN_SEED_STAGES.map((stage) => stage.stageId)).toEqual([
            'research',
            'qualify',
            'draft',
            'review',
        ]);
        // The first stage is the only actionable one; the rest wait in the
        // backlog so the board reads as a pipeline, not a pile.
        expect(CAMPAIGN_SEED_STAGES[0].status).toBe(TaskStatus.TODO);
        for (const stage of CAMPAIGN_SEED_STAGES.slice(1)) {
            expect(stage.status).toBe(TaskStatus.BACKLOG);
        }
        for (const stage of CAMPAIGN_SEED_STAGES) {
            expect(stage.title.length).toBeGreaterThan(0);
            expect(stage.description.length).toBeGreaterThan(0);
        }
    });
});
