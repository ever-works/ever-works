import { ApiProperty } from '@nestjs/swagger';
import {
    IsArray,
    IsBoolean,
    IsEmail,
    IsEnum,
    IsIn,
    IsInt,
    IsNotEmpty,
    IsNumber,
    IsObject,
    IsOptional,
    IsString,
    IsUUID,
    Matches,
    Max,
    MaxLength,
    Min,
    MinLength,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
    AGENT_GUARDRAIL_MODES,
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentScope,
    AgentStatus,
    type AgentGuardrails,
} from '@ever-works/agent/agents';
import {
    AGENT_ACTION_PROPOSAL_ACTION_TYPES,
    type AgentActionProposalActionType,
} from '@ever-works/agent/agent-approvals';
// Capabilities tab — the one init-script size cap, shared with the
// service-side byte check.
// Session detail — the one timeline-cursor shape, shared with the
// controller's parser and the store's keyset predicate.
// AW-23 — the pause-note cap, the batched status-read cap and the held
// list's page size, imported rather than re-typed so the dialog counter,
// the validator and the query cap can never disagree.
import {
    AGENT_HALT_NOTE_MAX,
    AGENT_HELD_WORK_PAGE_SIZE,
    AGENT_INIT_SCRIPT_MAX_BYTES,
    AGENT_RUN_TIMELINE_CURSOR_PATTERN,
    AGENT_STATUS_BATCH_MAX,
} from '@ever-works/contracts';
// Entity-free validation subpath on purpose — see the docstring on
// `@ever-works/agent/validation`.
import { MergePolicyDto } from '@ever-works/agent/validation';

/**
 * AW-20 — accepted shape of `agents.lane`: kebab-case, at most 32
 * characters, starting with an alphanumeric. Declared once so the create
 * and update DTOs cannot drift apart from each other or from the
 * `varchar(32)` column behind them.
 */
const AGENT_LANE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Permissions partial sent on create/update — every flag optional;
 * unset = inherit conservative default (all false).
 */
export class AgentPermissionsDto {
    @ApiProperty({ required: false }) @IsOptional() @IsBoolean() canCreateAgents?: boolean;
    @ApiProperty({ required: false }) @IsOptional() @IsBoolean() canAssignTasks?: boolean;
    @ApiProperty({ required: false }) @IsOptional() @IsBoolean() canEditSkills?: boolean;
    @ApiProperty({ required: false }) @IsOptional() @IsBoolean() canEditAgentFiles?: boolean;
    @ApiProperty({ required: false }) @IsOptional() @IsBoolean() canSpend?: boolean;
    @ApiProperty({ required: false }) @IsOptional() @IsBoolean() canCommitToRepo?: boolean;
    @ApiProperty({ required: false }) @IsOptional() @IsBoolean() canOpenPullRequests?: boolean;
    @ApiProperty({ required: false }) @IsOptional() @IsBoolean() canCallExternalTools?: boolean;
}

/**
 * Agent Scorecards increment 1 — one quantified goal on an Agent's
 * scorecard. Mirrors `AgentScorecardMetric` on the agent entity; the
 * service re-validates via `validateScorecard` (defense-in-depth for
 * non-HTTP callers).
 */
