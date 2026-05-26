import {
	BadRequestException,
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	HttpStatus,
	NotFoundException,
	Param,
	ParseUUIDPipe,
	Patch,
	Post,
	Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
	TasksService,
	TaskChatService,
	TaskStatus,
	TaskPriority,
	type TaskActorType,
	type ListTasksFilter,
} from '@ever-works/agent/tasks-domain';
import { PluginUsageRepository } from '@ever-works/agent/database';
// Review-fix I5: populate the postChat `lookups.ownedAgentSlugs`
// map so the mention parser can resolve `@<slug>` tokens to real
// Agent ids; resolved agent mentions then drive the chat-dispatch
// fan-out (TaskChatService:136-168) — without this map, human
// comments never trigger `agent-chat-reply`.
import { AgentRepository } from '@ever-works/agent/agents';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * Tasks feature — Phase 12.3.
 *
 *   GET    /api/tasks                          list with filters
 *   POST   /api/tasks                          create
 *   GET    /api/tasks/:id                      get one
 *   PATCH  /api/tasks/:id                      partial update
 *   DELETE /api/tasks/:id                      delete (cascade-DB)
 *   POST   /api/tasks/:id/transition           explicit state-machine move
 *   POST   /api/tasks/:id/assignees            add assignee
 *   DELETE /api/tasks/:id/assignees/:id        remove
 *   POST   /api/tasks/:id/reviewers            add reviewer
 *   POST   /api/tasks/:id/approvers            add approver
 *   POST   /api/tasks/:id/blocks               add blocker
 *   DELETE /api/tasks/:id/blocks/:blockId      remove
 *   POST   /api/tasks/:id/relations            add related/duplicates/follow-up
 *
 * Chat + attachments + spend endpoints land in Phase 13.
 *
 * Cross-user reads return 404 (no existence leak via 403).
 */
@ApiTags('tasks')
@Controller('api/tasks')
export class TasksController {
	constructor(
		private readonly service: TasksService,
		private readonly chat: TaskChatService,
		private readonly pluginUsage: PluginUsageRepository,
		// Review-fix I5: AgentRepository for mention-lookup population.
		private readonly agents: AgentRepository,
	) {}

	/**
	 * Review-fix I5: build the `ownedAgentSlugs` map used by
	 * `TaskChatService.parseMentions`. We pull a generous page of the
	 * user's owned Agents (the platform's Agent count per user is
	 * bounded to ~hundreds in v1; this is cheap). The map is rebuilt
	 * per post — Agent slugs change rarely enough that caching is
	 * unnecessary for v1.
	 */
	private async buildMentionLookups(userId: string) {
		const ownedAgentSlugs = new Map<string, string>();
		try {
			const { rows } = await this.agents.findByUserIdScoped(userId, { limit: 500 });
			for (const a of rows) {
				if (a?.slug && a?.id) ownedAgentSlugs.set(a.slug, a.id);
			}
		} catch {
			// Best-effort. A failure here just means @<slug> mentions
			// are stripped (same as v1 default) — never propagated.
		}
		return { ownedAgentSlugs };
	}

	@Get()
	@ApiOperation({ summary: 'List my Tasks (filter by status/priority/scope/label/search).' })
	@HttpCode(HttpStatus.OK)
	async list(
		@CurrentUser() auth: AuthenticatedUser,
		@Query('status') status?: string,
		@Query('priority') priority?: string,
		@Query('missionId') missionId?: string,
		@Query('ideaId') ideaId?: string,
		@Query('workId') workId?: string,
		@Query('parentTaskId') parentTaskId?: string,
		@Query('label') label?: string,
		@Query('search') search?: string,
		@Query('limit') limit?: string,
		@Query('offset') offset?: string,
	) {
		const filter: ListTasksFilter = {
			status: this.parseStatusList(status),
			priority: this.parsePriorityList(priority),
			missionId,
			ideaId,
			workId,
			parentTaskId,
			label,
			search,
			limit: limit ? Math.min(200, Math.max(1, parseInt(limit, 10) || 50)) : 50,
			offset: offset ? Math.max(0, parseInt(offset, 10) || 0) : 0,
		};
		const { rows, total } = await this.service.list(auth.userId, filter);
		return { data: rows, meta: { total, limit: filter.limit, offset: filter.offset } };
	}

