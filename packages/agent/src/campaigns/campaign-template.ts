import { WORK_KIND_CAPABILITIES, type WorkMetricId } from '@ever-works/contracts';
import { TaskPriority, TaskStatus } from '../entities/task.entity';
import { listAgentTemplates, type AgentTemplate } from '../agents/agent-templates';

/**
 * Campaign activation catalog — the data half of "start a campaign".
 *
 * Everything here is a POINTER at something that already shipped:
 *
 *   - the Work kind (`campaign`) and its metric vocabulary come from
 *     `WORK_KIND_CAPABILITIES` in `@ever-works/contracts`;
 *   - the agents come from the prebuilt `AGENT_TEMPLATES` catalog —
 *     selected by the pipeline they already declare, never re-listed here;
 *   - the seed stages mirror the first four stages of the `gtm-pipeline`
 *     plugin (research → qualify → draft → review), i.e. everything up to
 *     and including the human gate that precedes any outbound action.
 *
 * No new concepts: the activation service turns this catalog into ordinary
 * Work / Goal / Agent / Task rows through the services that own them.
 */

/** Pipeline plugin a campaign Work runs on. */
export const CAMPAIGN_PIPELINE_ID = 'gtm-pipeline';

/** Work kind minted by campaign activation. */
export const CAMPAIGN_WORK_KIND = 'campaign';

/**
 * Metric-source namespace for a campaign Goal.
 *
 * The Goal's `metricSource.metricId` is drawn from the campaign kind's own
 * metric list (`WORK_KIND_CAPABILITIES.campaign.metrics`) so the Goal and
 * the Work's stat tiles speak the same vocabulary. Provider-backed metrics
 * (`conversions`) report `not_configured` until an analytics provider is
 * connected to the Work — which is exactly why the Goal is created in
 * DRAFT and only becomes evaluable once the user activates it.
 */
export const CAMPAIGN_GOAL_METRIC_PLUGIN_ID = 'work-metrics';

/** Metric ids a campaign Goal may target — the campaign kind's own set. */
export const CAMPAIGN_GOAL_METRIC_IDS: readonly WorkMetricId[] =
    WORK_KIND_CAPABILITIES.campaign.metrics;

/** Default target when the brief does not carry one. */
export const CAMPAIGN_GOAL_DEFAULTS = {
    metricId: 'conversions' as WorkMetricId,
    comparator: 'gte' as const,
    targetValue: 10,
    unit: 'conversions',
    window: 'month' as const,
};

/** One seeded Task, pinned to a `gtm-pipeline` stage id. */
export interface CampaignSeedStage {
    /** Stage id in the `gtm-pipeline` plugin. */
    readonly stageId: string;
    /** Task title (the campaign name is appended by the activation service). */
    readonly title: string;
    readonly description: string;
    readonly priority: TaskPriority;
    readonly status: TaskStatus;
}

/**
 * The first `gtm-pipeline` stages, seeded as Tasks so a fresh campaign has
 * a runnable board instead of an empty one. Stops at `review` — the human
 * gate before anything goes out (`act` and beyond are queued by the
 * pipeline once drafts are approved).
 */
export const CAMPAIGN_SEED_STAGES: readonly CampaignSeedStage[] = [
    {
        stageId: 'research',
        title: 'Research: collect seed contacts and market signals',
        description:
            'Collect the seed contact list and the fresh market signals the campaign will work from. Output feeds the qualify stage.',
        priority: TaskPriority.P1,
        status: TaskStatus.TODO,
    },
    {
        stageId: 'qualify',
        title: 'Qualify: score and risk-filter the collected contacts',
        description:
            'Deterministic-first scoring plus risk filtering over the researched contacts, so drafting only runs against contacts worth contacting.',
        priority: TaskPriority.P2,
        status: TaskStatus.BACKLOG,
    },
    {
        stageId: 'draft',
        title: 'Draft: write the campaign messaging',
        description:
            'Personalized drafting for the campaign channels and tone. Drafts are staged for review — nothing is sent from this stage.',
        priority: TaskPriority.P2,
        status: TaskStatus.BACKLOG,
    },
    {
        stageId: 'review',
        title: 'Review: approve drafts before anything goes out',
        description:
            'The human gate. Approve, edit or reject the drafts; only approved drafts are handed to the act stage for delivery.',
        priority: TaskPriority.P2,
        status: TaskStatus.BACKLOG,
    },
];

/**
 * The go-to-market agent templates activated with a campaign.
 *
 * Derived from the prebuilt catalog by the pipeline each template already
 * declares (`suggestedPipeline === 'gtm-pipeline'`), so adding a GTM
 * template to `agent-templates.ts` automatically ships it with the next
 * campaign — no second list to keep in sync.
 */
export function listCampaignAgentTemplates(): readonly AgentTemplate[] {
    return listAgentTemplates().filter(
        (template) => template.suggestedPipeline === CAMPAIGN_PIPELINE_ID,
    );
}

/** Slugs of the templates {@link listCampaignAgentTemplates} resolves. */
export function listCampaignAgentTemplateSlugs(): readonly string[] {
    return listCampaignAgentTemplates().map((template) => template.slug);
}
