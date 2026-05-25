import {
	BadRequestException,
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	HttpStatus,
	Param,
	ParseUUIDPipe,
	Patch,
	Post,
	Put,
	Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
	AgentFileService,
	AGENT_FILE_NAMES,
	AgentsService,
	type AgentDto,
	type AgentFileName,
	type AgentTarget,
} from '@ever-works/agent/agents';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { CreateAgentDto, ListAgentsQueryDto, UpdateAgentDto } from './dto/agent.dto';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 3 API surface.
 *
 *   GET    /api/agents              list mine (filterable)
 *   POST   /api/agents              create
 *   GET    /api/agents/:id          get one
 *   PATCH  /api/agents/:id          partial update
 *   DELETE /api/agents/:id          archive (soft-delete) — operator can pass ?hard=true to delete
 *   POST   /api/agents/:id/pause    ACTIVE → PAUSED
 *   POST   /api/agents/:id/resume   PAUSED/ERROR → ACTIVE
 *
 * Runtime endpoints (`/run-now`, `/dry-run`, `/export`, `/import`,
 * `/files/:name`, `/runs`, `/skills`, `/budget`) land in later phases.
 *
 * Rate limits per `agents/plan.md §7.1`:
 *   - POST     /agents         30/min/user
 *   - PATCH    /agents/:id     30/min/user
 *   - DELETE   /agents/:id     30/min/user
 *   - status transitions       30/min/user
 *   - GET routes               default global throttler only
 *
 * Cross-user reads return 404 (architecture/security §9 — no
 * existence leak via 403).
 */
@ApiTags('agents')
@Controller('api/agents')
export class AgentsController {
	constructor(
		private readonly service: AgentsService,
		// Phase 4 — file read/write endpoints.
		private readonly files: AgentFileService,
	) {}

	@Get()
	@ApiOperation({ summary: 'List my Agents (filter by scope/status/target/search)' })
	@HttpCode(HttpStatus.OK)
	async list(
		@CurrentUser() auth: AuthenticatedUser,
		@Query() query: ListAgentsQueryDto,
	): Promise<{ data: AgentDto[]; meta: { total: number; limit: number; offset: number } }> {
		const limit = query.limit ?? 50;
		const offset = query.offset ?? 0;
		const { rows, total } = await this.service.list(auth.userId, {
			scope: query.scope,
			status: query.status,
			missionId: query.missionId,
			ideaId: query.ideaId,
			workId: query.workId,
			search: query.search,
			limit,
			offset,
		});
		return { data: rows, meta: { total, limit, offset } };
	}

	@Post()
	@ApiOperation({ summary: 'Create a new Agent' })
	@HttpCode(HttpStatus.CREATED)
	@Throttle({ default: { limit: 30, ttl: 60_000 } })
	async create(
		@CurrentUser() auth: AuthenticatedUser,
		@Body() body: CreateAgentDto,
	): Promise<AgentDto> {
		return this.service.create(auth.userId, {
			scope: body.scope,
			missionId: body.missionId ?? null,
			ideaId: body.ideaId ?? null,
			workId: body.workId ?? null,
			name: body.name,
			title: body.title ?? null,
			capabilities: body.capabilities ?? null,
			aiProviderId: body.aiProviderId ?? null,
			modelId: body.modelId ?? null,
			maxSkillContextTokens: body.maxSkillContextTokens,
			heartbeatCadence: body.heartbeatCadence ?? null,
			idleBehavior: body.idleBehavior,
			pauseAfterFailures: body.pauseAfterFailures,
			permissions: body.permissions,
			targets: (body.targets ?? null) as AgentTarget[] | null,
			avatarMode: body.avatarMode,
			avatarIcon: body.avatarIcon ?? null,
			avatarImageUploadId: body.avatarImageUploadId ?? null,
		});
	}

	@Get(':id')
	@ApiOperation({ summary: 'Get one Agent' })
	@HttpCode(HttpStatus.OK)
	async getOne(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
	): Promise<AgentDto> {
		return this.service.getOne(auth.userId, id);
	}

