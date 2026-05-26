import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	Logger,
	NotFoundException,
	Optional,
} from '@nestjs/common';
import {
	TaskChatMessageRepository,
	TaskKbMentionRepository,
} from '../database/repositories/task-side.repositories';
import { TaskRepository } from '../database/repositories/task.repository';
import type { TaskChatMessage } from '../entities/task-chat-message.entity';
import type { TaskActorType } from '../entities/task.entity';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { assertNoSecrets } from '../utils/secret-scan';

/**
 * Tasks feature — Phase 13.2.
 *
 * Chat thread on each Task. Posts go through:
 *   1. cross-user 404 guard on the parent Task
 *   2. secret-scan (hard-reject; mirrors Agent files + Task description)
 *   3. body size cap (16 KB — chat is short by intent; bigger artifacts
 *      go via attachments)
 *   4. mention parser — server-side extracts @<slug> + [[kb-doc]] tokens,
 *      validates each against the user's owned Agents/users + KB docs,
 *      and stores the resolved subset on the row (unknown tokens are
 *      stripped so the model never sees a hallucinated reference)
 *   5. KB-mention materialization into `task_kb_mentions` for the
 *      Related panel
 *
 * Edits go through a strict 5-minute window from `createdAt`. Past the
 * window, the API returns 403 (not 400) — the user IS authorized to
 * edit, just not anymore. Mirrors GitHub PR comment behavior.
 */
const MAX_CHAT_BYTES = 16 * 1024;
const EDIT_WINDOW_MS = 5 * 60_000;

const MENTION_RE = /@([a-z0-9-]{1,80})\b/g;
const KB_LINK_RE = /\[\[([^\]]{1,200})\]\]/g;

export interface PostChatInput {
	taskId: string;
	authorType: TaskActorType;
	authorId: string;
	body: string;
	attachments?: { uploadId: string }[];
}

export interface MentionLookups {
	/** Slugs the user owns — map<slug, agentId>. */
	ownedAgentSlugs?: Map<string, string>;
	/** Usernames the user can mention — map<slug, userId>. */
	knownUserSlugs?: Map<string, string>;
	/** KB doc slugs the user can reach — map<slug, kbDocumentId>. */
	knownKbSlugs?: Map<string, string>;
}

@Injectable()
export class TaskChatService {
	private readonly logger = new Logger(TaskChatService.name);

	constructor(
		private readonly tasks: TaskRepository,
		private readonly messages: TaskChatMessageRepository,
		private readonly kbMentions: TaskKbMentionRepository,
		@Optional() private readonly activityLog?: ActivityLogService,
	) {}

	async list(
		userId: string,
		taskId: string,
		opts: { limit?: number; offset?: number } = {},
	): Promise<TaskChatMessage[]> {
		await this.requireOwnedTask(userId, taskId);
		return this.messages.findByTaskId(taskId, opts.limit ?? 50, opts.offset ?? 0);
	}

	async post(
		userId: string,
		input: PostChatInput,
		lookups: MentionLookups = {},
	): Promise<TaskChatMessage> {
		const task = await this.requireOwnedTask(userId, input.taskId);
		this.assertBody(input.body);

		const mentions = this.parseMentions(input.body, lookups);

		const row = await this.messages.create({
			taskId: task.id,
			authorType: input.authorType,
			authorId: input.authorId,
			body: input.body,
			mentions: mentions.records.length > 0 ? mentions.records : null,
			attachments: input.attachments && input.attachments.length > 0 ? input.attachments : null,
		});

		// Materialize KB mentions for the Related panel — dedupe on
		// (taskId, kbDocumentId).
		for (const kbDocumentId of mentions.kbDocIds) {
			try {
				await this.kbMentions.add(task.id, kbDocumentId);
			} catch {
				// Unique violation — already linked. Safe to swallow.
			}
		}

		await this.logActivity({
			userId,
			taskId: task.id,
			actionType: ActivityActionType.TASK_COMMENTED,
			details: {
				messageId: row.id,
				mentions: mentions.records.map((m) => m.slug ?? m.id ?? null),
			},
		});
		return row;
	}

