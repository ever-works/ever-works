import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    FleetSessionService,
    type FleetSessionActor,
    type FleetSessionListQuery,
} from '@ever-works/agent/fleet';
import {
    FLEET_SESSION_STARTS_PER_MINUTE,
    type FleetSessionListResponse,
    type FleetSessionView,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import {
    EndFleetSessionDto,
    ListFleetSessionsQueryDto,
    RenameFleetSessionDto,
    RestartFleetSessionDto,
    StartFleetSessionDto,
} from './dto/fleet-session.dto';
import { FleetSessionsEnabledGuard } from './fleet-sessions-enabled.guard';

function actorOf(auth: AuthenticatedUser): FleetSessionActor {
    return { userId: auth.userId };
}

function listQuery(query: ListFleetSessionsQueryDto): FleetSessionListQuery {
    const out: FleetSessionListQuery = {};
    if (query.state) out.state = query.state;
    if (query.kind) out.kind = query.kind;
    if (query.agentId) out.agentId = query.agentId;
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
 * Recording (`GET|POST /sessions/:id/recording`) arrives with P3, the viewer
 * attach token with P1b.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetSessionsEnabledGuard)
export class FleetSessionsController {
    constructor(private readonly sessions: FleetSessionService) {}

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
    ): Promise<FleetSessionView> {
        const actor = actorOf(auth);
        if (body.restartOf) {
            return this.sessions.restart(
                body.restartOf,
                actor,
                { cols: body.cols, rows: body.rows },
                { expectNodeId: id },
            );
        }
        return this.sessions.start(id, actor, {
            kind: body.kind,
            provider: body.provider,
            cwd: body.cwd,
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.firstMessage !== undefined ? { firstMessage: body.firstMessage } : {}),
            ...(body.agentId !== undefined ? { agentId: body.agentId } : {}),
            ...(body.checkoutId !== undefined ? { checkoutId: body.checkoutId } : {}),
            ...(body.newWorktreeOf !== undefined ? { newWorktreeOf: body.newWorktreeOf } : {}),
            ...(body.cols !== undefined ? { cols: body.cols } : {}),
            ...(body.rows !== undefined ? { rows: body.rows } : {}),
        });
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
    ): Promise<FleetSessionListResponse> {
        return this.sessions.listPage(actorOf(auth), {
            ...listQuery(query),
            ...(query.nodeId ? { nodeId: query.nodeId } : {}),
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
        return this.sessions.get(id, actorOf(auth));
    }

    @Patch('sessions/:id')
    @ApiOperation({ summary: 'Rename a session (1–200 characters). The computer keeps the new title too.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async rename(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: RenameFleetSessionDto,
    ): Promise<FleetSessionView> {
        return this.sessions.rename(id, actorOf(auth), body.title);
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
}
