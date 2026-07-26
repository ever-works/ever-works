import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
    CampaignActivationService,
    CAMPAIGN_GOAL_DEFAULTS,
    CAMPAIGN_GOAL_METRIC_IDS,
    CAMPAIGN_PIPELINE_ID,
    CAMPAIGN_SEED_STAGES,
    listCampaignAgentTemplates,
    type CampaignActivationResult,
} from '@ever-works/agent/campaigns';
import { AuthService, AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { CreateCampaignWorkDto } from './dto/create-campaign-work.dto';

/** Shape returned by `GET /api/works/campaign-template`. */
interface CampaignTemplatePreview {
    pipelineId: string;
    metricIds: readonly string[];
    defaults: typeof CAMPAIGN_GOAL_DEFAULTS;
    agents: Array<{ slug: string; name: string; title: string; category: string }>;
    stages: Array<{ stageId: string; title: string; description: string }>;
}

/**
 * Campaign activation (roadmap 14.1 / audit G20).
 *
 * The `campaign` Work kind shipped with capabilities + metrics but nothing
 * minted one — it is deliberately absent from `USER_SELECTABLE_WORK_KINDS`,
 * so the general create path cannot produce it. These two routes are the
 * dedicated activation path:
 *
 *   - `GET  /api/works/campaign-template` — what activation will provision
 *     (agents, stages, metric vocabulary), so the UI can preview it;
 *   - `POST /api/works/from-campaign-template` — activate a brief.
 *
 * Kept in its own controller (the `WorkTemplatesController` / `KbController`
 * idiom) rather than bolted onto the 30-dependency `WorksController`.
 */
@ApiTags('Works')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(AuthSessionGuard)
export class WorkCampaignsController {
    constructor(
        private readonly authService: AuthService,
        private readonly campaignActivation: CampaignActivationService,
    ) {}

    @Get('works/campaign-template')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Preview the campaign template',
        description:
            'Returns the prebuilt go-to-market agents, the seeded pipeline stages and the metric vocabulary a campaign activation provisions.',
    })
    @ApiResponse({ status: 200, description: 'Campaign template preview' })
    getCampaignTemplate(): CampaignTemplatePreview {
        return {
            pipelineId: CAMPAIGN_PIPELINE_ID,
            metricIds: CAMPAIGN_GOAL_METRIC_IDS,
            defaults: CAMPAIGN_GOAL_DEFAULTS,
            agents: listCampaignAgentTemplates().map((template) => ({
                slug: template.slug,
                name: template.name,
                title: template.title,
                category: template.category,
            })),
            stages: CAMPAIGN_SEED_STAGES.map((stage) => ({
                stageId: stage.stageId,
                title: stage.title,
                description: stage.description,
            })),
        };
    }

    @Post('works/from-campaign-template')
    @HttpCode(HttpStatus.CREATED)
    // Activation writes a Work + a Goal + N agents + N tasks in one call,
    // so it carries the same per-IP envelope as the other create paths.
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Start a campaign',
        description:
            'Provisions a campaign Work from a brief: a Work of kind `campaign`, a Goal capturing the objective, the prebuilt go-to-market Agents, seeded Tasks for the first pipeline stages, and `gtm-pipeline` as the Work’s pipeline preference. Owner-scoped and atomic — a failure at any step removes everything it already created.',
    })
    @ApiResponse({ status: 201, description: 'Campaign activated' })
    @ApiResponse({ status: 400, description: 'Invalid brief' })
    @ApiResponse({ status: 409, description: 'Slug already taken' })
    async createFromCampaignTemplate(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() dto: CreateCampaignWorkDto,
    ): Promise<CampaignActivationResult> {
        const user = await this.authService.getUser(auth.userId);
        return this.campaignActivation.activate(user, {
            name: dto.name,
            objective: dto.objective,
            slug: dto.slug ?? null,
            target: dto.target ?? null,
            channels: dto.channels ?? null,
        });
    }
}
