import {
	BadRequestException,
	ConflictException,
	Injectable,
	Logger,
	NotFoundException,
	UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { InboundTrigger } from '../entities/inbound-trigger.entity';
import { WebhookSubscriptionSecretService } from '../services/webhook-subscription-secret.service';
import { TasksService } from '../tasks-domain/tasks.service';
import { AgentRepository } from '../database/repositories/agent.repository';
import {
	DEFAULT_TASK_TITLE_TEMPLATE,
	MAX_FIRE_PAYLOAD_BYTES,
	REPLAY_WINDOW_MS,
	ROTATION_GRACE_MS,
	type CreateInboundTriggerInput,
	type FireInboundTriggerInput,
	type FireInboundTriggerResult,
	type InboundTriggerScope,
	type InboundTriggerView,
	type UpdateInboundTriggerInput,
} from './inbound-trigger.types';

/** Task titles are capped at 200 by TasksService.assertTitle — clamp rendered templates. */
const MAX_TASK_TITLE_LENGTH = 200;

function toIso(value: Date | null | undefined): string | null {
	if (!value) return null;
	const time = value instanceof Date ? value : new Date(value);
	return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

/**
 * Inbound Triggers ("Trigger Schedules") — event-driven ops without polling.
 *
 * Management surface (list / create / update / rotate / pause / resume /
 * delete) is caller-scoped exactly like every other Tier A read: userId +
 * active Organization (personal scope filters `organizationId IS NULL`),
 * and cross-org access is masked as 404 — never 403 — to avoid
 * enumeration (same posture as `WebhooksService.findOwn`).
 *
 * Secret lifecycle mirrors the outbound webhook-subscription secret
 * (`WebhookSubscriptionSecretService`): a fresh 32-byte random secret is
 * generated on create, returned in PLAINTEXT exactly once, and stored
 * AES-256-GCM-encrypted. `rotateSecret` moves current → previous and
 * stamps `rotatedAt`; the previous secret keeps verifying for
 * ROTATION_GRACE_MS (24h) so external senders can roll without a hard
 * cutover.
 *
 * `fire()` is the unauthenticated delivery path: it verifies
 *   (a) the timestamp header is within REPLAY_WINDOW_MS of now,
 *   (b) hex HMAC-SHA256 over `${timestamp}.${rawBody}` matches the
 *       signature header under the current secret OR (within grace) the
 *       previous one — timing-safe comparison, and
 *   (c) the trigger is active,
 * then spawns a Task titled from `taskTitleTemplate` carrying the JSON
 * payload, assigned to `targetAgentId` when set, and bumps
 * `fireCount` / `lastFiredAt`. All verification failures surface as a
 * constant-shape 401 (no detail leak); unknown ids 404; paused 409.
 */
@Injectable()
export class InboundTriggersService {
	private readonly logger = new Logger(InboundTriggersService.name);

	constructor(
		@InjectRepository(InboundTrigger)
		private readonly repo: Repository<InboundTrigger>,
		private readonly secrets: WebhookSubscriptionSecretService,
		private readonly tasks: TasksService,
		private readonly agents: AgentRepository,
	) {}

	async list(scope: InboundTriggerScope): Promise<InboundTriggerView[]> {
		const rows = await this.repo.find({
			where: {
				userId: scope.userId,
				organizationId: scope.organizationId ? scope.organizationId : IsNull(),
			},
			order: { createdAt: 'DESC' },
		});
		return rows.map((row) => this.toView(row));
	}

	async getOne(scope: InboundTriggerScope, id: string): Promise<InboundTriggerView> {
		const row = await this.findOwn(scope, id);
		return this.toView(row);
	}

	/**
	 * Create a trigger. Returns the view plus the RAW signing secret —
	 * the secret appears ONLY in this response (and in `rotateSecret`'s);
	 * it is never readable again.
	 */
	async create(
		scope: InboundTriggerScope,
		input: CreateInboundTriggerInput,
	): Promise<{ trigger: InboundTriggerView; secret: string }> {
		const name = (input.name ?? '').trim();
		if (name.length < 1 || name.length > 120) {
			throw new BadRequestException('Trigger name must be 1-120 characters.');
		}
		if (input.targetAgentId) {
			await this.assertAgentReachable(scope.userId, input.targetAgentId);
		}

		const { raw, encrypted } = this.secrets.generateSecret();
		const row = await this.repo.save(
			this.repo.create({
				userId: scope.userId,
				name,
				description: input.description ?? null,
				kind: input.kind ?? 'webhook',
				status: 'active',
				secretEncrypted: encrypted,
				previousSecretEncrypted: null,
				rotatedAt: null,
				targetAgentId: input.targetAgentId ?? null,
				taskTitleTemplate: input.taskTitleTemplate ?? null,
				lastFiredAt: null,
				fireCount: 0,
				// Stamp the active Organization explicitly (mirrors what
				// ScopeStampingSubscriber would do); tenantId is left
				// undefined so the subscriber fills it from the request scope.
				organizationId: scope.organizationId,
			}),
		);
		return { trigger: this.toView(row), secret: raw };
	}

	async update(
		scope: InboundTriggerScope,
		id: string,
		input: UpdateInboundTriggerInput,
	): Promise<InboundTriggerView> {
		const row = await this.findOwn(scope, id);
		if (input.name !== undefined) {
			const name = input.name.trim();
			if (name.length < 1 || name.length > 120) {
				throw new BadRequestException('Trigger name must be 1-120 characters.');
			}
			row.name = name;
		}
		if (input.description !== undefined) {
			row.description = input.description;
		}
		if (input.targetAgentId !== undefined) {
			if (input.targetAgentId) {
				await this.assertAgentReachable(scope.userId, input.targetAgentId);
			}
			row.targetAgentId = input.targetAgentId;
		}
		if (input.taskTitleTemplate !== undefined) {
			row.taskTitleTemplate = input.taskTitleTemplate;
		}
		const saved = await this.repo.save(row);
		return this.toView(saved);
	}

	/**
	 * Rotate the signing secret: current → previous (kept verifying for
	 * ROTATION_GRACE_MS), fresh secret becomes current, `rotatedAt`
	 * stamps the grace window. Returns the new RAW secret ONCE.
	 */
	async rotateSecret(
		scope: InboundTriggerScope,
		id: string,
	): Promise<{ trigger: InboundTriggerView; secret: string }> {
		const row = await this.findOwn(scope, id);
		const { raw, encrypted } = this.secrets.generateSecret();
		row.previousSecretEncrypted = row.secretEncrypted;
		row.secretEncrypted = encrypted;
		row.rotatedAt = new Date();
		const saved = await this.repo.save(row);
		return { trigger: this.toView(saved), secret: raw };
	}

	async pause(scope: InboundTriggerScope, id: string): Promise<InboundTriggerView> {
		const row = await this.findOwn(scope, id);
		row.status = 'paused';
		return this.toView(await this.repo.save(row));
	}

	async resume(scope: InboundTriggerScope, id: string): Promise<InboundTriggerView> {
		const row = await this.findOwn(scope, id);
		row.status = 'active';
		return this.toView(await this.repo.save(row));
	}

	async remove(scope: InboundTriggerScope, id: string): Promise<void> {
		const row = await this.findOwn(scope, id);
		await this.repo.delete(row.id);
	}

	/**
	 * Unauthenticated fire path — see class doc for the verification
	 * contract. Order matters: 404 (unknown id) → 401 (timestamp,
	 * signature — one constant shape, so a prober can't distinguish
	 * which check failed) → 409 (paused; only signed callers learn the
	 * pause state) → 400 (payload size/shape; only signed callers get
	 * payload feedback).
	 */
	async fire(triggerId: string, input: FireInboundTriggerInput): Promise<FireInboundTriggerResult> {
		const row = await this.repo.findOne({ where: { id: triggerId } });
		if (!row) {
			throw new NotFoundException('Inbound trigger not found');
		}

		const now = Date.now();
		const timestampMs = this.parseTimestamp(input.timestampHeader);
		if (timestampMs === null || Math.abs(now - timestampMs) > REPLAY_WINDOW_MS) {
			throw this.unauthorized();
		}

		const providedHex = this.normalizeSignature(input.signatureHeader);
		if (!providedHex) {
			throw this.unauthorized();
		}
		const signedPayload = `${input.timestampHeader}.${input.rawBody}`;
		let verified = this.matchesSecret(row.secretEncrypted, signedPayload, providedHex);
		if (
			!verified &&
			row.previousSecretEncrypted &&
			row.rotatedAt &&
			now - row.rotatedAt.getTime() <= ROTATION_GRACE_MS
		) {
			verified = this.matchesSecret(row.previousSecretEncrypted, signedPayload, providedHex);
		}
		if (!verified) {
			throw this.unauthorized();
		}

		if (row.status !== 'active') {
			throw new ConflictException('Inbound trigger is paused');
		}

		if (Buffer.byteLength(input.rawBody, 'utf8') > MAX_FIRE_PAYLOAD_BYTES) {
			throw new BadRequestException('Payload exceeds the 64 KB limit');
		}
		if (this.isJsonContentType(input.contentType) && input.rawBody.trim().length > 0) {
			try {
				JSON.parse(input.rawBody);
			} catch {
				throw new BadRequestException('Payload must be valid JSON');
			}
		}

		const task = await this.tasks.create(row.userId, {
			title: this.renderTaskTitle(row),
			description: this.buildTaskDescription(row, input.rawBody),
			createdByType: 'user',
			createdById: row.userId,
		});

		if (row.targetAgentId) {
			// Best-effort — a since-archived agent must not lose the
			// delivery: the Task exists either way, only the assignment
			// is skipped (and logged).
			try {
				await this.tasks.addAssignee(row.userId, task.id, 'agent', row.targetAgentId);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.logger.warn(
					`Inbound trigger ${row.id} could not assign agent ${row.targetAgentId} to task ${task.id}: ${message}`,
				);
			}
		}

		// Single atomic row update — bumping the counter and stamping
		// lastFiredAt together avoids a torn write if the process dies between
		// two separate calls. The raw `"fireCount" + 1` increments in-place.
		await this.repo.update(row.id, {
			fireCount: () => '"fireCount" + 1',
			lastFiredAt: new Date()
		});

		return { ok: true, taskId: task.id, taskSlug: task.slug };
	}

	// ── internals ──────────────────────────────────────────────────────

	/**
	 * Ownership gate for every management route. Unknown id, foreign
	 * user, and foreign/mismatched Organization all surface as the SAME
	 * 404 — never 403 — so trigger ids can't be enumerated cross-org.
	 */
	private async findOwn(scope: InboundTriggerScope, id: string): Promise<InboundTrigger> {
		const row = await this.repo.findOne({ where: { id } });
		if (
			!row ||
			row.userId !== scope.userId ||
			(row.organizationId ?? null) !== (scope.organizationId ?? null)
		) {
			throw new NotFoundException('Inbound trigger not found');
		}
		return row;
	}

	private async assertAgentReachable(userId: string, agentId: string): Promise<void> {
		const agent = await this.agents.findByIdAndUser(agentId, userId).catch(() => null);
		if (!agent) {
			throw new BadRequestException(
				`Agent ${agentId} is not reachable for this user — cannot assign.`,
			);
		}
	}

	/** One constant 401 shape for every verification failure — no detail leak. */
	private unauthorized(): UnauthorizedException {
		return new UnauthorizedException('Invalid signature');
	}

	/** Accept unix epoch seconds (canonical) or milliseconds; null on garbage. */
	private parseTimestamp(header: string | undefined): number | null {
		if (!header || !/^\d{1,16}$/.test(header.trim())) return null;
		const value = Number(header.trim());
		if (!Number.isFinite(value) || value <= 0) return null;
		// 1e12 ≈ Sep 2001 in ms / Sep 33658 in s — a safe pivot.
		return value >= 1e12 ? value : value * 1000;
	}

	/** Strip an optional `sha256=` prefix; require exactly 64 hex chars. */
	private normalizeSignature(header: string | undefined): string | null {
		if (!header) return null;
		const value = header.trim().toLowerCase();
		const hex = value.startsWith('sha256=') ? value.slice('sha256='.length) : value;
		return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
	}

	private matchesSecret(secretEncrypted: string, signedPayload: string, providedHex: string): boolean {
		const secret = this.secrets.decrypt(secretEncrypted);
		if (!secret) return false;
		const expected = createHmac('sha256', secret).update(signedPayload, 'utf8').digest();
		const provided = Buffer.from(providedHex, 'hex');
		if (provided.length !== expected.length) return false;
		return timingSafeEqual(provided, expected);
	}

	private isJsonContentType(contentType: string | undefined): boolean {
		if (!contentType) return false;
		const value = contentType.toLowerCase();
		return value.includes('application/json') || value.includes('+json');
	}

	private renderTaskTitle(row: InboundTrigger): string {
		const template =
			row.taskTitleTemplate && row.taskTitleTemplate.trim().length > 0
				? row.taskTitleTemplate
				: DEFAULT_TASK_TITLE_TEMPLATE;
		const title = template.split('{name}').join(row.name).trim();
		const fallback = `Trigger: ${row.name}`.slice(0, MAX_TASK_TITLE_LENGTH);
		if (title.length < 1) return fallback;
		return title.slice(0, MAX_TASK_TITLE_LENGTH);
	}

	private buildTaskDescription(row: InboundTrigger, rawBody: string): string {
		const firedAt = new Date().toISOString();
		const lines = [
			`Fired by inbound trigger "${row.name}" (${row.id}) at ${firedAt}.`,
			'',
			'Payload:',
			'```json',
			rawBody.trim().length > 0 ? rawBody : '{}',
			'```',
		];
		return lines.join('\n');
	}

	private toView(row: InboundTrigger): InboundTriggerView {
		return {
			id: row.id,
			name: row.name,
			description: row.description ?? null,
			kind: row.kind,
			status: row.status,
			targetAgentId: row.targetAgentId ?? null,
			taskTitleTemplate: row.taskTitleTemplate ?? null,
			lastFiredAt: toIso(row.lastFiredAt),
			fireCount: row.fireCount,
			rotatedAt: toIso(row.rotatedAt),
			createdAt: toIso(row.createdAt) ?? '',
			updatedAt: toIso(row.updatedAt) ?? '',
		};
	}
}
