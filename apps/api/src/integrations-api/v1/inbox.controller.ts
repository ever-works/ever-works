import {
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    Req,
    Res,
    UseFilters,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsISO8601,
    IsOptional,
    IsString,
    IsUUID,
    Length,
    MaxLength,
    ValidateBy,
    ValidateNested,
    type ValidationOptions,
} from 'class-validator';
import { InboxService } from '@ever-works/agent/inbox';
import {
    assertIfMatch,
    IntegrationIdempotencyService,
    IntegrationInboxService,
    type ExternalInboxWriter,
    type IntegrationInboxItem,
    type KeysetPage,
    parseIfMatch,
} from '@ever-works/agent/integrations-api';
import {
    INBOX_EMAIL_FROM_MAX_CHARS,
    INBOX_EMAIL_RECEIVED_AT_MAX_CHARS,
    INBOX_EMAIL_SUBJECT_MAX_CHARS,
    INBOX_EMAIL_TO_MAX_CHARS,
    INBOX_EXTERNAL_BODY_MAX_CHARS,
    INBOX_EXTERNAL_ID_MAX_CHARS,
    INBOX_EXTERNAL_ITEM_KINDS,
    INBOX_EXTERNAL_MAX_CHOICES,
    INBOX_ITEM_KINDS,
    INBOX_ITEM_STATUSES,
    INBOX_MAX_OPTION_ID_CHARS,
    INBOX_MAX_OPTION_LABEL_CHARS,
    INBOX_MAX_REPLY_CHARS,
    INBOX_MAX_TITLE_CHARS,
    INBOX_SOURCE_LABEL_MAX_CHARS,
    INBOX_SOURCE_URL_MAX_CHARS,
    INTEGRATION_INDIVIDUAL_DECISION_SCOPE,
    INTEGRATION_MERGE_DECISION_SCOPE,
    isSafeInboxSourceUrl,
    type IntegrationInboxItemDto,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser, IntegrationPrincipal } from '../../auth/types/auth.types';
import { RequireScopes } from '../../auth/integration/integration.decorators';
import { IntegrationHttpException } from '../../auth/integration/integration-http.exception';
import { ScopeContextService } from '../../scope/scope-context.service';
import { IntegrationOnlyGuard } from './integration-only.guard';
import { IntegrationExceptionFilter } from './integration-exception.filter';
import {
    runIdempotent,
    type IdempotentRequest,
    type IdempotentResponse,
} from './integration-idempotency';
import {
    IsOptionalNonNull,
    listParam,
    parseLimit,
    parseUpdatedSince,
    pinnedOrganizationOf,
    principalOf,
    rethrowCursor,
    validationFailed,
} from './integration-request';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `sourceUrl`: an absolute `https:` URL without credentials (contracts `isSafeInboxSourceUrl`). */
function IsSafeInboxSourceUrl(options?: ValidationOptions): PropertyDecorator {
    return ValidateBy(
        {
            name: 'isSafeInboxSourceUrl',
            validator: {
                validate: (value: unknown) => isSafeInboxSourceUrl(value),
                defaultMessage: () =>
                    `sourceUrl must be an absolute https URL without credentials, at most ${INBOX_SOURCE_URL_MAX_CHARS} characters`,
            },
        },
        options,
    );
}