	@Post()
	@ApiOperation({ summary: 'Create a Task.' })
	@HttpCode(HttpStatus.CREATED)
	@Throttle({ default: { limit: 60, ttl: 60_000 } })
	async create(
		@CurrentUser() auth: AuthenticatedUser,
		@Body()
		body: {
			title: string;
			description?: string | null;
			status?: TaskStatus;
			priority?: TaskPriority;
			labels?: string[];
			missionId?: string | null;
			ideaId?: string | null;
			workId?: string | null;
			parentTaskId?: string | null;
			requireAllApprovers?: boolean;
		},
	) {
		if (!body?.title) throw new BadRequestException('title is required.');
		return this.service.create(auth.userId, {
			title: body.title,
			description: body.description ?? null,
			status: body.status,
			priority: body.priority,
			labels: body.labels ?? null,
			missionId: body.missionId ?? null,
			ideaId: body.ideaId ?? null,
			workId: body.workId ?? null,
			parentTaskId: body.parentTaskId ?? null,
			createdByType: 'user',
			createdById: auth.userId,
			requireAllApprovers: body.requireAllApprovers,
		});
	}

	@Get(':id')
	@ApiOperation({ summary: 'Get one Task.' })
	@HttpCode(HttpStatus.OK)
	async getOne(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
	) {
		return this.service.getOne(auth.userId, id);
	}

	@Patch(':id')
	@ApiOperation({ summary: 'Update Task fields.' })
	@HttpCode(HttpStatus.OK)
	@Throttle({ default: { limit: 60, ttl: 60_000 } })
	async update(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
		@Body()
		body: {
			title?: string;
			description?: string | null;
			priority?: TaskPriority;
			labels?: string[] | null;
			parentTaskId?: string | null;
			requireAllApprovers?: boolean;
		},
	) {
		return this.service.update(auth.userId, id, body);
	}

	@Delete(':id')
	@ApiOperation({ summary: 'Delete a Task (cascades to side rows).' })
	@HttpCode(HttpStatus.OK)
	@Throttle({ default: { limit: 30, ttl: 60_000 } })
	async remove(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
	) {
		return this.service.remove(auth.userId, id);
	}

	@Post(':id/recurring')
	@ApiOperation({
		summary:
			'Make this Task recurring (or update its rule). Body: {recurrenceRule (RFC 5545 RRULE), recurrenceTimezone?, recurrenceEndsAt?, recurrenceMaxOccurrences?}.',
	})
	@HttpCode(HttpStatus.OK)
	@Throttle({ default: { limit: 30, ttl: 60_000 } })
	async setRecurring(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
		@Body()
		body: {
			recurrenceRule: string;
			recurrenceTimezone?: string;
			recurrenceEndsAt?: string;
			recurrenceMaxOccurrences?: number;
		},
	) {
		if (!body?.recurrenceRule) {
			throw new BadRequestException('recurrenceRule is required.');
		}
		return this.service.setRecurring(auth.userId, id, {
			recurrenceRule: body.recurrenceRule,
			recurrenceTimezone: body.recurrenceTimezone,
			recurrenceEndsAt: body.recurrenceEndsAt ? new Date(body.recurrenceEndsAt) : null,
			recurrenceMaxOccurrences: body.recurrenceMaxOccurrences ?? null,
		});
	}

	@Delete(':id/recurring')
	@ApiOperation({ summary: 'Stop recurrence on a template. Existing spawned instances are kept.' })
	@HttpCode(HttpStatus.OK)
	async clearRecurring(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
	) {
		return this.service.clearRecurring(auth.userId, id);
	}