export class AgentScorecardMetricDto {
    @ApiProperty({ maxLength: 64, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' })
    @IsString()
    @MaxLength(64)
    @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    key: string;

    @ApiProperty({ minLength: 1, maxLength: 80 })
    @IsString()
    @MinLength(1)
    @MaxLength(80)
    label: string;

    // @IsNumber() rejects NaN/Infinity by default (allowNaN/allowInfinity
    // false) — matches the service's finite-number rule.
    @ApiProperty()
    @IsNumber()
    target: number;

    @ApiProperty()
    @IsNumber()
    current: number;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsNumber()
    floor?: number | null;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsNumber()
    stretch?: number | null;

    @ApiProperty({ required: false, nullable: true, maxLength: 20 })
    @IsOptional()
    @IsString()
    @MaxLength(20)
    unit?: string | null;

    @ApiProperty({ enum: ['weekly', 'monthly', 'quarterly'] })
    @IsIn(['weekly', 'monthly', 'quarterly'])
    period: 'weekly' | 'monthly' | 'quarterly';
}

export class AgentTargetDto {
    @ApiProperty({ enum: ['mission', 'idea', 'work', 'wildcard'] })
    @IsEnum(['mission', 'idea', 'work', 'wildcard'] as const)
    type: 'mission' | 'idea' | 'work' | 'wildcard';

    @ApiProperty({ required: false })
    @IsOptional()
    @IsUUID()
    id?: string;
}

/**
 * Body of `POST /api/agents/:id/targets` (and of the matching DELETE) —
 * ONE reach target to add to, or remove from, an Agent.
 * Single-target rather than a whole-array PATCH so the Work header's
 * "Assign existing Agent" picker doesn't have to read-modify-write
 * `targets` and race every other editor of the same Agent.
 *
 * `wildcard` is deliberately NOT accepted here: granting an Agent reach
 * over everything is a different decision from putting it on one Work,
 * and it belongs on the Agent's own settings surface.
 */
export class AgentTargetBodyDto {
    @ApiProperty({ enum: ['mission', 'idea', 'work'] })
    @IsIn(['mission', 'idea', 'work'] as const)
    type: 'mission' | 'idea' | 'work';

    @ApiProperty()
    @IsUUID()
    id: string;
}

export class CreateAgentDto {
    @ApiProperty({ enum: AgentScope })
    @IsEnum(AgentScope)
    scope: AgentScope;

    @ApiProperty({ required: false }) @IsOptional() @IsUUID() missionId?: string;
    @ApiProperty({ required: false }) @IsOptional() @IsUUID() ideaId?: string;
    @ApiProperty({ required: false }) @IsOptional() @IsUUID() workId?: string;

    @ApiProperty({ minLength: 1, maxLength: 120 })
    @IsString()
    @MinLength(1)
    @MaxLength(120)
    @IsNotEmpty()
    name: string;

    @ApiProperty({ required: false, maxLength: 200 })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    title?: string;

    @ApiProperty({ required: false, maxLength: 5000 })
    @IsOptional()
    @IsString()
    @MaxLength(5000)
    capabilities?: string;

    /**
     * AW-20 — the area of work this Agent owns (`research`, `content`,
     * `coordination`, …). A label, never a permission: nothing in the
     * authorization path reads it. Unique per user, enforced by the
     * partial index `uq_agents_user_lane`.
     */
    @ApiProperty({ required: false, maxLength: 32, pattern: '^[a-z0-9][a-z0-9-]{0,31}$' })
    @IsOptional()
    @IsString()
    @Matches(AGENT_LANE_PATTERN)
    lane?: string;

    @ApiProperty({ required: false, maxLength: 100 })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    aiProviderId?: string;

    @ApiProperty({ required: false, maxLength: 100 })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    modelId?: string;

    /**
     * Environments (Settings → Environments) — assigned runtime
     * Environment. Must be the caller's own PUBLISHED Environment
     * (draft → 422, cross-user/unknown → 404; service-enforced).
     */
    @ApiProperty({ required: false })
    @IsOptional()
    @IsUUID()
    environmentId?: string;

    @ApiProperty({ required: false, minimum: 0, maximum: 20000 })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(20000)
    maxSkillContextTokens?: number;

    @ApiProperty({
        required: false,
        description: "Cron expression or 'manual'; null = manual.",
        maxLength: 64,
    })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    heartbeatCadence?: string;

    @ApiProperty({ required: false, enum: AgentIdleBehavior })
    @IsOptional()
    @IsEnum(AgentIdleBehavior)
    idleBehavior?: AgentIdleBehavior;

    @ApiProperty({ required: false, minimum: 1, maximum: 20 })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(20)
    pauseAfterFailures?: number;

    @ApiProperty({ required: false, type: AgentPermissionsDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => AgentPermissionsDto)
    permissions?: AgentPermissionsDto;

    @ApiProperty({ required: false, type: [AgentTargetDto] })
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => AgentTargetDto)
    targets?: AgentTargetDto[];

    @ApiProperty({ required: false, enum: AgentAvatarMode })
    @IsOptional()
    @IsEnum(AgentAvatarMode)
    avatarMode?: AgentAvatarMode;

    @ApiProperty({ required: false, maxLength: 64 })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    avatarIcon?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsUUID()
    avatarImageUploadId?: string;

    // FU-13 — per-Agent git committer identity. Both nullable; when
    // unset, the AGENT_GIT_FACADE binding falls back to the Agent's
    // name + a synthesized email (see entity docstring + spec).
    @ApiProperty({ required: false, maxLength: 120 })
    @IsOptional()
    @IsString()
    @MaxLength(120)
    committerName?: string;

    @ApiProperty({ required: false, maxLength: 254 })
    @IsOptional()
    @IsEmail()
    @MaxLength(254)
    committerEmail?: string;
}

/**
 * Wave 10 — POST /api/agents/from-template/:slug body. Everything is an
 * OPTIONAL placement override: prompt, permissions, guardrails, and
 * capabilities always come from the template itself.
 */
export class CreateAgentFromTemplateDto {
    @ApiProperty({ required: false, minLength: 1, maxLength: 120 })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(120)
    name?: string;

    @ApiProperty({ required: false, enum: AgentScope })
    @IsOptional()
    @IsEnum(AgentScope)
    scope?: AgentScope;

    @ApiProperty({ required: false }) @IsOptional() @IsUUID() missionId?: string;
    @ApiProperty({ required: false }) @IsOptional() @IsUUID() ideaId?: string;
    @ApiProperty({ required: false }) @IsOptional() @IsUUID() workId?: string;
}

export class UpdateAgentDto {
    @ApiProperty({ required: false, minLength: 1, maxLength: 120 })
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(120)
    name?: string;

    @ApiProperty({ required: false, maxLength: 200 })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    title?: string | null;

    @ApiProperty({ required: false, maxLength: 5000 })
    @IsOptional()
    @IsString()
    @MaxLength(5000)
    capabilities?: string | null;

    /** AW-20 — the area of work this Agent owns; `null` clears it. */
    @ApiProperty({ required: false, maxLength: 32, pattern: '^[a-z0-9][a-z0-9-]{0,31}$' })
    @IsOptional()
    @IsString()
    @Matches(AGENT_LANE_PATTERN)
    lane?: string | null;

    @ApiProperty({ required: false, maxLength: 100 })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    aiProviderId?: string | null;

    @ApiProperty({ required: false, maxLength: 100 })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    modelId?: string | null;

    /**
     * Environments (Settings → Environments) — assigned runtime
     * Environment; `null` clears back to the platform default. A
     * non-null id must be the caller's own PUBLISHED Environment
     * (draft → 422, cross-user/unknown → 404; service-enforced).
     */
    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsUUID()
    environmentId?: string | null;

    @ApiProperty({ required: false, minimum: 0, maximum: 20000 })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(20000)
    maxSkillContextTokens?: number;

    @ApiProperty({
        required: false,
        description:
            'Memory recall injection toggle (on by default). When false, task-kind runs of this Agent skip the fenced agent-memory recall block.',
    })
    @IsOptional()
    @IsBoolean()
    memoryRecallEnabled?: boolean;

    @ApiProperty({ required: false, maxLength: 64 })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    heartbeatCadence?: string | null;

    @ApiProperty({ required: false, enum: AgentIdleBehavior })
    @IsOptional()
    @IsEnum(AgentIdleBehavior)
    idleBehavior?: AgentIdleBehavior;

    @ApiProperty({ required: false, minimum: 1, maximum: 20 })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(20)
    pauseAfterFailures?: number;

    @ApiProperty({ required: false, type: AgentPermissionsDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => AgentPermissionsDto)
    permissions?: AgentPermissionsDto;

    @ApiProperty({ required: false, type: [AgentTargetDto] })
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => AgentTargetDto)
    targets?: AgentTargetDto[] | null;

    @ApiProperty({ required: false, enum: AgentAvatarMode })
    @IsOptional()
    @IsEnum(AgentAvatarMode)
    avatarMode?: AgentAvatarMode;

    @ApiProperty({ required: false, maxLength: 64 })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    avatarIcon?: string | null;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsUUID()
    avatarImageUploadId?: string | null;

    // FU-13 — committer identity (also editable post-create).
    @ApiProperty({ required: false, maxLength: 120 })
    @IsOptional()
    @IsString()
    @MaxLength(120)
    committerName?: string | null;

    @ApiProperty({ required: false, maxLength: 254 })
    @IsOptional()
    @IsEmail()
    @MaxLength(254)
    committerEmail?: string | null;

    @ApiProperty({
        required: false,
        nullable: true,
        description: 'Direct manager Agent id for the Org Chart; null clears it',
    })
    @IsOptional()
    @IsUUID()
    reportsToAgentId?: string | null;

    // Agent Scorecards increment 1 — whole-array replace; null clears.
    @ApiProperty({ required: false, type: [AgentScorecardMetricDto] })
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => AgentScorecardMetricDto)
    scorecard?: AgentScorecardMetricDto[] | null;

    /**
     * Merge-policy matrix (Wave 3, D4) — this Agent's slice, the MOST
     * specific scope. Every field inside is optional and inherits when
     * omitted; `null` clears the Agent override entirely.
     */
    @ApiProperty({ required: false, type: MergePolicyDto, nullable: true })
    @IsOptional()
    @ValidateNested()
    @Type(() => MergePolicyDto)
    mergePolicy?: MergePolicyDto | null;

    /**
     * Capabilities tab — per-Agent init script (advisory v1: stored now,
     * consumed at session/workspace bootstrap where the runtime supports
     * it). `null` clears it.
     *
     * The cap here counts CHARACTERS (class-validator's only length rule)
     * and is a cheap front gate; `AgentsService.update` re-enforces the
     * same number as BYTES — the authoritative check, since that is what
     * the column stores — plus a hard-reject secret scan. Sharing the one
     * constant keeps the two from drifting apart.
     */
    @ApiProperty({
        required: false,
        nullable: true,
        maxLength: AGENT_INIT_SCRIPT_MAX_BYTES,
        description: 'Init script run at session/workspace bootstrap where supported; null clears',
    })
    @IsOptional()
    @IsString()
    @MaxLength(AGENT_INIT_SCRIPT_MAX_BYTES)
    initScript?: string | null;
}

/**
 * Agent Dispatch Guardrails policy body — mirrors the pure
 * `AgentGuardrails` shape (`packages/agent/src/agents/guardrails.ts`).
 * The service re-validates via `validateGuardrails` (defense-in-depth),
 * so this DTO only has to shape-check for the global ValidationPipe.
 */
export class AgentGuardrailsDto implements AgentGuardrails {
    @ApiProperty({ enum: AGENT_GUARDRAIL_MODES as unknown as string[] })
    @IsIn(AGENT_GUARDRAIL_MODES as unknown as string[])
    mode: 'require_approval' | 'autonomous';

