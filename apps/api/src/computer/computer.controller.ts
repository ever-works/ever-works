import {
    Body,
    ConflictException,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    HttpCode,
    HttpException,
    HttpStatus,
    NotFoundException,
    Optional,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    ServiceUnavailableException,
    UnprocessableEntityException,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type {
    ComputerControlStateView,
    ComputerNodeOption,
    ComputerSessionView,
    NodeAgentProfileView,
} from '@ever-works/contracts';
import { AgentsService } from '@ever-works/agent/agents';
import {
    ComputerControlArbiter,
    ComputerSessionService,
    NodeAgentProfileService,
    type ComputerAgentRef,
    type ComputerControlOutcome,
    type OpenComputerSessionRefusal,
    type ResetNodeAgentProfileOutcome,
} from '@ever-works/agent/computer';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { FleetEnabledGuard } from '../fleet/guards/fleet-enabled.guard';
import {
    ComputerAttachService,
    resolveRequestedComputerRole,
    wantsComputerControlRole,
    type ComputerMintedRole,
} from './computer-attach.service';
import { ComputerRelayRegistry, type ComputerSessionRelayStatus } from './computer-relay.registry';
import { COMPUTER_WS_PATH_PREFIX } from './computer-ws.service';
import {
    AnswerComputerControlRequestDto,
    ComputerControlDto,
    OpenComputerSessionDto,
    ResetNodeAgentProfileDto,
    UpdateComputerSessionDto,
} from './dto/computer.dto';

/** A session as the owner's surface reads it: the persisted row plus this replica's live relay view. */
export type ComputerSessionResponse = ComputerSessionView & { live: ComputerSessionRelayStatus };

/**
 * Agent computers — the owner-facing live-view endpoints, nested under the
 * Agent the computer belongs to.
 *
 * Authorization mirrors the terminal attach controller: Agent ownership
 * through `AgentsService.getOne` first, then owner-scoped lookups for the
 * session, the machine and the profile. Another owner's Agent, session or
 * machine answers exactly like one that does not exist.
 *
 * Opening a view never touches a Run. Every refusal names its reason in the
 * body (`reason`), so the surface can say the one thing the owner must fix:
 *
 *   409  the fleet is stopped, the machine cannot be watched, no machines
 *   422  a requested channel the machine cannot serve (names the channel)
 *   429  the per-machine or per-Organization live-view cap (names the views)
 *   503  no fleet runtime wired on this install
 *
 * Taking control (`…/sessions/:sessionId/control`) answers the same way: 403
 * when the machine's control policy leaves the person out (naming the
 * policy), 409 when someone else holds control (naming the holder) or the
 * act does not fit the moment (naming why), and the control state in the
 * body of every answer so the surface never has to guess.
 *
 * The whole surface disappears with `FLEET_ENABLED=false`, like the fleet's.
 */
@ApiTags('agent-computer')
@Controller('api/agents/:id/computer')
@UseGuards(FleetEnabledGuard)
export class ComputerController {
    constructor(
        private readonly agents: AgentsService,
        private readonly sessions: ComputerSessionService,
        private readonly profiles: NodeAgentProfileService,
        private readonly attach: ComputerAttachService,
        private readonly relay: ComputerRelayRegistry,
        // Appended LAST + @Optional(): without the arbiter a live view is
        // watch-only — every control route answers 503 and no driving token
        // is ever minted.
        @Optional() private readonly control?: ComputerControlArbiter,
    ) {}

    @Get('nodes')
    @ApiOperation({
        summary:
            'Every machine the owner has, ordered for the picker (the Agent’s pinned machine first), each with the channels it can serve and, when it cannot be watched, why.',
    })
    @HttpCode(HttpStatus.OK)
    async listNodes(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) agentId: string,
    ): Promise<ComputerNodeOption[]> {
        const agent = await this.resolveAgent(auth.userId, agentId);
        return this.sessions.listNodeOptions(auth.userId, agent);
    }

    @Post('sessions')
    @ApiOperation({
        summary:
            'Open a live view of the Agent’s computer. Returns at once with the session id; pictures follow over the live-view socket. Never pauses or steers a Run.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async openSession(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) agentId: string,
        @Body() body: OpenComputerSessionDto,
    ): Promise<{
        sessionId: string;
        status: ComputerSessionView['status'];
        session: ComputerSessionView;
    }> {
        const agent = await this.resolveAgent(auth.userId, agentId);
        const outcome = await this.sessions.open({
            userId: auth.userId,
            agent,
            nodeId: body?.nodeId ?? null,
            channels: body?.channels ?? null,
            quality: body?.quality ?? null,
        });
        if ('opened' in outcome) {
            return {
                sessionId: outcome.opened.id,
                status: outcome.opened.status,
                session: outcome.opened,
            };
        }
        throw toRefusalException(outcome);
    }

    @Get('sessions/:sessionId')
    @ApiOperation({
        summary: 'One live view — the persisted session merged with this replica’s relay status.',
    })
    @HttpCode(HttpStatus.OK)
    async getSession(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) agentId: string,
        @Param('sessionId', ParseUUIDPipe) sessionId: string,
    ): Promise<ComputerSessionResponse> {
        await this.resolveAgent(auth.userId, agentId);
        const view = await this.sessions.getForOwner(auth.userId, agentId, sessionId);
        if (!view) throw sessionNotFound(sessionId);
        return { ...view, live: this.relay.getStatus(sessionId) };
    }

    @Patch('sessions/:sessionId')
    @ApiOperation({
        summary: 'Change the quality or the active channel of an unfinished live view.',
    })
    @HttpCode(HttpStatus.OK)
    async updateSession(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) agentId: string,
        @Param('sessionId', ParseUUIDPipe) sessionId: string,
        @Body() body: UpdateComputerSessionDto,
    ): Promise<ComputerSessionView> {
        await this.resolveAgent(auth.userId, agentId);
        const view = await this.sessions.updateForOwner(auth.userId, agentId, sessionId, {
            quality: body?.quality,
            activeChannel: body?.activeChannel,
        });
        if (!view) throw sessionNotFound(sessionId);
        if (body?.quality && view.status !== 'ended') {
            this.relay.deliverToNode(sessionId, { kind: 'quality', quality: view.quality });
        }
        return view;
    }

    @Delete('sessions/:sessionId')
    @ApiOperation({ summary: 'End a live view. Idempotent.' })
    @HttpCode(HttpStatus.NO_CONTENT)
    async closeSession(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) agentId: string,
        @Param('sessionId', ParseUUIDPipe) sessionId: string,
    ): Promise<void> {
        await this.resolveAgent(auth.userId, agentId);
        if (!(await this.sessions.closeForOwner(auth.userId, agentId, sessionId))) {
            throw sessionNotFound(sessionId);
        }
    }

    /**
     * Mint a short-lived token for the live-view socket. Present it in the
     * FIRST WebSocket message, never in the URL. A browser is minted `viewer`
     * unless it asks for `controller` AND its view holds control of the
     * machine right now, in which case it is minted `driver`: a request can
     * downgrade itself, never upgrade past what the arbiter says it holds.
     */
    @Post('sessions/:sessionId/attach-token')
    @ApiOperation({
        summary:
            'Mint a short-lived attach token for this live view’s socket (first frame, never the URL).',
    })
    @ApiQuery({ name: 'role', required: false, enum: ['viewer', 'controller'] })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async mintAttachToken(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) agentId: string,
        @Param('sessionId', ParseUUIDPipe) sessionId: string,
        @Query('role') requestedRole?: string,
    ): Promise<{
        token: string;
        wsPath: string;
        role: ComputerMintedRole;
        expiresInSec: number;
    }> {
        await this.resolveAgent(auth.userId, agentId);
        const view = await this.sessions.getForOwner(auth.userId, agentId, sessionId);
        if (!view) throw sessionNotFound(sessionId);
        let role: ComputerMintedRole = resolveRequestedComputerRole(requestedRole);
        if (wantsComputerControlRole(requestedRole) && this.control && view.status !== 'ended') {
            if ((await this.control.holdOf(sessionId)).held) role = 'driver';
        }
        const { token, expiresInSec } = this.attach.mint({ userId: auth.userId, sessionId, role });
        return { token, wsPath: `${COMPUTER_WS_PATH_PREFIX}${sessionId}`, role, expiresInSec };
    }

    @Post('sessions/:sessionId/refresh')
    @ApiOperation({ summary: 'Ask the machine for a full picture now.' })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async refresh(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) agentId: string,
        @Param('sessionId', ParseUUIDPipe) sessionId: string,
    ): Promise<{ requested: boolean }> {
        await this.resolveAgent(auth.userId, agentId);
        const view = await this.sessions.getForOwner(auth.userId, agentId, sessionId);
        if (!view) throw sessionNotFound(sessionId);
        if (view.status === 'ended') {
            throw new ConflictException({
                message: 'This live view has ended.',
                reason: 'session-ended',
            });
        }
        return { requested: this.relay.deliverToNode(sessionId, { kind: 'refresh' }) };
    }

    @Get('sessions/:sessionId/control')
    @ApiOperation({
        summary:
            'Control of the machine as this live view sees it: who holds it, until when, and any pending request.',
    })
    @HttpCode(HttpStatus.OK)
    async getControl(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) agentId: string,
        @Param('sessionId', ParseUUIDPipe) sessionId: string,
    ): Promise<ComputerControlStateView> {
        await this.resolveAgent(auth.userId, agentId);
        const state = await this.requireControl().getState({
            userId: auth.userId,
            agentId,
            sessionId,
        });
        if (!state) throw sessionNotFound(sessionId);
        return state;
    }

    @Post('sessions/:sessionId/control')
    @ApiOperation({
        summary:
            'Take control of the machine from this live view (the Agent’s own input pauses), or — with `request: true` — ask whoever holds it to hand it over.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async takeControl(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) agentId: string,
        @Param('sessionId', ParseUUIDPipe) sessionId: string,
        @Body() body: ComputerControlDto,
    ): Promise<ComputerControlStateView> {
        await this.resolveAgent(auth.userId, agentId);
        const actor = { userId: auth.userId, agentId, sessionId };
        const control = this.requireControl();
        const outcome = body?.request ? await control.request(actor) : await control.take(actor);
        return controlStateOrThrow(outcome, sessionId);
    }

    @Delete('sessions/:sessionId/control')
    @ApiOperation({
        summary:
            'Give control back from this live view; the Agent’s own input resumes. Idempotent.',
    })
    @HttpCode(HttpStatus.NO_CONTENT)
    async giveBackControl(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) agentId: string,
        @Param('sessionId', ParseUUIDPipe) sessionId: string,
    ): Promise<void> {
        await this.resolveAgent(auth.userId, agentId);
        const outcome = await this.requireControl().giveBack({
            userId: auth.userId,
            agentId,
            sessionId,
        });
        controlStateOrThrow(outcome, sessionId);
    }

    @Post('sessions/:sessionId/control/handover')
    @ApiOperation({
        summary:
            'The view holding control answers a request: hand control over to it, or keep control.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async answerControlRequest(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) agentId: string,
        @Param('sessionId', ParseUUIDPipe) sessionId: string,
        @Body() body: AnswerComputerControlRequestDto,
    ): Promise<ComputerControlStateView> {
        await this.resolveAgent(auth.userId, agentId);
        const outcome = await this.requireControl().answer(
            { userId: auth.userId, agentId, sessionId },
            body.requestId,
            body.decision,
        );
        return controlStateOrThrow(outcome, sessionId);
    }

    @Post('sessions/:sessionId/control/keep')
    @ApiOperation({
        summary: 'Keep control: push back the automatic give-back after inactivity.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async keepControl(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) agentId: string,
        @Param('sessionId', ParseUUIDPipe) sessionId: string,
    ): Promise<ComputerControlStateView> {
        await this.resolveAgent(auth.userId, agentId);
        const outcome = await this.requireControl().keep({
            userId: auth.userId,
            agentId,
            sessionId,
        });
        return controlStateOrThrow(outcome, sessionId);
    }

    @Post('sessions/:sessionId/control/extend')
    @ApiOperation({
        summary: 'Extend the current stretch of control by one more stretch. Once per stretch.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 20, ttl: 60_000 } })
    async extendControl(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) agentId: string,
        @Param('sessionId', ParseUUIDPipe) sessionId: string,
    ): Promise<ComputerControlStateView> {
        await this.resolveAgent(auth.userId, agentId);
        const outcome = await this.requireControl().extend({
            userId: auth.userId,
            agentId,
            sessionId,
        });
        return controlStateOrThrow(outcome, sessionId);
    }

    @Get('profile')
    @ApiOperation({
        summary: 'The Agent’s own logins and files on one machine (never a path, never the key).',
    })
    @ApiQuery({ name: 'nodeId', required: true })
    @HttpCode(HttpStatus.OK)
    async getProfile(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) agentId: string,
        @Query('nodeId', ParseUUIDPipe) nodeId: string,
    ): Promise<NodeAgentProfileView> {
        await this.resolveAgent(auth.userId, agentId);
        const view = await this.profiles.getView(auth.userId, nodeId, agentId);
        if (!view) {
            throw new NotFoundException({
                message: 'No profile for this Agent on that computer yet.',
                reason: 'profile-not-found',
            });
        }
        return view;
    }

    @Post('profile/reset')
    @ApiOperation({
        summary:
            'Reset the Agent’s logins and files on one machine. Requires the Agent’s name; refused while the Agent is working on that machine. Touches no other Agent.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    async resetProfile(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) agentId: string,
        @Body() body: ResetNodeAgentProfileDto,
    ): Promise<NodeAgentProfileView> {
        const agent = await this.resolveAgent(auth.userId, agentId);
        const outcome = await this.profiles.reset({
            userId: auth.userId,
            agent,
            nodeId: body.nodeId,
            confirmAgentName: body.confirmAgentName,
        });
        if ('reset' in outcome) return outcome.reset;
        throw toResetRefusalException(outcome);
    }

    private requireControl(): ComputerControlArbiter {
        if (!this.control) {
            throw new ServiceUnavailableException({
                message: 'Taking control is not available on this install.',
                reason: 'control-unavailable',
            });
        }
        return this.control;
    }

    /** Agent ownership first — a foreign or unknown Agent 404s through the service. */
    private async resolveAgent(userId: string, agentId: string): Promise<ComputerAgentRef> {
        const agent = await this.agents.getOne(userId, agentId);
        return {
            id: agent.id,
            name: agent.name,
            organizationId: agent.organizationId ?? null,
        };
    }
}

function sessionNotFound(sessionId: string): NotFoundException {
    return new NotFoundException(`Computer session ${sessionId} not found.`);
}

/** Map a typed open refusal to its status, always naming the reason. */
export function toRefusalException(refusal: OpenComputerSessionRefusal): HttpException {
    switch (refusal.refused) {
        case 'stopped':
            return new ConflictException({
                message: refusal.stop?.reason
                    ? `All computers are stopped — "${refusal.stop.reason}". Live views are closed while the stop is in force.`
                    : 'All computers are stopped. Live views are closed while the stop is in force.',
                reason: 'stopped',
                stop: refusal.stop,
            });
        case 'no-nodes':
            return new ConflictException({
                message: 'This account has no computers yet. Add one to watch an Agent work.',
                reason: 'no-nodes',
            });
        case 'node-not-found':
            return new NotFoundException({
                message: 'Computer not found.',
                reason: 'node-not-found',
            });
        case 'node-unwatchable':
            return new ConflictException({
                message: `This computer cannot be watched right now: ${refusal.reason}.`,
                reason: refusal.reason,
                nodeId: refusal.nodeId,
            });
        case 'channel-unavailable':
            return new UnprocessableEntityException({
                message: `This computer cannot serve the ${refusal.channel} channel: ${refusal.reason}.`,
                reason: refusal.reason,
                channel: refusal.channel,
                nodeId: refusal.nodeId,
            });
        case 'node-session-cap':
        case 'organization-session-cap':
            return new HttpException(
                {
                    message:
                        refusal.refused === 'node-session-cap'
                            ? `This computer already has ${refusal.limit} live views. Close one to open another.`
                            : `This Organization already has ${refusal.limit} live views. Close one to open another.`,
                    reason: refusal.refused,
                    limit: refusal.limit,
                    sessions: refusal.sessions,
                },
                HttpStatus.TOO_MANY_REQUESTS,
            );
        case 'dispatcher-unavailable':
        default:
            return new ServiceUnavailableException({
                message: 'Live views are unavailable on this install — no fleet runtime is wired.',
                reason: 'dispatcher-unavailable',
            });
    }
}

/**
 * The control state of an outcome, or its refusal as an exception that names
 * the reason and carries the state (so a 409 for `held` says who holds it).
 */
export function controlStateOrThrow(
    outcome: ComputerControlOutcome | null,
    sessionId: string,
): ComputerControlStateView {
    if (!outcome) throw sessionNotFound(sessionId);
    if (!('refused' in outcome)) return outcome.state;
    const { refused, state } = outcome;
    switch (refused) {
        case 'policy':
            return throwIt(
                new ForbiddenException({
                    message:
                        state.policy === 'owner'
                            ? 'Only the owner of this computer can take control.'
                            : `This computer’s control policy (${state.policy}) does not include you.`,
                    reason: 'policy',
                    policy: state.policy,
                    state,
                }),
            );
        case 'held':
            return throwIt(
                new ConflictException({
                    message: 'Someone else has control of this computer.',
                    reason: 'held',
                    holder: state.holder,
                    state,
                }),
            );
        default:
            return throwIt(
                new ConflictException({
                    message: CONTROL_REFUSAL_MESSAGES[refused],
                    reason: refused,
                    state,
                }),
            );
    }
}

const CONTROL_REFUSAL_MESSAGES: Record<
    Exclude<Extract<ComputerControlOutcome, { refused: unknown }>['refused'], 'policy' | 'held'>,
    string
> = {
    'not-live': 'This live view is not showing the computer yet.',
    'session-ended': 'This live view has ended.',
    'not-holder': 'This live view does not have control of the computer.',
    'not-held': 'Nobody has control of this computer — take it instead.',
    'already-requested': 'Someone has already asked for control. Try again in a minute.',
    'no-request': 'That request for control is no longer waiting for an answer.',
    'already-extended': 'This stretch of control has already been extended once.',
};

function throwIt(error: HttpException): never {
    throw error;
}

/** Map a typed reset refusal to its status, always naming the reason. */
export function toResetRefusalException(
    refusal: Exclude<ResetNodeAgentProfileOutcome, { reset: unknown }>,
): HttpException {
    switch (refusal.refused) {
        case 'name-mismatch':
            return new UnprocessableEntityException({
                message: 'Type the Agent’s name exactly to confirm the reset.',
                reason: 'name-mismatch',
            });
        case 'run-live':
            return new ConflictException({
                message:
                    'The Agent is working on this computer right now. Pause it or wait for the run to finish.',
                reason: 'run-live',
            });
        case 'node-not-found':
            return new NotFoundException({
                message: 'Computer not found.',
                reason: 'node-not-found',
            });
        case 'profile-not-found':
        default:
            return new NotFoundException({
                message: 'No profile for this Agent on that computer yet.',
                reason: 'profile-not-found',
            });
    }
}
