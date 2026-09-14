import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    Param,
    ParseUUIDPipe,
    Put,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
    MODEL_POLICY_SCHEDULE_SOURCES,
    type ModelPolicyScheduleSource,
} from '@ever-works/contracts';
import {
    ModelPolicyService,
    type ModelPolicyTarget,
    type UpsertModelPolicyInput,
} from '@ever-works/agent/model-routing';
import { AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { UpsertModelPolicyDto } from './dto/upsert-model-policy.dto';
import { ModelWorkspaceAccessService } from './model-workspace-access.service';

/**
 * Model accounts (AW-16) — the model ladder at each scope.
 *
 *   GET|PUT|DELETE /api/model-policies/workspace
 *   GET|PUT|DELETE /api/model-policies/agent/:agentId
 *   GET|PUT|DELETE /api/model-policies/schedule/:source/:ownerId
 *   GET            /api/model-policies/resolved?agentId&scheduleId
 *
 * PUT changes only the fields present (null clears one back to inheriting);
 * DELETE returns a scope to inheriting. An Agent's primary model IS the
 * Agent's own provider/model pair — the same columns its settings page
 * writes — so this surface and that one can never disagree.
 *
 * `resolved` answers "what would a call use here, and which scope chose
 * each field" — the one read that powers "you are overriding X".
 */
@ApiTags('Model policies')
@Controller('api/model-policies')
@UseGuards(AuthSessionGuard)
@ApiBearerAuth('JWT-auth')
export class ModelPoliciesController {
    constructor(
        private readonly policies: ModelPolicyService,
        private readonly access: ModelWorkspaceAccessService,
    ) {}

    @Get('workspace')
    @ApiOperation({ summary: "The workspace's model defaults, or null when none are set" })
    async getWorkspace(@CurrentUser() auth: AuthenticatedUser) {
        const scope = await this.access.resolve(auth.userId, 'read');
        return { policy: await this.policies.get(scope, { type: 'workspace' }) };
    }

    @Put('workspace')
    @ApiOperation({ summary: "Change the workspace's model defaults" })
    @ApiResponse({
        status: 200,
        description: 'The stored policy, plus any fallback the new primary displaced.',
    })
    async putWorkspace(@CurrentUser() auth: AuthenticatedUser, @Body() body: UpsertModelPolicyDto) {
        const scope = await this.access.resolve(auth.userId, 'write');
        return this.policies.put(scope, { type: 'workspace' }, toInput(body));
    }

    @Delete('workspace')
    @ApiOperation({
        summary: "Clear the workspace's model defaults; providers' own settings answer again",
    })
    async deleteWorkspace(@CurrentUser() auth: AuthenticatedUser) {
        const scope = await this.access.resolve(auth.userId, 'write');
        await this.policies.remove(scope, { type: 'workspace' });
        return { ok: true };
    }

    @Get('agent/:agentId')
    @ApiOperation({
        summary: "An Agent's own model choice, fallbacks and effort, or null when it inherits",
    })
    async getAgent(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('agentId', ParseUUIDPipe) agentId: string,
    ) {
        const scope = await this.access.resolve(auth.userId, 'read');
        return { policy: await this.policies.get(scope, { type: 'agent', agentId }) };
    }

    @Put('agent/:agentId')
    @ApiOperation({ summary: "Change an Agent's model choice, fallbacks or effort" })
    async putAgent(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('agentId', ParseUUIDPipe) agentId: string,
        @Body() body: UpsertModelPolicyDto,
    ) {
        const scope = await this.access.resolve(auth.userId, 'write');
        return this.policies.put(scope, { type: 'agent', agentId }, toInput(body));
    }

    @Delete('agent/:agentId')
    @ApiOperation({ summary: 'Return an Agent to the workspace default' })
    async deleteAgent(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('agentId', ParseUUIDPipe) agentId: string,
    ) {
        const scope = await this.access.resolve(auth.userId, 'write');
        await this.policies.remove(scope, { type: 'agent', agentId });
        return { ok: true };
    }

    @Get('schedule/:source/:ownerId')
    @ApiOperation({
        summary: "A schedule's own model choice, or null when it inherits from its Agent",
    })
    async getSchedule(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('source') source: string,
        @Param('ownerId', ParseUUIDPipe) ownerId: string,
    ) {
        const scope = await this.access.resolve(auth.userId, 'read');
        return { policy: await this.policies.get(scope, scheduleTarget(source, ownerId)) };
    }

    @Put('schedule/:source/:ownerId')
    @ApiOperation({ summary: "Change a schedule's model, effort or run timeout" })
    async putSchedule(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('source') source: string,
        @Param('ownerId', ParseUUIDPipe) ownerId: string,
        @Body() body: UpsertModelPolicyDto,
    ) {
        const scope = await this.access.resolve(auth.userId, 'write');
        return this.policies.put(scope, scheduleTarget(source, ownerId), toInput(body));
    }

    @Delete('schedule/:source/:ownerId')
    @ApiOperation({ summary: 'Return a schedule to inheriting from its Agent' })
    async deleteSchedule(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('source') source: string,
        @Param('ownerId', ParseUUIDPipe) ownerId: string,
    ) {
        const scope = await this.access.resolve(auth.userId, 'write');
        await this.policies.remove(scope, scheduleTarget(source, ownerId));
        return { ok: true };
    }

    @Get('resolved')
    @ApiOperation({
        summary:
            'The model, fallbacks, effort and timeouts a call would use here, with the scope each one came from',
    })
    async resolved(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('agentId') agentId?: string,
        @Query('scheduleId') scheduleId?: string,
    ) {
        const scope = await this.access.resolve(auth.userId, 'read');
        return {
            resolved: await this.policies.resolve(scope, {
                agentId: agentId || null,
                scheduleId: scheduleId || null,
            }),
        };
    }
}

function scheduleTarget(source: string, ownerId: string): ModelPolicyTarget {
    if (!(MODEL_POLICY_SCHEDULE_SOURCES as readonly string[]).includes(source)) {
        throw new BadRequestException({ code: 'invalid_policy', message: 'Unknown schedule.' });
    }
    return { type: 'schedule', source: source as ModelPolicyScheduleSource, ownerId };
}

/** Copy only the fields the body actually carries, so absent stays "leave as stored". */
function toInput(body: UpsertModelPolicyDto): UpsertModelPolicyInput {
    const input: UpsertModelPolicyInput = {};
    if (body.primaryModel !== undefined) {
        input.primaryModel = body.primaryModel
            ? {
                  providerPluginId: body.primaryModel.providerPluginId ?? null,
                  modelId: body.primaryModel.modelId ?? null,
              }
            : null;
    }
    if (body.fallbackModels !== undefined) {
        input.fallbackModels = body.fallbackModels
            ? body.fallbackModels.map((entry) => ({
                  providerPluginId: entry.providerPluginId,
                  modelId: entry.modelId,
              }))
            : null;
    }
    if (body.reasoningEffort !== undefined) input.reasoningEffort = body.reasoningEffort;
    if (body.runTimeoutSeconds !== undefined) input.runTimeoutSeconds = body.runTimeoutSeconds;
    if (body.attemptTimeoutSeconds !== undefined) {
        input.attemptTimeoutSeconds = body.attemptTimeoutSeconds;
    }
    return input;
}