	@Post(':id/transition')
	@ApiOperation({ summary: 'State-machine transition.' })
	@HttpCode(HttpStatus.OK)
	@Throttle({ default: { limit: 60, ttl: 60_000 } })
	async transition(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: { to: TaskStatus; force?: boolean },
	) {
		if (!Object.values(TaskStatus).includes(body?.to)) {
			throw new BadRequestException(`Invalid target status: ${body?.to}`);
		}
		return this.service.transition(auth.userId, id, body.to, { force: body.force === true });
	}

	@Post(':id/assignees')
	@ApiOperation({ summary: 'Add an assignee.' })
	@HttpCode(HttpStatus.CREATED)
	@Throttle({ default: { limit: 60, ttl: 60_000 } })
	async addAssignee(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: { assigneeType: TaskActorType; assigneeId: string },
	) {
		this.assertActorType(body.assigneeType);
		return this.service.addAssignee(auth.userId, id, body.assigneeType, body.assigneeId);
	}

	@Delete(':id/assignees/:assigneeId')
	@ApiOperation({ summary: 'Remove an assignee.' })
	@HttpCode(HttpStatus.OK)
	async removeAssignee(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
		@Param('assigneeId', ParseUUIDPipe) assigneeId: string,
	) {
		return this.service.removeAssignee(auth.userId, id, assigneeId);
	}

	@Post(':id/reviewers')
	@ApiOperation({ summary: 'Add a reviewer.' })
	@HttpCode(HttpStatus.CREATED)
	async addReviewer(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: { reviewerType: TaskActorType; reviewerId: string },
	) {
		this.assertActorType(body.reviewerType);
		return this.service.addReviewer(auth.userId, id, body.reviewerType, body.reviewerId);
	}

	@Post(':id/approvers')
	@ApiOperation({ summary: 'Add an approver.' })
	@HttpCode(HttpStatus.CREATED)
	async addApprover(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: { approverType: TaskActorType; approverId: string },
	) {
		this.assertActorType(body.approverType);
		return this.service.addApprover(auth.userId, id, body.approverType, body.approverId);
	}

	@Post(':id/blocks')
	@ApiOperation({ summary: 'Add a blocker.' })
	@HttpCode(HttpStatus.CREATED)
	async addBlocker(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: { blockedByTaskId: string },
	) {
		if (!body?.blockedByTaskId) throw new BadRequestException('blockedByTaskId is required.');
		return this.service.addBlocker(auth.userId, id, body.blockedByTaskId);
	}

	@Delete(':id/blocks/:blockId')
	@ApiOperation({ summary: 'Remove a blocker.' })
	@HttpCode(HttpStatus.OK)
	async removeBlocker(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
		@Param('blockId', ParseUUIDPipe) blockId: string,
	) {
		return this.service.removeBlocker(auth.userId, id, blockId);
	}

	@Get(':id/attachments')
	@ApiOperation({ summary: 'List Task attachments (FK pointers to work_knowledge_upload rows).' })
	@HttpCode(HttpStatus.OK)
	async listAttachments(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
	) {
		return this.service.listAttachments(auth.userId, id);
	}

	@Post(':id/attachments')
	@ApiOperation({
		summary:
			'Attach an existing work_knowledge_upload to this Task. Upload via the existing KB pipeline first; pass the resulting uploadId here.',
	})
	@HttpCode(HttpStatus.CREATED)
	@Throttle({ default: { limit: 60, ttl: 60_000 } })
	async addAttachment(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: { uploadId: string },
	) {
		if (!body?.uploadId) throw new BadRequestException('uploadId is required.');
		return this.service.addAttachment(auth.userId, id, body.uploadId);
	}

	@Delete(':id/attachments/:attachmentId')
	@ApiOperation({ summary: 'Detach an attachment (the upload row itself is preserved).' })
	@HttpCode(HttpStatus.OK)
	async removeAttachment(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
		@Param('attachmentId', ParseUUIDPipe) attachmentId: string,
	) {
		return this.service.removeAttachment(auth.userId, id, attachmentId);
	}