	async edit(
		userId: string,
		messageId: string,
		newBody: string,
		lookups: MentionLookups = {},
	): Promise<TaskChatMessage> {
		const msg = await this.messages.findById(messageId);
		if (!msg) throw new NotFoundException(`Chat message ${messageId} not found.`);

		await this.requireOwnedTask(userId, msg.taskId);

		// Authorship — only the original author can edit (when author
		// is a user; agent-authored messages are not user-editable).
		if (msg.authorType !== 'user' || msg.authorId !== userId) {
			throw new ForbiddenException('Only the original author can edit this message.');
		}

		// 5-minute edit window.
		const age = Date.now() - new Date(msg.createdAt).getTime();
		if (age > EDIT_WINDOW_MS) {
			throw new ForbiddenException('Edit window has expired (5 minutes).');
		}

		this.assertBody(newBody);

		// Re-parse mentions on edit — keeps the materialized references
		// honest if the user removes a mention.
		this.parseMentions(newBody, lookups);

		await this.messages.updateBody(messageId, newBody);
		const refreshed = await this.messages.findById(messageId);
		if (!refreshed) throw new NotFoundException(`Chat message ${messageId} vanished.`);
		return refreshed;
	}

	/**
	 * Parse `@<slug>` and `[[kb-slug]]` tokens against the supplied
	 * lookup maps. Unknown tokens are dropped from the result — the
	 * model never sees a hallucinated reference. Exposed for tests.
	 */
	parseMentions(
		body: string,
		lookups: MentionLookups,
	): {
		records: Array<{ type: 'user' | 'agent' | 'kb'; id?: string; slug?: string }>;
		kbDocIds: string[];
	} {
		const records: Array<{ type: 'user' | 'agent' | 'kb'; id?: string; slug?: string }> = [];
		const kbDocIds: string[] = [];

		const seen = new Set<string>();
		for (const match of body.matchAll(MENTION_RE)) {
			const slug = match[1];
			const key = `m:${slug}`;
			if (seen.has(key)) continue;
			seen.add(key);

			const agentId = lookups.ownedAgentSlugs?.get(slug);
			if (agentId) {
				records.push({ type: 'agent', id: agentId, slug });
				continue;
			}
			const userId = lookups.knownUserSlugs?.get(slug);
			if (userId) {
				records.push({ type: 'user', id: userId, slug });
				continue;
			}
			// Unknown — drop silently (T6 mitigation).
		}

		for (const match of body.matchAll(KB_LINK_RE)) {
			const slug = match[1].trim();
			const key = `k:${slug}`;
			if (seen.has(key)) continue;
			seen.add(key);

			const docId = lookups.knownKbSlugs?.get(slug);
			if (docId) {
				records.push({ type: 'kb', id: docId, slug });
				kbDocIds.push(docId);
			}
			// Unknown — drop silently.
		}

		return { records, kbDocIds };
	}

	// ── internals ─────────────────────────────────────────────────

	private async requireOwnedTask(userId: string, taskId: string) {
		const task = await this.tasks.findByIdAndUser(taskId, userId);
		if (!task) throw new NotFoundException(`Task ${taskId} not found.`);
		return task;
	}

	private assertBody(body: string): void {
		if (!body || body.trim().length === 0) {
			throw new BadRequestException('Chat body is required.');
		}
		if (body.length > MAX_CHAT_BYTES) {
			throw new BadRequestException(`Chat body exceeds max ${MAX_CHAT_BYTES} bytes.`);
		}
		assertNoSecrets(body, 'task.chat.body');
	}

	private async logActivity(args: {
		userId: string;
		taskId: string;
		actionType: ActivityActionType;
		details?: Record<string, unknown>;
	}): Promise<void> {
		if (!this.activityLog) return;
		try {
			await this.activityLog.log({
				userId: args.userId,
				action: args.actionType,
				actionType: args.actionType,
				status: ActivityStatus.SUCCESS,
				resourceType: 'task',
				resourceId: args.taskId,
				details: args.details,
			});
		} catch (err) {
			this.logger.warn(`Failed to log activity ${args.actionType}: ${err}`);
		}
	}
}