    @ApiProperty({
        required: false,
        isArray: true,
        enum: AGENT_ACTION_PROPOSAL_ACTION_TYPES as unknown as string[],
        description:
            'Autonomous-mode narrowing: only these action types may auto-approve. Omitted = all.',
    })
    @IsOptional()
    @IsArray()
    @IsIn(AGENT_ACTION_PROPOSAL_ACTION_TYPES as unknown as string[], { each: true })
    autoApproveActionTypes?: AgentActionProposalActionType[];

    @ApiProperty({
        required: false,
        isArray: true,
        enum: AGENT_ACTION_PROPOSAL_ACTION_TYPES as unknown as string[],
        description: 'Action types this Agent may never take — auto-rejected with an audit row.',
    })
    @IsOptional()
    @IsArray()
    @IsIn(AGENT_ACTION_PROPOSAL_ACTION_TYPES as unknown as string[], { each: true })
    blockedActionTypes?: AgentActionProposalActionType[];
}

/**
 * Body for `PUT /api/agents/:id/guardrails`. PUT semantics — the whole
 * policy is replaced. `{"guardrails": null}` (or an omitted field)
 * clears back to the default queue-everything posture.
 */
export class UpdateAgentGuardrailsDto {
    @ApiProperty({ required: false, type: AgentGuardrailsDto, nullable: true })
    @IsOptional()
    @ValidateNested()
    @Type(() => AgentGuardrailsDto)
    guardrails?: AgentGuardrailsDto | null;
}

export class ListAgentsQueryDto {
    @ApiProperty({ required: false, enum: AgentScope })
    @IsOptional()
    @IsEnum(AgentScope)
    scope?: AgentScope;

