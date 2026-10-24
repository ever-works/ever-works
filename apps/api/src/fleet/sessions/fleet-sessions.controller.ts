import {
    BadRequestException,
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Optional,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    Res,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    FleetSessionGitService,
    FleetSessionService,
    type FleetSessionActor,
    type FleetSessionListQuery,
} from '@ever-works/agent/fleet';
import {
    FLEET_SESSION_ANSWERS_PER_MINUTE,
    FLEET_SESSION_ATTACHES_PER_MINUTE,
    FLEET_SESSION_STARTS_PER_MINUTE,
    isFleetSessionLive,
    type FleetSessionAnswerResponse,
    type FleetSessionBranchProposal,
    type FleetSessionBoardResponse,
    type FleetSessionAttachTokenResponse,
    type FleetSessionRecordingManifest,
    type FleetSessionRecordingPage,
    type FleetSessionListResponse,
    type FleetSessionView,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import {
    AnswerFleetSessionDto,
    EndFleetSessionDto,
    FleetSessionAttachTokenDto,
    FleetSessionRecordingDto,
    FleetSessionRecordingQueryDto,
    ListFleetSessionsQueryDto,
    PatchFleetSessionDto,
    RestartFleetSessionDto,
    StartFleetSessionDto,
} from './dto/fleet-session.dto';
import { FleetSessionBranchProposalQueryDto } from '../session-git/dto/fleet-session-git.dto';
import { FleetSessionsEnabledGuard } from './fleet-sessions-enabled.guard';
import { FleetSessionAttachService } from './fleet-session-attach.service';
import { FleetSessionPresenceService } from './fleet-session-presence.service';
import { FleetSessionRecordingService } from './fleet-session-recording.service';
import { FleetConfirmationInterceptor } from '../tools/fleet-confirmation.interceptor';

function actorOf(auth: AuthenticatedUser): FleetSessionActor {
    return { userId: auth.userId };
}

function listQuery(query: ListFleetSessionsQueryDto): FleetSessionListQuery {
    const out: FleetSessionListQuery = {};
    if (query.state) out.state = query.state;
    if (query.kind) out.kind = query.kind;
    if (query.agentId) out.agentId = query.agentId;
    if (query.taskId) out.taskId = query.taskId;
    if (query.limit !== undefined) out.limit = query.limit;
    if (query.cursor) out.cursor = query.cursor;
    if (query.since) {
        const since = new Date(query.since);
        if (!Number.isNaN(since.getTime())) out.since = since;
    }
    return out;
}

/**
 * Sessions on computers (FL-04, plan §5, CONTRACTS §11.2) — the REST surface
 * over `FleetSessionService`, the one writer of `fleet_sessions`.
 *
 * Gates, in order: `FleetEnabledGuard` (the whole fleet), then
 * `FleetSessionsEnabledGuard` (`FLEET_SESSIONS_ENABLED`, default off; 404),
 * then the session global auth guard (no route here is public), then the
 * service's own chain for every act: the node or session exists and sits in
 * the caller's `sessions` family audience (a stranger reads the 404 of an
 * unknown id; a member outside the audience `permission_denied` naming who to
 * ask), the kill switch, the act's rules, the machine through the node link,
 * then one `fleet_audit` row. Every refusal is the CONTRACTS §8 envelope with
 * its status, thrown by the service and passed through untouched.
 *
 * P1b adds the viewer attach token (`POST /sessions/:id/attach-token`,
 * minted through FL-02's one minter) and who is attached (`presence` on the
 * detail). P3 adds recording: `GET /sessions/:id/recording` (the manifest, or
 * with `?from=` a page of chunks — the CONTRACTS §11.2 path, no sub-route) and
 * `POST /sessions/:id/recording { on }`.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetSessionsEnabledGuard)
// FL-19 (CONTRACTS §2.2) — one `confirmation_required` answer for every caller: the class from
// the catalogue, the hint that says what to send; token-style fields are ignored.
@UseInterceptors(FleetConfirmationInterceptor)
export class FleetSessionsController {
    constructor(
        private readonly sessions: FleetSessionService,
        private readonly attach: FleetSessionAttachService,
        private readonly presence: FleetSessionPresenceService,
        private readonly recordings?: FleetSessionRecordingService,
        // FL-06: the branch proposal (FleetSessionGitApiModule is global; absent → 404).
        @Optional() private readonly sessionGit?: FleetSessionGitService,
    ) {}

    @Get('nodes/:id/sessions')
    @ApiOperation({
        summary:
            "One computer's sessions, most recently active first, and the folders its recent sessions started in. Anyone in the computer's `sessions` audience may read them.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async listForNode(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: ListFleetSessionsQueryDto,
    ): Promise<FleetSessionListResponse> {
        const actor = actorOf(auth);
        const page = await this.sessions.listPage(actor, { ...listQuery(query), nodeId: id });
        const recentFolders = await this.sessions.recentFolders(id, actor);
        return { ...page, recentFolders };
    }

    @Post('nodes/:id/sessions')
    @ApiOperation({
        summary:
            'Start a session on a computer: a shell, Claude Code or Codex in a folder of mine, kept running by the computer even when no one watches. Needs `--manage` on the computer for my own sessions. With `restartOf`, starts that ended session again.',
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: FLEET_SESSION_STARTS_PER_MINUTE, ttl: 60_000 } })
    async start(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: StartFleetSessionDto,
        @Res({ passthrough: true }) response?: Response,
    ): Promise<FleetSessionView> {
        const actor = actorOf(auth);
        // An Agent session is QUEUED as a job (P2): `202` while it waits for a slot.
        const queued = (view: FleetSessionView): FleetSessionView => {
            if (view.kind === 'agent' && view.state === 'starting') response?.status(HttpStatus.ACCEPTED);
            return view;
        };
        if (body.restartOf) {
            return queued(
                await this.sessions.restart(
                    body.restartOf,
                    actor,
                    { cols: body.cols, rows: body.rows },
                    { expectNodeId: id },
                ),
            );
        }
        return queued(await this.sessions.start(id, actor, {
            kind: body.kind,
            provider: body.provider,
            cwd: body.cwd,
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.firstMessage !== undefined ? { firstMessage: body.firstMessage } : {}),
            ...(body.agentId !== undefined ? { agentId: body.agentId } : {}),
            ...(body.checkoutId !== undefined ? { checkoutId: body.checkoutId } : {}),
            ...(body.newWorktreeOf !== undefined ? { newWorktreeOf: body.newWorktreeOf } : {}),
            ...(body.taskId !== undefined ? { taskId: body.taskId } : {}),
            ...(body.cols !== undefined ? { cols: body.cols } : {}),
            ...(body.rows !== undefined ? { rows: body.rows } : {}),
        }));
    }

    @Get('sessions')
    @ApiOperation({
        summary:
            'Sessions on every computer I may see sessions on, most recently active first, one page at a time (`cursor` = the previous page’s `nextCursor`).',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListFleetSessionsQueryDto,
    ): Promise<FleetSessionListResponse | FleetSessionBoardResponse> {
        // FL-05 P3: the Sessions board — the four columns instead of a page.
        if (query.view === 'board') {
            return this.sessions.board(actorOf(auth), {
                ...(query.nodeId ? { nodeId: query.nodeId } : {}),
                ...(query.agentId ? { agentId: query.agentId } : {}),
                ...(query.kind ? { kind: query.kind } : {}),
            });
        }
        return this.sessions.listPage(actorOf(auth), {
            ...listQuery(query),
            ...(query.nodeId ? { nodeId: query.nodeId } : {}),
        });
    }

    // FL-06 — declared ABOVE `sessions/:id` so the literal segment is never parsed as an id.
    @Get('sessions/branch-proposal')
    @ApiOperation({
        summary:
            'Propose the branch of a new session’s worktree: `<prefix>/<slug>` (the Agent’s slug, or my handle; the slug from the first message, the title, or a short generated name), never a name the repository ever had — on the remote or on any checkout of it, the bin included — with `-2`, `-3`, … and the reason. A session from a Task keeps the Task’s branch.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async branchProposal(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: FleetSessionBranchProposalQueryDto,
    ): Promise<FleetSessionBranchProposal> {
        if (!this.sessionGit) throw new NotFoundException();
        return this.sessionGit.branchProposal(actorOf(auth), {
            nodeId: query.nodeId,
            checkoutId: query.checkoutId,
            ...(query.agentId ? { agentId: query.agentId } : {}),
            ...(query.firstMessage ? { firstMessage: query.firstMessage } : {}),
            ...(query.title ? { title: query.title } : {}),
            ...(query.taskId ? { taskId: query.taskId } : {}),
        });
    }

    @Get('sessions/:id')
    @ApiOperation({
        summary:
            'One session, with the last screen the computer kept when it ended. A session on a computer I may not see answers 404.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 240, ttl: 60_000 } })
    async get(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetSessionView> {
        const view = await this.sessions.get(id, actorOf(auth));
        if (!isFleetSessionLive(view.state)) return view;
        return { ...view, presence: this.presence.presence(view.id) };
    }

    @Patch('sessions/:id')
    @ApiOperation({
        summary:
            'Rename a session ({ title }, 1–200 characters — the computer keeps the new title too), or acknowledge what it asks ({ acknowledge: <attention key> }: clears unread, never the prompt).',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async rename(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: PatchFleetSessionDto,
    ): Promise<FleetSessionView> {
        // FL-05: the same PATCH acknowledges (plan §5) — exactly one of the two.
        if (typeof body?.acknowledge === 'string' && body.title === undefined) {
            return this.sessions.acknowledge(id, actorOf(auth), body.acknowledge);
        }
        if (typeof body?.title !== 'string' || body.acknowledge !== undefined) {
            throw new BadRequestException('Send either a title or an acknowledge key.');
        }
        return this.sessions.rename(id, actorOf(auth), body.title);
    }

    @Post('sessions/:id/answer')
    @ApiOperation({
        summary:
            'Answer what a session asks (a question or a permission prompt): one of the options the CLI showed, or a free text for a question that takes one. The computer types it as the CLI expects. Refused invalid once answered (in the terminal too), unreachable while the computer is away (the prompt stays), kill_switch under the fleet stop.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: FLEET_SESSION_ANSWERS_PER_MINUTE, ttl: 60_000 } })
    async answer(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: AnswerFleetSessionDto,
    ): Promise<FleetSessionAnswerResponse> {
        return this.sessions.answer(
            id,
            actorOf(auth),
            {
                key: body.key,
                ...(body.optionId !== undefined ? { optionId: body.optionId } : {}),
                ...(body.text !== undefined ? { text: body.text } : {}),
            },
            body.source ?? 'card',
        );
    }

    @Post('sessions/:id/end')
    @ApiOperation({
        summary:
            'End a session: the computer stops the process (terminate, then kill after 5 s) and its screen is kept. Needs `confirm: true` (without it: `confirmation_required` and the sentence to show). A computer that is offline has the session ended here and is told when it returns.',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async end(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: EndFleetSessionDto,
    ): Promise<FleetSessionView> {
        return this.sessions.end(id, actorOf(auth), { confirm: body?.confirm === true });
    }

    @Post('sessions/:id/restart')
    @ApiOperation({
        summary:
            'Start an ended session again: a new session with the same kind, CLI, folder and title, linked back to this one.',
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: FLEET_SESSION_STARTS_PER_MINUTE, ttl: 60_000 } })
    async restart(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: RestartFleetSessionDto,
    ): Promise<FleetSessionView> {
        return this.sessions.restart(id, actorOf(auth), { cols: body?.cols, rows: body?.rows });
    }

    @Post('sessions/:id/attach-token')
    @ApiOperation({
        summary:
            'A 60-second, single-use token to watch (`viewer`) or drive (`driver`) a live session in the browser, and the socket path to present it on. At most five people are attached to one session.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_SESSION_ATTACHES_PER_MINUTE, ttl: 60_000 } })
    async attachToken(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetSessionAttachTokenDto,
    ): Promise<FleetSessionAttachTokenResponse> {
        return this.attach.mint(id, actorOf(auth), body.role);
    }

    @Get('sessions/:id/recording')
    @ApiOperation({
        summary:
            "A session's recording: without `from`, the manifest (state, chunks, duration, who drove when); with `from` (a sequence number) and `limit`, one page of the recorded terminal text, oldest first, secrets redacted. Kept 14 days.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 240, ttl: 60_000 } })
    async recording(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: FleetSessionRecordingQueryDto,
    ): Promise<FleetSessionRecordingManifest | FleetSessionRecordingPage> {
        const service = this.requireRecordings();
        if (query.from !== undefined) {
            return service.page(id, actorOf(auth), {
                from: query.from,
                ...(query.limit !== undefined ? { limit: query.limit } : {}),
            });
        }
        return service.manifest(id, actorOf(auth));
    }

    @Post('sessions/:id/recording')
    @ApiOperation({
        summary:
            'Start or stop recording a live session (`on: true|false`). Recording only watches: it changes nothing on the computer.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async setRecording(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetSessionRecordingDto,
    ): Promise<FleetSessionView> {
        return this.sessions.setRecording(id, actorOf(auth), body.on === true);
    }

    private requireRecordings(): FleetSessionRecordingService {
        if (!this.recordings) throw new NotFoundException();
        return this.recordings;
    }
}