	@Patch(':id')
	@ApiOperation({ summary: 'Update Agent fields (partial)' })
	@HttpCode(HttpStatus.OK)
	@Throttle({ default: { limit: 30, ttl: 60_000 } })
	async update(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: UpdateAgentDto,
	): Promise<AgentDto> {
		return this.service.update(auth.userId, id, {
			name: body.name,
			title: body.title,
			capabilities: body.capabilities,
			aiProviderId: body.aiProviderId,
			modelId: body.modelId,
			maxSkillContextTokens: body.maxSkillContextTokens,
			heartbeatCadence: body.heartbeatCadence,
			idleBehavior: body.idleBehavior,
			pauseAfterFailures: body.pauseAfterFailures,
			permissions: body.permissions,
			targets: body.targets as AgentTarget[] | null | undefined,
			avatarMode: body.avatarMode,
			avatarIcon: body.avatarIcon,
			avatarImageUploadId: body.avatarImageUploadId,
		});
	}

	@Delete(':id')
	@ApiOperation({
		summary: 'Archive Agent (soft-delete). Pass ?hard=true to permanently delete + cascade.',
	})
	@HttpCode(HttpStatus.OK)
	@Throttle({ default: { limit: 30, ttl: 60_000 } })
	async remove(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
		@Query('hard') hard?: string,
	): Promise<{ archived?: true; deleted?: true }> {
		if (hard === 'true') {
			return this.service.deleteHard(auth.userId, id);
		}
		return this.service.archive(auth.userId, id);
	}

	@Post(':id/pause')
	@ApiOperation({ summary: 'Pause an active Agent (ACTIVE → PAUSED)' })
	@HttpCode(HttpStatus.OK)
	@Throttle({ default: { limit: 30, ttl: 60_000 } })
	async pause(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
	): Promise<AgentDto> {
		return this.service.pause(auth.userId, id);
	}

	@Post(':id/resume')
	@ApiOperation({ summary: 'Resume a paused/errored Agent (→ ACTIVE)' })
	@HttpCode(HttpStatus.OK)
	@Throttle({ default: { limit: 30, ttl: 60_000 } })
	async resume(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
	): Promise<AgentDto> {
		return this.service.resume(auth.userId, id);
	}

	// ── Phase 4 — Agent file storage (5 canonical MD files + agent.yml) ─

	@Get(':id/files/:name')
	@ApiOperation({
		summary:
			'Read one Agent definition file (SOUL.md / AGENTS.md / HEARTBEAT.md / TOOLS.md / agent.yml)',
	})
	@HttpCode(HttpStatus.OK)
	async readFile(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
		@Param('name') name: string,
	): Promise<{ name: AgentFileName; body: string; hash: string; storage: 'git' | 'db' }> {
		this.assertValidFileName(name);
		return this.files.read(auth.userId, id, name as AgentFileName);
	}

	@Put(':id/files/:name')
	@ApiOperation({
		summary:
			'Replace one Agent definition file body. Optimistic concurrency: pass `expectedHash` to guard against concurrent edits.',
	})
	@HttpCode(HttpStatus.OK)
	@Throttle({ default: { limit: 60, ttl: 60_000 } })
	async writeFile(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
		@Param('name') name: string,
		@Body() body: { body: string; expectedHash?: string },
	): Promise<{ newHash: string }> {
		this.assertValidFileName(name);
		if (typeof body?.body !== 'string') {
			throw new BadRequestException('Request body must include a string `body` field.');
		}
		return this.files.write({
			userId: auth.userId,
			agentId: id,
			name: name as AgentFileName,
			body: body.body,
			expectedHash: body.expectedHash,
		});
	}

	private assertValidFileName(name: string): void {
		if (!AGENT_FILE_NAMES.includes(name as AgentFileName)) {
			throw new BadRequestException(
				`Invalid Agent file name "${name}". Allowed: ${AGENT_FILE_NAMES.join(', ')}.`,
			);
		}
	}
}
