import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
    InboundTrigger,
    type InboundTriggerEventMatcher,
} from '../entities/inbound-trigger.entity';
import type { IngestedEvent } from '../entities/ingested-event.entity';
import { WebhookSubscriptionSecretService } from '../services/webhook-subscription-secret.service';
import { TasksService } from '../tasks-domain/tasks.service';
import { AgentRepository } from '../database/repositories/agent.repository';
import {
    DEFAULT_TASK_TITLE_TEMPLATE,
    MAX_FIRE_PAYLOAD_BYTES,
    MAX_TASK_DESCRIPTION_TEMPLATE_LENGTH,
    REPLAY_WINDOW_MS,
    ROTATION_GRACE_MS,
    TASK_TEMPLATE_SLUG_RE,
    TRIGGER_TEST_LABEL,
    type CreateInboundTriggerInput,
    type FireForEventResult,
    type FireInboundTriggerInput,
    type FireInboundTriggerResult,
    type InboundTriggerScope,
    type InboundTriggerView,
    type TestFireInboundTriggerResult,
    type UpdateInboundTriggerInput,
} from './inbound-trigger.types';
import { matchesEvent, normalizeEventMatcher } from './trigger-event-matcher';
import {
    findInvalidTemplatePlaceholders,
    renderTriggerTemplate,
    type TriggerTemplateEvent,
} from './trigger-template';
import { InboundTriggerFireRepository } from './inbound-trigger-fire.repository';
import {
    TASK_TEMPLATE_LOOKUP,
    type ResolvedTaskTemplate,
    type TaskTemplateLookup,
} from './task-template-lookup';

/** Task titles are capped at 200 by TasksService.assertTitle — clamp rendered templates. */
const MAX_TASK_TITLE_LENGTH = 200;

