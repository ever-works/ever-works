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
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { InboxService } from '@ever-works/agent/inbox';
import {
    assertIfMatch,
    IntegrationIdempotencyService,
    IntegrationInboxService,
    type IntegrationInboxItem,
    type KeysetPage,
    parseIfMatch,
} from '@ever-works/agent/integrations-api';
import {
    INBOX_ITEM_KINDS,
    INBOX_ITEM_STATUSES,
    INBOX_MAX_OPTION_ID_CHARS,
    INBOX_MAX_REPLY_CHARS,
    INTEGRATION_MERGE_DECISION_SCOPE,
    type IntegrationInboxItemDto,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
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
    listParam,
    parseLimit,
    parseUpdatedSince,
    pinnedOrganizationOf,
    principalOf,
    rethrowCursor,
    validationFailed,
} from './integration-request';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
        if (
            !principal.scopes.includes(INTEGRATION_MERGE_DECISION_SCOPE) &&
            (await this.inbox.isMergeApproval(current.dto))
        ) {
            throw new IntegrationHttpException(
                403,
                'scope_missing',
                `Deciding a merge approval needs the '${INTEGRATION_MERGE_DECISION_SCOPE}' scope on the integration key. The approval stays pending: decide it in Ever Works, or ask the tenant owner to grant '${INTEGRATION_MERGE_DECISION_SCOPE}' to this key.`,
                { missing: [INTEGRATION_MERGE_DECISION_SCOPE], reason: 'merge_decision' },
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

function idempotencyKeyOf(req: IdempotentRequest): string | undefined {
    const header = req.headers?.['idempotency-key'];
    return (Array.isArray(header) ? header[0] : header)?.trim() || undefined;
}
