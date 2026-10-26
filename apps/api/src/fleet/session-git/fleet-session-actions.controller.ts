import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Put,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    FleetAgentActionTemplatesService,
    FleetSessionActionService,
    type FleetSessionActor,
} from '@ever-works/agent/fleet';
import type {
    FleetAgentActionTemplates,
    FleetSessionActionLedgerResponse,
    FleetSessionActionSendResponse,
    FleetSessionActionsResponse,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetSessionsEnabledGuard } from '../sessions/fleet-sessions-enabled.guard';
import {
    ResendFleetSessionActionDto,
    SendFleetSessionActionDto,
    UpdateFleetAgentActionTemplatesDto,
} from './dto/fleet-session-git.dto';

function actorOf(auth: AuthenticatedUser): FleetSessionActor {
    return { userId: auth.userId };
}

/**
 * Session git & actions (FL-06 P2, plan §5, CONTRACTS §11.2) — the Actions
 * menu: what a session offers, sending one (typed into the session as owner
 * input, never bypassing the agent's own permission prompts), the ledger of
 * what was sent, and a resend for one that was not delivered. Dark unless
 * `FLEET_SESSIONS_ENABLED` (404). A run token (`ew_run_…`) never reaches these
 * routes (the run-token allow-list does not name them).
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetSessionsEnabledGuard)
export class FleetSessionActionsController {
    constructor(
        private readonly actions: FleetSessionActionService,
        private readonly templates: FleetAgentActionTemplatesService,
    ) {}

    @Get('agents/:agentId/action-templates')
    @ApiOperation({
        summary:
            'An Agent’s own Fleet action templates and branch prefix, from its agent.yml, each beside the platform default (the instructions editor’s Fleet actions section).',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async readTemplates(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('agentId', ParseUUIDPipe) agentId: string,
    ): Promise<FleetAgentActionTemplates> {
        return this.templates.read(agentId, auth.userId);
    }

    @Put('agents/:agentId/action-templates')
    @ApiOperation({
        summary:
            'Save an Agent’s Fleet action templates and branch prefix into its agent.yml (the rest of the file is kept; an empty template falls back to the default). A concurrent edit is refused with the etag, never overwritten.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async writeTemplates(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('agentId', ParseUUIDPipe) agentId: string,
        @Body() body: UpdateFleetAgentActionTemplatesDto,
    ): Promise<FleetAgentActionTemplates> {
        return this.templates.write(agentId, auth.userId, {
            ...(body.branchPrefix !== undefined ? { branchPrefix: body.branchPrefix } : {}),
            ...(body.actions ? { actions: body.actions } : {}),
            ...(body.expectedHash !== undefined ? { expectedHash: body.expectedHash } : {}),
        });
    }

    @Get('sessions/:id/actions')
    @ApiOperation({
        summary:
            'The seven actions of a session — Commit, Commit and push, Open (or Update) the pull request, Review the changes, Fix the review comments, Resolve conflicts, Write a recap — each with whether it is offered and why not, and its rendered prompt (the Agent’s own template or the default).',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetSessionActionsResponse> {
        return this.actions.list(id, actorOf(auth));
    }

    @Post('sessions/:id/actions')
    @ApiOperation({
        summary:
            'Send an action: its prompt (as shown and edited) is typed into the session as your input. Refused when the action is not offered (`invalid`, the rule named), within 2 s of the last one (`busy`), past 10 a minute (`limit_exceeded`), under the kill switch, or while the computer is offline. A send the computer could not confirm answers `delivery: undelivered` and may be re-sent.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async send(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: SendFleetSessionActionDto,
    ): Promise<FleetSessionActionSendResponse> {
        return this.actions.send(id, actorOf(auth), { actionId: body.actionId, prompt: body.prompt });
    }

    @Get('sessions/:id/actions/ledger')
    @ApiOperation({
        summary:
            'The actions sent to a session, newest first: when, which, by whom, delivered or not, the pull request it produced, and its tokens and cost once the usage scan attributed them (an owner session shows its session total only).',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async ledger(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetSessionActionLedgerResponse> {
        return this.actions.ledger(id, actorOf(auth));
    }

    @Post('sessions/:id/actions/:ledgerId/resend')
    @ApiOperation({
        summary:
            'Send again an action that was NOT delivered (never one the computer confirmed). The prompt is the one given, else the action’s template rendered afresh.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async resend(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('ledgerId', ParseUUIDPipe) ledgerId: string,
        @Body() body: ResendFleetSessionActionDto,
    ): Promise<FleetSessionActionSendResponse> {
        return this.actions.resend(id, ledgerId, actorOf(auth), body?.prompt);
    }
}