/** Shape check for `eventMatcher.workId` (any RFC-4122 version). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
        // Event-source firing (Task Triggers). Appended LAST + @Optional()
        // so every positional `new InboundTriggersService(...)` fixture
        // keeps compiling; without the ledger bound, `fireForEvent` is a
        // no-op (webhook firing is unaffected).
        @Optional() private readonly fires?: InboundTriggerFireRepository,
        // RESERVED template linkage (feature I) — see task-template-lookup.ts.
        // No provider exists on this branch; the slug degrades gracefully.
        @Optional()
        @Inject(TASK_TEMPLATE_LOOKUP)
        private readonly taskTemplates?: TaskTemplateLookup | null,
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
        const sourceType = input.sourceType ?? 'webhook';
        const eventMatcher = this.resolveEventMatcher(sourceType, input.eventMatcher);
        this.assertTemplateValid('taskTitleTemplate', input.taskTitleTemplate);
        this.assertTemplateValid('taskDescriptionTemplate', input.taskDescriptionTemplate);
        this.assertTemplateSlugValid(input.taskTemplateSlug);

        const { raw, encrypted } = this.secrets.generateSecret();
        const row = await this.repo.save(
            this.repo.create({
                userId: scope.userId,
                name,
                description: input.description ?? null,
                kind: input.kind ?? 'webhook',
                status: 'active',
                sourceType,
                eventMatcher,
                secretEncrypted: encrypted,
                previousSecretEncrypted: null,
                rotatedAt: null,
                targetAgentId: input.targetAgentId ?? null,
                taskTitleTemplate: input.taskTitleTemplate ?? null,
                taskDescriptionTemplate: input.taskDescriptionTemplate ?? null,
                taskTemplateSlug: input.taskTemplateSlug ?? null,
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
            this.assertTemplateValid('taskTitleTemplate', input.taskTitleTemplate);
            row.taskTitleTemplate = input.taskTitleTemplate;
        }
        if (input.taskDescriptionTemplate !== undefined) {
            this.assertTemplateValid('taskDescriptionTemplate', input.taskDescriptionTemplate);
            row.taskDescriptionTemplate = input.taskDescriptionTemplate;
        }
        if (input.taskTemplateSlug !== undefined) {
            this.assertTemplateSlugValid(input.taskTemplateSlug);
            row.taskTemplateSlug = input.taskTemplateSlug;
        }
        if (input.eventMatcher !== undefined) {
            if (row.sourceType !== 'event') {
                throw new BadRequestException(
                    'eventMatcher applies only to event-sourced triggers.',
                );
            }
            row.eventMatcher = this.resolveEventMatcher('event', input.eventMatcher);
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
    async fire(
        triggerId: string,
        input: FireInboundTriggerInput,
    ): Promise<FireInboundTriggerResult> {
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

        // Webhook fires render templates against a synthetic event whose
        // payload is the (JSON) body — so `{{event.payload.*}}` templates
        // work identically on both firing paths.
        const webhookEvent: TriggerTemplateEvent = {
            source: 'webhook',
            kind: 'webhook.fire',
            occurredAt: new Date(),
            payload: this.parsePayloadObject(input.rawBody),
        };
        const resolved = await this.resolveTemplateSlug(row);
        const task = await this.tasks.create(row.userId, {
            title: this.renderTaskTitle(row, webhookEvent, resolved),
            description:
                this.renderTaskDescription(row, webhookEvent, resolved) ??
                this.buildTaskDescription(row, input.rawBody),
            createdByType: 'user',
            createdById: row.userId,
        });

        await this.tryAssignAgent(row, task.id);

        // Single atomic row update — bumping the counter and stamping
        // lastFiredAt together avoids a torn write if the process dies between
        // two separate calls. The raw `"fireCount" + 1` increments in-place.
        await this.repo.update(row.id, {
            fireCount: () => '"fireCount" + 1',
            lastFiredAt: new Date(),
        });

        return { ok: true, taskId: task.id, taskSlug: task.slug };
    }

    /**
     * Ingest-spine firing path (Task Triggers) — offer one drained
     * `ingested_events` row to the owner's active `'event'` triggers.
     *
     * Contract with the ingest drain (which calls this through a
     * wildcard kind processor and may retry a batch after a partial
     * failure):
     *
     *   - IDEMPOTENT per (trigger, event): a trigger fires once per
     *     event, enforced by the `inbound_trigger_fires` UNIQUE claim —
     *     a retried batch re-offers the event and every trigger that
     *     already fired is a silent dedupe.
     *   - NEVER throws for a single bad trigger: per-trigger failures
     *     are logged and counted, the remaining triggers still fire,
     *     and the ingest row is never blocked by one broken rule.
     *
     * A fire = Task from the trigger's templates (title/description
     * rendered against the event), best-effort agent assignment, then
     * best-effort dispatch through `TasksService.runTask` — the same
     * gated path (credits precheck, in-flight valve) the board uses —
     * and finally the atomic `fireCount`/`lastFiredAt` bump the webhook
     * path performs.
     *
     * Scope rule: the trigger fires only for events in ITS OWN scope —
     * same user AND same organization (null-personal matches
     * null-personal), mirroring every other Tier A read.
     */
    async fireForEvent(event: IngestedEvent): Promise<FireForEventResult> {
        const result: FireForEventResult = { fired: 0, deduped: 0, failed: 0 };
        if (!this.fires) {
            // Ledger not bound (bare fixture) — refuse to fire without
            // the idempotency guarantee rather than double-firing.
            return result;
        }

        const rows = await this.repo.find({
            where: {
                userId: event.userId,
                organizationId: event.organizationId ? event.organizationId : IsNull(),
                sourceType: 'event',
                status: 'active',
            },
        });

        for (const row of rows) {
            if (!matchesEvent(row.eventMatcher, event)) continue;
            try {
                const won = await this.fires.claim(row.id, event.id);
                if (!won) {
                    result.deduped += 1;
                    continue;
                }
                const taskId = await this.fireTriggerForEvent(row, event);
                await this.fires.attachTask(row.id, event.id, taskId).catch(() => undefined);
                result.fired += 1;
            } catch (error) {
                result.failed += 1;
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(
                    `Event trigger ${row.id} failed for ingested event ${event.id} (${event.kind}): ${message}`,
                );
            }
        }
        return result;
    }

    /**
     * Rehearse a trigger without external input: synthesizes a sample
     * event shaped like what the matcher listens for, creates a REAL
     * Task labelled `trigger-test`, and assigns the target agent —
     * but does NOT dispatch a run, bump `fireCount`, or stamp
     * `lastFiredAt` (rehearsals must not look like production fires).
     */
    async testFire(
        scope: InboundTriggerScope,
        id: string,
    ): Promise<TestFireInboundTriggerResult> {
        const row = await this.findOwn(scope, id);
        const sample = this.buildSampleEvent(row);
        const resolved = await this.resolveTemplateSlug(row);
        const title = this.renderTaskTitle(row, sample, resolved);
        const description =
            this.renderTaskDescription(row, sample, resolved) ??
            [
                `Test fire of trigger "${row.name}" (${row.id}) at ${new Date().toISOString()}.`,
                '',
                'Sample event:',
                '```json',
                JSON.stringify(
                    { source: sample.source, kind: sample.kind, payload: sample.payload },
                    null,
                    2,
                ),
                '```',
            ].join('\n');
        const task = await this.tasks.create(row.userId, {
            title,
            description,
            labels: [TRIGGER_TEST_LABEL],
            createdByType: 'user',
            createdById: row.userId,
        });
        await this.tryAssignAgent(row, task.id);
        return { ok: true, taskId: task.id, taskSlug: task.slug, taskTitle: title };
    }

    // ── internals ──────────────────────────────────────────────────────

    /** One won claim → Task + assignment + gated dispatch + counters. Returns the task id. */
    private async fireTriggerForEvent(row: InboundTrigger, event: IngestedEvent): Promise<string> {
        const templateEvent: TriggerTemplateEvent = {
            id: event.id,
            source: event.source,
            kind: event.kind,
            title: event.title ?? null,
            actorName: event.actorName ?? null,
            sourceUrl: event.sourceUrl ?? null,
            subjectType: event.subjectType ?? null,
            subjectExternalId: event.subjectExternalId ?? null,
            occurredAt: event.occurredAt,
            workId: event.workId ?? null,
            payload: event.payload ?? {},
        };
        const resolved = await this.resolveTemplateSlug(row);
        const task = await this.tasks.create(row.userId, {
            title: this.renderTaskTitle(row, templateEvent, resolved),
            description:
                this.renderTaskDescription(row, templateEvent, resolved) ??
                this.buildEventTaskDescription(row, event),
            workId: event.workId ?? null,
            createdByType: 'user',
            createdById: row.userId,
        });

        await this.tryAssignAgent(row, task.id);

        // Dispatch through the SAME gated path the board uses (credits
        // precheck, in-flight valve). Best-effort: a gate refusal (no
        // credits, run already in flight) must not undo the fire.
        if (row.targetAgentId) {
            try {
                await this.tasks.runTask(row.userId, task.id, { agentId: row.targetAgentId });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(
                    `Event trigger ${row.id}: dispatch of task ${task.id} to agent ${row.targetAgentId} was refused: ${message}`,
                );
            }
        }

        // Same atomic bump as the webhook path — counter and timestamp
        // move together, incremented in-place.
        await this.repo.update(row.id, {
            fireCount: () => '"fireCount" + 1',
            lastFiredAt: new Date(),
        });
        return task.id;
    }

    /** A representative event for `testFire`, derived from the matcher when present. */
    private buildSampleEvent(row: InboundTrigger): TriggerTemplateEvent {
        const stripWildcard = (value: string | undefined, fallback: string): string => {
            if (!value || value === '*') return fallback;
            return value.endsWith('*') ? `${value.slice(0, -1)}sample` : value;
        };
        return {
            id: `test-${row.id}`,
            source: stripWildcard(row.eventMatcher?.source, 'test'),
            kind: stripWildcard(row.eventMatcher?.kind, 'test.event'),
            title: 'Sample event (test fire)',
            actorName: 'Test Fire',
            sourceUrl: null,
            subjectType: null,
            subjectExternalId: null,
            occurredAt: new Date(),
            workId: row.eventMatcher?.workId ?? null,
            payload: { sample: true },
        };
    }

    /** Default description for event-sourced fires with no template — provenance-first. */
    private buildEventTaskDescription(row: InboundTrigger, event: IngestedEvent): string {
        const lines = [
            `Fired by event trigger "${row.name}" (${row.id}) for ${event.source}/${event.kind}.`,
            '',
            ...(event.title ? [`Event: ${event.title}`] : []),
            ...(event.actorName ? [`Actor: ${event.actorName}`] : []),
            ...(event.sourceUrl ? [`Source: ${event.sourceUrl}`] : []),
            `Occurred at: ${event.occurredAt.toISOString()}`,
            '',
            'Payload:',
            '```json',
            JSON.stringify(event.payload ?? {}, null, 2),
            '```',
        ];
        return lines.join('\n');
    }

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

    private matchesSecret(
        secretEncrypted: string,
        signedPayload: string,
        providedHex: string,
    ): boolean {
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

    /**
     * Title = template-slug resolution (when bound) → trigger's own
     * template → default; legacy `{name}` expands first (webhook-era
     * contract), then the safe `{{…}}` placeholder pass.
     */
    private renderTaskTitle(
        row: InboundTrigger,
        event: TriggerTemplateEvent | null,
        resolved: ResolvedTaskTemplate | null,
    ): string {
        const own =
            row.taskTitleTemplate && row.taskTitleTemplate.trim().length > 0
                ? row.taskTitleTemplate
                : null;
        const fromSlug =
            resolved?.titleTemplate && resolved.titleTemplate.trim().length > 0
                ? resolved.titleTemplate
                : null;
        const template = fromSlug ?? own ?? DEFAULT_TASK_TITLE_TEMPLATE;
        const withName = template.split('{name}').join(row.name);
        const title = renderTriggerTemplate(withName, {
            trigger: { name: row.name },
            event,
        }).trim();
        const fallback = `Trigger: ${row.name}`.slice(0, MAX_TASK_TITLE_LENGTH);
        if (title.length < 1) return fallback;
        return title.slice(0, MAX_TASK_TITLE_LENGTH);
    }

    /** Rendered description template, or null when the trigger has none. */
    private renderTaskDescription(
        row: InboundTrigger,
        event: TriggerTemplateEvent | null,
        resolved: ResolvedTaskTemplate | null,
    ): string | null {
        const own =
            row.taskDescriptionTemplate && row.taskDescriptionTemplate.trim().length > 0
                ? row.taskDescriptionTemplate
                : null;
        const fromSlug =
            resolved?.descriptionTemplate && resolved.descriptionTemplate.trim().length > 0
                ? resolved.descriptionTemplate
                : null;
        const template = fromSlug ?? own;
        if (!template) return null;
        return renderTriggerTemplate(template, { trigger: { name: row.name }, event });
    }

    /**
     * Lazily resolve the reserved `taskTemplateSlug` linkage. Absent
     * lookup (feature I not merged), missing slug, or a lookup error
     * all degrade to `null` — the trigger's own templates apply.
     */
    private async resolveTemplateSlug(row: InboundTrigger): Promise<ResolvedTaskTemplate | null> {
        if (!row.taskTemplateSlug || !this.taskTemplates) return null;
        try {
            return await this.taskTemplates.findBySlug(row.userId, row.taskTemplateSlug);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `Inbound trigger ${row.id}: task-template lookup for slug "${row.taskTemplateSlug}" failed: ${message}`,
            );
            return null;
        }
    }

    /** Best-effort agent assignment — the Task must exist either way. */
    private async tryAssignAgent(row: InboundTrigger, taskId: string): Promise<void> {
        if (!row.targetAgentId) return;
        try {
            await this.tasks.addAssignee(row.userId, taskId, 'agent', row.targetAgentId);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `Inbound trigger ${row.id} could not assign agent ${row.targetAgentId} to task ${taskId}: ${message}`,
            );
        }
    }

    /** JSON-object body → payload for template rendering; anything else → {}. */
    private parsePayloadObject(rawBody: string): Record<string, unknown> {
        if (!rawBody || rawBody.trim().length === 0) return {};
        try {
            const parsed: unknown = JSON.parse(rawBody);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            // Non-JSON webhook bodies simply render no payload placeholders.
        }
        return {};
    }

    /**
     * Matcher required for event triggers (an empty one would match
     * nothing forever — reject loudly); forced null for webhook ones.
     */
    private resolveEventMatcher(
        sourceType: string,
        matcher: InboundTriggerEventMatcher | null | undefined,
    ): InboundTriggerEventMatcher | null {
        if (sourceType !== 'event') {
            if (matcher && Object.keys(matcher).length > 0) {
                throw new BadRequestException(
                    'eventMatcher applies only to event-sourced triggers.',
                );
            }
            return null;
        }
        const normalized = normalizeEventMatcher(matcher);
        if (!normalized) {
            throw new BadRequestException(
                'Event triggers need an eventMatcher with at least one of: source, kind, workId.',
            );
        }
        if (normalized.workId !== undefined && !UUID_RE.test(normalized.workId)) {
            throw new BadRequestException('eventMatcher.workId must be a uuid.');
        }
        return normalized;
    }

    /** Save-time placeholder-grammar check — authoring mistakes 400 here, not at fire time. */
    private assertTemplateValid(field: string, template: string | null | undefined): void {
        if (template === null || template === undefined) return;
        if (
            field === 'taskDescriptionTemplate' &&
            template.length > MAX_TASK_DESCRIPTION_TEMPLATE_LENGTH
        ) {
            throw new BadRequestException(
                `${field} must be at most ${MAX_TASK_DESCRIPTION_TEMPLATE_LENGTH} characters.`,
            );
        }
        const invalid = findInvalidTemplatePlaceholders(template);
        if (invalid.length > 0) {
            throw new BadRequestException(
                `${field} has unsupported placeholders: ${invalid.join(', ')}. ` +
                    'Allowed: {{trigger.name}}, {{event.<field>}}, {{event.payload.<key>}}.',
            );
        }
    }

    private assertTemplateSlugValid(slug: string | null | undefined): void {
        if (slug === null || slug === undefined) return;
        if (!TASK_TEMPLATE_SLUG_RE.test(slug)) {
            throw new BadRequestException(
                'taskTemplateSlug must be a kebab-case slug (a-z, 0-9, dashes; max 80 chars).',
            );
        }
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
            sourceType: row.sourceType ?? 'webhook',
            eventMatcher: normalizeEventMatcher(row.eventMatcher),
            targetAgentId: row.targetAgentId ?? null,
            taskTitleTemplate: row.taskTitleTemplate ?? null,
            taskDescriptionTemplate: row.taskDescriptionTemplate ?? null,
            taskTemplateSlug: row.taskTemplateSlug ?? null,
            lastFiredAt: toIso(row.lastFiredAt),
            fireCount: row.fireCount,
            rotatedAt: toIso(row.rotatedAt),
            createdAt: toIso(row.createdAt) ?? '',
            updatedAt: toIso(row.updatedAt) ?? '',
        };
    }
}