	@Post(':id/relations')
	@ApiOperation({ summary: 'Add a related/duplicates/follow-up edge.' })
	@HttpCode(HttpStatus.CREATED)
	async addRelation(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: { relatedTaskId: string; kind: 'related' | 'duplicates' | 'follow-up' },
	) {
		if (!body?.relatedTaskId) throw new BadRequestException('relatedTaskId is required.');
		if (!['related', 'duplicates', 'follow-up'].includes(body.kind)) {
			throw new BadRequestException(`Invalid relation kind: ${body.kind}`);
		}
		return this.service.addRelation(auth.userId, id, body.relatedTaskId, body.kind);
	}

	private parseStatusList(value?: string): TaskStatus | TaskStatus[] | undefined {
		if (!value) return undefined;
		const parts = value.split(',').map((v) => v.trim()).filter(Boolean);
		const out: TaskStatus[] = [];
		for (const p of parts) {
			if (!Object.values(TaskStatus).includes(p as TaskStatus)) {
				throw new BadRequestException(`Invalid status filter: ${p}`);
			}
			out.push(p as TaskStatus);
		}
		return out.length === 1 ? out[0] : out;
	}

	private parsePriorityList(value?: string): TaskPriority | TaskPriority[] | undefined {
		if (!value) return undefined;
		const parts = value.split(',').map((v) => v.trim()).filter(Boolean);
		const out: TaskPriority[] = [];
		for (const p of parts) {
			if (!Object.values(TaskPriority).includes(p as TaskPriority)) {
				throw new BadRequestException(`Invalid priority filter: ${p}`);
			}
			out.push(p as TaskPriority);
		}
		return out.length === 1 ? out[0] : out;
	}

	private assertActorType(value: string): void {
		if (value !== 'user' && value !== 'agent') {
			throw new BadRequestException(`Invalid actor type: ${value}`);
		}
	}

	// ── Phase 13 — chat ───────────────────────────────────────────

	@Get(':id/chat')
	@ApiOperation({ summary: 'Paginated chat thread for a Task.' })
	@HttpCode(HttpStatus.OK)
	async listChat(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
		@Query('limit') limit?: string,
		@Query('offset') offset?: string,
	) {
		const messages = await this.chat.list(auth.userId, id, {
			limit: limit ? Math.min(200, Math.max(1, parseInt(limit, 10) || 50)) : 50,
			offset: offset ? Math.max(0, parseInt(offset, 10) || 0) : 0,
		});
		return { data: messages };
	}

	@Get(':id/spend')
	@ApiOperation({ summary: 'Per-Task spend rollup in cents.' })
	@HttpCode(HttpStatus.OK)
	async spend(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
		@Query('since') since?: string,
		@Query('until') until?: string,
		@Query('currency') currency?: string,
	) {
		// Cross-user ownership check — 404 if Task doesn't belong to user.
		await this.service.getOne(auth.userId, id);
		const totalCents = await this.pluginUsage.getTotalSpendCentsForTask(id, {
			since: since ? new Date(since) : undefined,
			until: until ? new Date(until) : undefined,
			currency,
		});
		return { taskId: id, totalCents, currency: currency ?? 'usd' };
	}

	@Post(':id/chat')
	@ApiOperation({
		summary: 'Post a chat message. Server parses @mentions + [[kb]] tokens and drops unknown ones.',
	})
	@HttpCode(HttpStatus.CREATED)
	@Throttle({ default: { limit: 60, ttl: 60_000 } })
	async postChat(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: { body: string; attachments?: { uploadId: string }[] },
	) {
		if (typeof body?.body !== 'string') {
			throw new BadRequestException('body is required.');
		}
		// Review-fix I5: populate the mention-lookup map with the
		// user's owned Agent slugs so @<slug> mentions resolve →
		// chat-dispatch fan-out fires `agent-chat-reply` for each
		// mentioned Agent. Unknown tokens are still stripped (T6
		// posture). Known-user-slugs + known-kb-slugs maps land in
		// a follow-up once those domains expose lookup helpers.
		const lookups = await this.buildMentionLookups(auth.userId);
		return this.chat.post(
			auth.userId,
			{
				taskId: id,
				authorType: 'user',
				authorId: auth.userId,
				body: body.body,
				attachments: body.attachments,
			},
			lookups,
		);
	}
}