/** `InboxItemRelated` (contract v1 requests.schema.json): Ever Works ids of the pinned organization. */
export class IntegrationInboxRelatedDto {
    @ApiProperty({ required: false, nullable: true, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    taskId?: string | null;

    @ApiProperty({ required: false, nullable: true, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    workId?: string | null;

    @ApiProperty({ required: false, nullable: true, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    goalId?: string | null;
}

/** `InboxItemEmail` (contract v1 requests.schema.json): only for `kind: 'email'`. */
export class IntegrationInboxEmailDto {
    @ApiProperty({ minLength: 1, maxLength: INBOX_EMAIL_FROM_MAX_CHARS })
    @IsString()
    @Length(1, INBOX_EMAIL_FROM_MAX_CHARS)
    from!: string;

    @ApiProperty({ required: false, nullable: true, maxLength: INBOX_EMAIL_TO_MAX_CHARS })
    @IsOptional()
    @IsString()
    @MaxLength(INBOX_EMAIL_TO_MAX_CHARS)
    to?: string | null;

    @ApiProperty({ minLength: 1, maxLength: INBOX_EMAIL_SUBJECT_MAX_CHARS })
    @IsString()
    @Length(1, INBOX_EMAIL_SUBJECT_MAX_CHARS)
    subject!: string;

    @ApiProperty({ format: 'date-time', maxLength: INBOX_EMAIL_RECEIVED_AT_MAX_CHARS })
    @IsString()
    @MaxLength(INBOX_EMAIL_RECEIVED_AT_MAX_CHARS)
    @IsISO8601()
    receivedAt!: string;
}

/** `InboxItemChoice` (contract v1 requests.schema.json): one answer button. */
export class IntegrationInboxChoiceDto {
    @ApiProperty({ minLength: 1, maxLength: INBOX_MAX_OPTION_ID_CHARS })
    @IsString()
    @Length(1, INBOX_MAX_OPTION_ID_CHARS)
    id!: string;

    @ApiProperty({ minLength: 1, maxLength: INBOX_MAX_OPTION_LABEL_CHARS })
    @IsString()
    @Length(1, INBOX_MAX_OPTION_LABEL_CHARS)
    label!: string;
}

/** `CreateInboxItem` (contract v1 requests.schema.json): an integration files its own item. */
export class IntegrationCreateInboxItemDto {
    @ApiProperty({
        minLength: 1,
        maxLength: INBOX_EXTERNAL_ID_MAX_CHARS,
        description:
            "The integration's own id of the item. Unique per tenant and integration key, forever: a replay answers 200 with the existing item, unchanged.",
    })
    @IsString()
    @Length(1, INBOX_EXTERNAL_ID_MAX_CHARS)
    externalId!: string;

    @ApiProperty({
        format: 'uuid',
        description: 'An active member of the pinned organization (422 domain_rule otherwise).',
    })
    @IsUUID()
    recipientUserId!: string;

    @ApiProperty({ enum: [...INBOX_EXTERNAL_ITEM_KINDS] })
    @IsIn(INBOX_EXTERNAL_ITEM_KINDS as readonly string[])
    kind!: string;

    @ApiProperty({ minLength: 1, maxLength: INBOX_MAX_TITLE_CHARS })
    @IsString()
    @Length(1, INBOX_MAX_TITLE_CHARS)
    title!: string;

    @ApiProperty({
        required: false,
        nullable: true,
        maxLength: INBOX_EXTERNAL_BODY_MAX_CHARS,
        description: 'Markdown, stored and shown as plain text (never rendered as HTML).',
    })
    @IsOptional()
    @IsString()
    @MaxLength(INBOX_EXTERNAL_BODY_MAX_CHARS)
    body?: string | null;

    @ApiProperty({
        required: false,
        nullable: true,
        format: 'uri',
        maxLength: INBOX_SOURCE_URL_MAX_CHARS,
        description: 'The item in the integration’s app: https only.',
    })
    @IsOptional()
    @IsSafeInboxSourceUrl()
    sourceUrl?: string | null;

    @ApiProperty({
        required: false,
        nullable: true,
        maxLength: INBOX_SOURCE_LABEL_MAX_CHARS,
        description: 'The badge text; defaults to the integration’s name (e.g. "Ever Gauzy").',
    })
    @IsOptional()
    @IsString()
    @Length(1, INBOX_SOURCE_LABEL_MAX_CHARS)
    sourceLabel?: string | null;

    @ApiProperty({ required: false, nullable: true, type: IntegrationInboxRelatedDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => IntegrationInboxRelatedDto)
    related?: IntegrationInboxRelatedDto | null;

    @ApiProperty({ required: false, nullable: true, type: IntegrationInboxEmailDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => IntegrationInboxEmailDto)
    email?: IntegrationInboxEmailDto | null;

    @ApiProperty({
        required: false,
        nullable: true,
        type: [IntegrationInboxChoiceDto],
        maxItems: INBOX_EXTERNAL_MAX_CHOICES,
        description: 'Only for kind question or approval.',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(INBOX_EXTERNAL_MAX_CHOICES)
    @ValidateNested({ each: true })
    @Type(() => IntegrationInboxChoiceDto)
    choices?: IntegrationInboxChoiceDto[] | null;

    @ApiProperty({ required: false, nullable: true, format: 'date-time' })
    @IsOptional()
    @IsISO8601()
    occurredAt?: string | null;
}

/** `InboxItemResolution` (contract v1 requests.schema.json): only with `state: 'resolved'`. */
export class IntegrationInboxResolutionDto {
    @ApiProperty({ required: false, nullable: true, maxLength: INBOX_MAX_OPTION_ID_CHARS })
    @IsOptional()
    @IsString()
    @Length(1, INBOX_MAX_OPTION_ID_CHARS)
    choiceId?: string | null;

    @ApiProperty({ required: false, nullable: true, maxLength: INBOX_MAX_REPLY_CHARS })
    @IsOptional()
    @IsString()
    @MaxLength(INBOX_MAX_REPLY_CHARS)
    text?: string | null;
}

/** `UpdateInboxItem` (contract v1 requests.schema.json): the integration changes its own item. */
export class IntegrationUpdateInboxItemDto {
    @ApiProperty({ required: false, minLength: 1, maxLength: INBOX_MAX_TITLE_CHARS })
    @IsOptionalNonNull()
    @IsString()
    @Length(1, INBOX_MAX_TITLE_CHARS)
    title?: string;

    @ApiProperty({ required: false, maxLength: INBOX_EXTERNAL_BODY_MAX_CHARS })
    @IsOptionalNonNull()
    @IsString()
    @MaxLength(INBOX_EXTERNAL_BODY_MAX_CHARS)
    body?: string;

    @ApiProperty({
        required: false,
        nullable: true,
        type: [IntegrationInboxChoiceDto],
        maxItems: INBOX_EXTERNAL_MAX_CHOICES,
        description: 'Replaces the choices (null clears them). Only for kind question or approval.',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(INBOX_EXTERNAL_MAX_CHOICES)
    @ValidateNested({ each: true })
    @Type(() => IntegrationInboxChoiceDto)
    choices?: IntegrationInboxChoiceDto[] | null;

    @ApiProperty({
        required: false,
        enum: ['open', 'resolved', 'archived'],
        description: '`resolved` is stored as status `answered` (with `resolution` as the answer).',
    })
    @IsOptionalNonNull()
    @IsIn(['open', 'resolved', 'archived'])
    state?: 'open' | 'resolved' | 'archived';

    @ApiProperty({ required: false, nullable: true, type: IntegrationInboxResolutionDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => IntegrationInboxResolutionDto)
    resolution?: IntegrationInboxResolutionDto | null;
}

/** `InboxReply` (contract v1 requests.schema.json): text, an option, or both. */
export class IntegrationInboxReplyDto {
    @ApiProperty({ required: false, nullable: true, maxLength: INBOX_MAX_REPLY_CHARS })
    @IsOptional()
    @IsString()
    @MaxLength(INBOX_MAX_REPLY_CHARS)
    text?: string | null;

    @ApiProperty({
        required: false,
        nullable: true,
        maxLength: INBOX_MAX_OPTION_ID_CHARS,
        description: "One of the item's `options[].id`.",
    })
    @IsOptional()
    @IsString()
    @Length(1, INBOX_MAX_OPTION_ID_CHARS)
    optionId?: string | null;
}

/** `InboxStateChange` (contract v1 requests.schema.json): at least one of the two. */
export class IntegrationInboxStateDto {
    @ApiProperty({ required: false, description: 'true = unread again, false = read.' })
    @IsOptional()
    @IsBoolean()
    unread?: boolean;

    @ApiProperty({
        required: false,
        description: 'true = archive, false = restore (answered items come back answered).',
    })
    @IsOptional()
    @IsBoolean()
    archived?: boolean;
}

interface InboxListQuery {
    readonly recipientUserId?: string;
    readonly status?: string | string[];
    readonly kind?: string | string[];
    readonly updatedSince?: string;
    readonly cursor?: string;
    readonly limit?: string;
    readonly includeArchived?: string;
}

/** `POST /inbox/items/:id/reply` answer (contract v1 `inbox-reply-result.schema.json`). */
export interface IntegrationInboxReplyResult {
    readonly item: IntegrationInboxItemDto;
    readonly routed: string;
    readonly restart: string;
    readonly runId?: string;
}

type Response = IdempotentResponse & { setHeader(name: string, value: string): unknown };

/**
 * The Inbox of `/api/integrations/v1` (EW-P3-1, contract v1 B.6 "Inbox").
 *
 * An inbox item is ONE human's message. The integration READS every
 * recipient's messages in its pinned organization, but it ANSWERS and changes
 * the state of a message only **as its recipient**: `X-Act-As-User` must name
 * `recipientUserId`, else `403 act_as_forbidden` (an integration key's own
 * identity, or another member, never answers somebody's question).
 *
 * The reply goes through the app's own `InboxService.reply`, so it does
 * exactly what the recipient answering in Ever Works does: a question steers
 * the live run or resumes the parked one, an approval decides the proposal,
 * an escalation resolves; a double answer is claimed once (`409 conflict` for
 * an item already answered, `routed: 'already-decided'` for a lost race).
 * That resumed run is the recipient's own decision on their own run, not
 * autonomous spend the integration starts (D9).
 *
 * State changes go through `InboxService.setUnread` / `setArchived` (archiving
 * an OPEN fleet question releases its parked run, as in the app).
 *
 * **Integration inbox push** (`inbox:write`): `POST /inbox/items` files the
 * integration's OWN Inbox item (Ever Gauzy pushes its notices, questions,
 * approvals, mentions, assignments and emails) for one member of the pinned
 * organization, `origin: 'integration'`; `PATCH /inbox/items/:id` changes it,
 * for the key that created it only and at the `If-Match` version only. The
 * member answers it in Ever Works like any other item; that answer routes
 * nowhere and is recorded as `inbox.item.updated` for the integration to apply.
 * Both writes are per-key rate limited like every v1 write
 * (`INTEGRATION_THROTTLE_WRITES_PER_MIN`, `UserAwareThrottlerGuard`).
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1/inbox/items')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationInboxController {
    constructor(
        private readonly inbox: IntegrationInboxService,
        private readonly items: InboxService,
        private readonly idempotency: IntegrationIdempotencyService,
        private readonly scope: ScopeContextService,
    ) {}

    @Get()
    @RequireScopes('inbox:read')
    @ApiOperation({
        summary:
            "Every recipient's inbox messages in the pinned organization (?recipientUserId=&status=&kind=&updatedSince=&cursor=&limit=&includeArchived=)",
    })
    async list(@Query() query: InboxListQuery): Promise<KeysetPage<IntegrationInboxItemDto>> {
        const recipientUserId = query.recipientUserId?.trim() || null;
        if (recipientUserId && !UUID_RE.test(recipientUserId)) {
            throw validationFailed('recipientUserId', 'must be a user id (UUID)');
        }
        return this.inbox
            .list(this.organizationId(), {
                recipientUserId,
                statuses: closedList('status', query.status, INBOX_ITEM_STATUSES),
                kinds: closedList('kind', query.kind, INBOX_ITEM_KINDS),
                includeArchived: query.includeArchived === 'true',
                updatedSince: parseUpdatedSince(query.updatedSince),
                cursor: query.cursor || null,
                limit: parseLimit(query.limit),
            })
            .catch(rethrowCursor);
    }

    @Post()
    @RequireScopes('inbox:write')
    @ApiOperation({
        summary:
            "File the integration's OWN Inbox item for a member of the pinned organization (origin integration). externalId de-duplicates forever: a replay answers 200 with the existing item, unchanged (Idempotency-Key optional)",
    })
    @ApiResponse({ status: 201, description: 'The new item (ETag = its version).' })
    @ApiResponse({ status: 200, description: 'The item this externalId already names, unchanged.' })
    @ApiResponse({
        status: 422,
        description: 'domain_rule: the recipient or a related id is not of the pinned organization',
    })
    async create(
        @CurrentUser() user: AuthenticatedUser,
        @Body() dto: IntegrationCreateInboxItemDto,
        @Req() req: IdempotentRequest,
        @Res({ passthrough: true }) res: Response,
    ): Promise<unknown> {
        const principal = principalOf(user);
        assertRelatedReadScopes(principal, dto.related);
        const writer = this.writer(principal);
        const work = async (): Promise<{ status: number; body: IntegrationInboxItemDto }> => {
            const { item, created } = await this.inbox.createExternal(writer, {
                externalId: dto.externalId,
                recipientUserId: dto.recipientUserId,
                kind: dto.kind,
                title: dto.title,
                body: dto.body ?? null,
                sourceUrl: dto.sourceUrl ?? null,
                sourceLabel: dto.sourceLabel ?? null,
                related: dto.related ?? null,
                email: dto.email ?? null,
                choices: dto.choices ?? null,
                occurredAt: dto.occurredAt ?? null,
            });
            res.setHeader('ETag', item.etag);
            return { status: created ? HttpStatus.CREATED : HttpStatus.OK, body: item.dto };
        };
        // `externalId` is the permanent de-duplication; an Idempotency-Key, when
        // sent, also replays the first response for 24 h like every v1 create.
        if (idempotencyKeyOf(req)) {
            return runIdempotent(this.idempotency, principal, req, res, work);
        }
        const { status, body } = await work();
        res.status(status);
        return body;
    }

    @Patch(':id')
    @RequireScopes('inbox:write')
    @ApiOperation({
        summary:
            "Change the integration's own item (the key that created it only; If-Match required): title, body, choices, state open / resolved / archived, resolution",
    })
    @ApiResponse({ status: 404, description: 'not_found: not an item this key created' })
    @ApiResponse({
        status: 412,
        description: 'version_mismatch: If-Match is not the current version',
    })
    async update(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationUpdateInboxItemDto,
        @Headers('if-match') ifMatch: string | undefined,
        @Res({ passthrough: true }) res: Response,
    ): Promise<IntegrationInboxItemDto> {
        const principal = principalOf(user);
        const expected = expectedVersion(ifMatch);
        if (expected === null) {
            throw validationFailed(
                'If-Match',
                'header is required: send the "<version>" ETag of the item',
            );
        }
        const item = await this.inbox.updateExternal(this.writer(principal), id, expected, {
            ...(dto.title !== undefined ? { title: dto.title } : {}),
            ...(dto.body !== undefined ? { body: dto.body } : {}),
            ...(dto.choices !== undefined ? { choices: dto.choices } : {}),
            ...(dto.state !== undefined ? { state: dto.state } : {}),
            ...(dto.resolution !== undefined ? { resolution: dto.resolution } : {}),
        });
        return this.send(res, item);
    }

    @Get(':id')
    @RequireScopes('inbox:read')
    @ApiOperation({ summary: 'One inbox message (ETag = its version)' })
    async get(
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) res: Response,
    ): Promise<IntegrationInboxItemDto> {
        return this.send(res, await this.inbox.get(this.organizationId(), id));
    }

    @Post(':id/reply')
    @HttpCode(HttpStatus.OK)
    @RequireScopes('inbox:write')
    @ApiOperation({
        summary:
            "Answer a message AS its recipient (X-Act-As-User = recipientUserId): steers / resumes the run, decides the approval or resolves the escalation, exactly like the app's Inbox reply (Idempotency-Key optional)",
    })
    async reply(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationInboxReplyDto,
        @Req() req: IdempotentRequest,
        @Res({ passthrough: true }) res: Response,
    ): Promise<unknown> {
        const principal = principalOf(user);
        const organizationId = this.organizationId();
        // Works-security lane 3a — approval and escalation replies stay open
        // here on purpose: the reply is the RECIPIENT's own decision relayed by
        // the integration (Ever Gauzy forwards what the person answered in the
        // Gauzy Inbox), and `recipientOf` refuses any other identity. The
        // decision routes that no integration relays stay session-only.
        const current = await this.inbox.get(organizationId, id);
        const recipient = recipientOf(user, current);
        // …except a MERGE decision (an agent's pull request landing on a real
        // branch, a release promotion or revert): relaying one needs the
        // separate, opt-in `merges:decide` scope. Without it the approval is
        // untouched and stays pending for a decision in Ever Works.
        const proposalId = current.dto.proposalId ?? null;
        const decisionScope = await this.inbox.decisionScopeOf(current.dto);
        if (
            decisionScope === 'merge' &&
            !principal.scopes.includes(INTEGRATION_MERGE_DECISION_SCOPE)
        ) {
            throw new IntegrationHttpException(
                403,
                'scope_missing',
                `Deciding a merge approval needs the '${INTEGRATION_MERGE_DECISION_SCOPE}' scope on the integration key. The approval stays pending: decide it in Ever Works, or ask the tenant owner to grant '${INTEGRATION_MERGE_DECISION_SCOPE}' to this key.`,
                { missing: [INTEGRATION_MERGE_DECISION_SCOPE], reason: 'merge_decision' },
            );
        }
        // Works-security lane (integration API gates, finding 6) — the other
        // approvals the platform never decides in bulk (`requiresIndividualDecision`):
        // releasing a held Agent email draft to its recipient, an agent's rewrite
        // of its own identity files (SOUL.md / AGENTS.md, trusted by every later
        // run), an agent-proposed closure of an escalation. The act-as header is
        // the key's to set, so relaying one needs the separate, opt-in
        // `decisions:individual` scope (or `merges:decide`, the wider one).
        if (
            decisionScope === 'individual' &&
            !principal.scopes.includes(INTEGRATION_INDIVIDUAL_DECISION_SCOPE) &&
            !principal.scopes.includes(INTEGRATION_MERGE_DECISION_SCOPE)
        ) {
            throw new IntegrationHttpException(
                403,
                'scope_missing',
                `Deciding this approval (an email-draft release, an agent identity-file edit or an agent-proposed escalation closure) needs the '${INTEGRATION_INDIVIDUAL_DECISION_SCOPE}' scope on the integration key. The approval stays pending: decide it in Ever Works, or ask the tenant owner to grant '${INTEGRATION_INDIVIDUAL_DECISION_SCOPE}' to this key.`,
                { missing: [INTEGRATION_INDIVIDUAL_DECISION_SCOPE], reason: 'individual_decision' },
            );
        }
        const work = async (): Promise<{ status: number; body: IntegrationInboxReplyResult }> => {
            const outcome = await this.items.reply(recipient, id, {
                text: dto.text ?? null,
                optionId: dto.optionId ?? null,
            });
            // Record on the decided proposal that an integration relayed it
            // (best-effort; never fails the reply that already landed).
            if (proposalId && (outcome.routed === 'approved' || outcome.routed === 'rejected')) {
                await this.inbox.recordRelayedDecision(proposalId, {
                    recipientUserId: recipient,
                    integrationKeyId: principal.keyId,
                    integrationKind: principal.integrationKind,
                });
            }
            const fresh = await this.inbox.get(organizationId, id);
            const body: IntegrationInboxReplyResult = {
                item: fresh.dto,
                routed: outcome.routed,
                restart: outcome.restart ?? 'none',
                ...(outcome.runId ? { runId: outcome.runId } : {}),
            };
            return { status: HttpStatus.OK, body };
        };
        // Optional here (a reply creates nothing): with a key, a retry after a
        // timeout replays the first answer instead of meeting `409 conflict`.
        if (idempotencyKeyOf(req)) {
            return runIdempotent(this.idempotency, principal, req, res, work);
        }
        return (await work()).body;
    }

    @Patch(':id/state')
    @RequireScopes('inbox:write')
    @ApiOperation({
        summary:
            'Mark read / unread and archive / restore a message AS its recipient (X-Act-As-User = recipientUserId; If-Match optional)',
    })
    async state(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationInboxStateDto,
        @Headers('if-match') ifMatch: string | undefined,
        @Res({ passthrough: true }) res: Response,
    ): Promise<IntegrationInboxItemDto> {
        if (dto.unread === undefined && dto.archived === undefined) {
            throw validationFailed('body', 'must set unread, archived or both');
        }
        const organizationId = this.organizationId();
        const item = await this.inbox.get(organizationId, id);
        const recipient = recipientOf(user, item);
        // A pre-check against the version just read: the inbox state writes
        // record after themselves (best-effort), so the precondition cannot be
        // re-checked inside their transaction the way task writes do.
        assertIfMatch(expectedVersion(ifMatch), item.dto.version);
        if (dto.archived !== undefined) await this.items.setArchived(id, recipient, dto.archived);
        if (dto.unread !== undefined) await this.items.setUnread(id, recipient, dto.unread);
        return this.send(res, await this.inbox.get(organizationId, id));
    }

    private organizationId(): string {
        return pinnedOrganizationOf(this.scope.getScope().organizationId);
    }

    /** The key, in the pinned organization of this request, as the writer of its own items. */
    private writer(principal: IntegrationPrincipal): ExternalInboxWriter {
        return {
            organizationId: this.organizationId(),
            tenantId: this.scope.getScope().tenantId ?? principal.tenantId,
            integrationKeyId: principal.keyId,
            defaultSourceLabel: defaultSourceLabelOf(principal),
        };
    }

    private send(res: Response, item: IntegrationInboxItem): IntegrationInboxItemDto {
        res.setHeader('ETag', item.etag);
        return item.dto;
    }
}

/**
 * The recipient a write acts as. The guard has already validated
 * `X-Act-As-User` (an active user of the key's tenant, on the organization's
 * roster); here it must also BE the message's recipient.
 */
function recipientOf(user: AuthenticatedUser, item: IntegrationInboxItem): string {
    const actAs = principalOf(user).actAsUserId;
    if (!actAs || actAs !== item.recipientUserId) {
        throw new IntegrationHttpException(
            403,
            'act_as_forbidden',
            "Inbox replies and state changes act as the message's recipient: send X-Act-As-User with its recipientUserId.",
            { reason: 'not_the_recipient' },
        );
    }
    return actAs;
}

/** A comma-separated / repeated filter of a closed vocabulary (`400` for anything else). */
function closedList(
    path: string,
    value: string | string[] | undefined,
    allowed: readonly string[],
): string[] {
    const values = listParam(value);
    const unknown = values.filter((entry) => !allowed.includes(entry));
    if (unknown.length > 0) {
        throw validationFailed(path, `must be one of ${allowed.join(', ')}`);
    }
    return values;
}

function expectedVersion(header: string | undefined): number | null {
    const parsed = parseIfMatch(header);
    if (parsed === undefined) {
        throw validationFailed('If-Match', 'must be the "<version>" ETag of the record');
    }
    return parsed;
}

/** The read scope that names each `related` id (linking a record needs to be allowed to read it). */
const RELATED_READ_SCOPES = [
    ['taskId', 'tasks:read'],
    ['workId', 'works:read'],
    ['goalId', 'goals:read'],
] as const;

/**
 * `related` ids are records the key must be allowed to READ: without the
 * scope, a key with `inbox:write` alone could tell an existing Task / Work /
 * Goal id from an unknown one (422 vs 201) and link to it. `403 scope_missing`
 * names what is missing.
 */
export function assertRelatedReadScopes(
    principal: IntegrationPrincipal,
    related: IntegrationInboxRelatedDto | null | undefined,
): void {
    if (!related) return;
    const missing = RELATED_READ_SCOPES.filter(
        ([field, scope]) => related[field] && !principal.scopes.includes(scope),
    ).map(([, scope]) => scope);
    if (missing.length > 0) {
        throw new IntegrationHttpException(
            403,
            'scope_missing',
            `Linking an inbox item to a record needs the scope that reads it: ${missing.join(', ')}.`,
            { missing, reason: 'related_read_scope' },
        );
    }
}

/** The badge an integration item gets when the request names none: the integration's name. */
export function defaultSourceLabelOf(principal: IntegrationPrincipal): string {
    if (principal.integrationKind === 'ever-gauzy') return 'Ever Gauzy';
    return principal.keyName?.trim() || 'Integration';
}

function idempotencyKeyOf(req: IdempotentRequest): string | undefined {
    const header = req.headers?.['idempotency-key'];
    return (Array.isArray(header) ? header[0] : header)?.trim() || undefined;
}