    @ApiProperty({ required: false, enum: AgentStatus })
    @IsOptional()
    @IsEnum(AgentStatus)
    status?: AgentStatus;

    @ApiProperty({ required: false }) @IsOptional() @IsUUID() missionId?: string;
    @ApiProperty({ required: false }) @IsOptional() @IsUUID() ideaId?: string;
    @ApiProperty({ required: false }) @IsOptional() @IsUUID() workId?: string;

    @ApiProperty({
        required: false,
        description:
            'Tenant-scoped Agents ASSIGNED to this Work (their `targets` include it), as opposed to `workId`, which matches Agents pinned to the Work by scope.',
    })
    @IsOptional()
    @IsUUID()
    assignedWorkId?: string;

    @ApiProperty({
        required: false,
        description:
            'Agents ASSIGNED to this Idea (their `targets` include it), as opposed to `ideaId`, which matches Agents pinned to the Idea by scope.',
    })
    @IsOptional()
    @IsUUID()
    assignedIdeaId?: string;

    @ApiProperty({ required: false, maxLength: 80 })
    @IsOptional()
    @IsString()
    @MaxLength(80)
    search?: string;

    @ApiProperty({ required: false, minimum: 1, maximum: 200 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(200)
    limit?: number;

    @ApiProperty({ required: false, minimum: 0 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    offset?: number;
}

/**
 * FU-2 — pagination DTO for `GET /api/agents/:id/runs`.
 */
export class ListAgentRunsQueryDto {
    @ApiProperty({ required: false, minimum: 1, maximum: 200 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(200)
    limit?: number;

    @ApiProperty({ required: false, minimum: 0 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    offset?: number;
}

/**
 * Run orchestration (Wave 4 M3) — filters for the org-wide Sessions
 * list (`GET /api/agents/runs`). Every filter optional; unset = all of
 * the caller's runs. Enum whitelists mirror the entity unions — an
 * unrecognized value is a 400, never a silent full-table answer.
 */
export class ListRunSessionsQueryDto {
    @ApiProperty({
        required: false,
        enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
    })
    @IsOptional()
    @IsIn(['queued', 'running', 'completed', 'failed', 'cancelled'])
    status?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

    @ApiProperty({ required: false, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    workId?: string;

    @ApiProperty({ required: false, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    agentId?: string;

    /** Quality gates (Wave 3 M6) — the Task detail Checks section fetches
     *  the latest run for one Task (`taskId` + `limit=1`). */
    @ApiProperty({ required: false, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    taskId?: string;

    /** Trigger kind — named `kind` on the wire for the Sessions view. */
    @ApiProperty({ required: false, enum: ['heartbeat', 'manual', 'task', 'chat', 'event'] })
    @IsOptional()
    @IsIn(['heartbeat', 'manual', 'task', 'chat', 'event'])
    kind?: 'heartbeat' | 'manual' | 'task' | 'chat' | 'event';

    /**
     * State-aware sweeper (Wave 4 M6) — the needs-attention quick filter.
     *
     * `attention=1` narrows to runs a human has to look at: the agent
     * asked a question (`awaitingInput`) OR the platform raised a
     * lifecycle flag (`attentionReason`). Accepted as `1`/`true` so the
     * deep link in the notification (`/agents/sessions?attention=1`) works
     * verbatim; any other value (including absent) leaves the list
     * unfiltered, which is today's behavior.
     */
    @ApiProperty({ required: false, enum: ['1', 'true'] })
    @IsOptional()
    @IsIn(['1', 'true'])
    attention?: '1' | 'true';

    @ApiProperty({ required: false, minimum: 1, maximum: 200 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(200)
    limit?: number;

    @ApiProperty({ required: false, minimum: 0 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    offset?: number;
}

/**
 * Session detail (Feature K) — query for
 * `GET /api/agents/runs/:runId/detail`. The cursor is the opaque
 * `<epochMillis>_<tieBreak>` token the previous page's `nextCursor`
 * carried; the format is validated at the edge so a garbage cursor is a
 * 400, not a silently ignored restart.
 *
 * The tie-break half is whichever column the store orders equal
 * timestamps by, so it is EITHER an integer insertion-order key or a uuid
 * row id. Both are accepted: a uuid keeps every cursor a browser minted
 * before the integer form existed working.
 *
 * Those two are also ALL that is accepted, and the shared pattern is what
 * keeps that promise honest. A tie-break of some third shape is a value no
 * store's tie-break column can hold — binding one against the run-log
 * `uuid` primary key is `invalid input syntax for type uuid` on Postgres,
 * i.e. a 500 for what this decorator exists to answer as a 400 — so the
 * edge admits exactly the set `@ever-works/contracts` also teaches the
 * store to consume. See `run-timeline-cursor.ts`.
 */
export class SessionDetailQueryDto {
    @ApiProperty({ required: false, description: 'Opaque timeline cursor from `nextCursor`.' })
    @IsOptional()
    @IsString()
    @Matches(AGENT_RUN_TIMELINE_CURSOR_PATTERN)
    cursor?: string;

    @ApiProperty({ required: false, minimum: 1, maximum: 200 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(200)
    limit?: number;
}

/**
 * Run steering (Wave 4 M5) — payload for
 * `POST /api/agents/:id/runs/:runId/steer`.
 *
 * The body cap mirrors the task-chat body cap (16 KB): steering is short
 * by intent, and the message crosses a trust boundary into a live session's
 * message list, so it is size-capped at the edge as well as in the service.
 */
export class SteerRunDto {
    @ApiProperty({ maxLength: 16384 })
    @IsString()
    @IsNotEmpty()
    @MaxLength(16384)
    message: string;
}

/**
 * Run steering (Wave 4 M5) — payload for
 * `POST /api/agents/:id/runs/:runId/resume`. The message is optional:
 * resuming a parked session with no new instruction is a valid, common
 * action ("carry on").
 */
export class ResumeRunDto {
    @ApiProperty({ required: false, maxLength: 16384 })
    @IsOptional()
    @IsString()
    @MaxLength(16384)
    message?: string;
}

/**
 * AW-23 — the OPTIONAL body of `POST /api/agents/:id/pause`.
 *
 * Optional in the strict sense: the endpoint kept its path, its verb and
 * its success shape, and a pause posted with no body at all behaves
 * exactly as it did before this shipped. Everything here is something a
 * person chose to add.
 */
export class PauseAgentDto {
    /**
     * Why this agent is being paused, in the owner's own words. Shown on
     * the identity card and carried into the activity entry, so the
     * answer to "why is this one stopped?" survives the person who knew.
     *
     * Secret-scanned on write: the note is stored as plain text and
     * rendered back, so a pasted key is refused rather than persisted.
     */
    @ApiProperty({ required: false, maxLength: AGENT_HALT_NOTE_MAX })
    @IsOptional()
    @IsString()
    @MaxLength(AGENT_HALT_NOTE_MAX)
    note?: string;

    /**
     * Also ask any run still in flight to stop, through the existing
     * cooperative interrupt.
     *
     * Defaults to false on purpose: a pause stops everything NEW and lets
     * what is already running finish. Killing live work is a second,
     * explicit decision, never a side effect of pressing Pause.
     */
    @ApiProperty({ required: false, default: false })
    @IsOptional()
    @IsBoolean()
    stopInFlight?: boolean;
}

/**
 * AW-23 — query for the batched roster read `GET /api/agents/status`.
 *
 * One request covers a whole visible page of agents. Over
 * `AGENT_STATUS_BATCH_MAX` ids the request is refused rather than
 * silently truncated, so a caller can never believe it polled more
 * agents than it did.
 */
export class AgentStatusQueryDto {
    @ApiProperty({
        description: `Comma-separated Agent ids. At most ${AGENT_STATUS_BATCH_MAX}.`,
    })
    @IsString()
    @IsNotEmpty()
    ids: string;
}

/** AW-23 — query for `GET /api/agents/:id/held`. */
export class ListAgentHeldQueryDto {
    @ApiProperty({ required: false, default: AGENT_HELD_WORK_PAGE_SIZE })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    limit?: number;
}

/**
 * FU-2 — payload for `POST /api/agents/:id/assign-task`.
 */
export class AssignTaskToAgentDto {
    @ApiProperty()
    @IsUUID()
    taskId: string;
}

/**
 * Payload for `POST /api/agents/:id/attachments`.
 *
 * Security (EW-710 wave M): mirrors `AddAttachmentDto` (tasks) and
 * `AddWorkProposalAttachmentDto` (work-proposals) so the global
 * ValidationPipe schema-validates `uploadId` instead of accepting a
 * raw inline `{ uploadId: string }` object with no decorators.
 */
export class AddAgentAttachmentDto {
    // `uploadId` is the SHA-256 hex id returned by `POST /api/uploads/file`
    // (NOT a UUID). The previous `@IsUUID()` rejected every real upload id and
    // contradicted the service's own `SHA256_RE` guard, so agent attachments
    // could never succeed. Align with the Mission / Idea attachment DTOs.
    @ApiProperty({ pattern: '^[0-9a-fA-F]{64}$' })
    @IsString()
    @Matches(/^[0-9a-f]{64}$/i)
    uploadId: string;
}

/**
 * Payload for `PUT /api/agents/:id/collaborators/:collaboratorAgentId`.
 *
 * Agent Collaborators — the upsert body is exactly the toggle state.
 * Whitelisted (global `forbidNonWhitelisted`): any extra field 400s.
 */
export class UpdateAgentCollaboratorDto {
    @ApiProperty({ description: 'Whether this collaborator may be spawned as a sub-agent.' })
    @IsBoolean()
    enabled: boolean;
}
