import {
    Body,
    Controller,
    Get,
    Inject,
    Optional,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
    Req,
    Res,
    UseFilters,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsOptional,
    IsString,
    IsUUID,
    Length,
    MaxLength,
    ValidateNested,
} from 'class-validator';
import {
    AGENT_INBOUND_EMAIL_DISPATCHER,
    type AgentInboundEmailDispatcher,
} from '@ever-works/agent/notifications';
import {
    IntegrationEmailService,
    type IntegrationEmailMessage,
    IntegrationIdempotencyService,
    IntegrationResourcesService,
    integrationProviderMessageId,
    type KeysetPage,
} from '@ever-works/agent/integrations-api';
import { EMAIL_MESSAGE_STATUSES, type IntegrationEmailMessageDto } from '@ever-works/contracts';
import { normalizeMessageId } from '@ever-works/plugin';
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
    linkSourceOf,
    listParam,
    parseLimit,
    parseUpdatedSince,
    pinnedOrganizationOf,
    principalOf,
    rethrowCursor,
    validationFailed,
} from './integration-request';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The provider path's own limits (`email_messages` columns, the 25 MB inbound body limit). */
const MAX_RECIPIENTS = 100;
const MAX_BODY_CHARS = 2_000_000;

/** One attachment the sending side holds; Ever Works records it and does not fetch it. */
export class IntegrationInboundAttachmentDto {
    @ApiProperty({ maxLength: 255 })
    @IsString()
    @Length(1, 255)
    filename!: string;

    @ApiProperty({ maxLength: 255 })
    @IsString()
    @Length(1, 255)
    contentType!: string;

    @ApiProperty({ required: false, nullable: true, maxLength: 2048 })
    @IsOptional()
    @IsString()
    @MaxLength(2048)
    url?: string | null;
}

/** `InboundEmailMessage` (contract v1 requests.schema.json). */
export class IntegrationInboundMessageDto {
    @ApiProperty({ maxLength: 254 })
    @IsString()
    @Length(3, 254)
    from!: string;

    @ApiProperty({ type: [String] })
    @IsArray()
    @ArrayMaxSize(MAX_RECIPIENTS)
    @IsString({ each: true })
    @MaxLength(254, { each: true })
    to!: string[];

    @ApiProperty({ required: false, type: [String] })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(MAX_RECIPIENTS)
    @IsString({ each: true })
    @MaxLength(254, { each: true })
    cc?: string[];

    @ApiProperty({ maxLength: 998 })
    @IsString()
    @MaxLength(998)
    subject!: string;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsString()
    @MaxLength(MAX_BODY_CHARS)
    text?: string | null;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsString()
    @MaxLength(MAX_BODY_CHARS)
    html?: string | null;

    @ApiProperty({
        required: false,
        nullable: true,
        maxLength: 255,
        description: 'RFC 5322 Message-ID.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    messageId?: string | null;

    @ApiProperty({ required: false, nullable: true, maxLength: 255 })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    inReplyTo?: string | null;

    @ApiProperty({ required: false, type: [String] })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(100)
    @IsString({ each: true })
    @MaxLength(255, { each: true })
    references?: string[];

    @ApiProperty({ required: false, type: [IntegrationInboundAttachmentDto] })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(20)
    @ValidateNested({ each: true })
    @Type(() => IntegrationInboundAttachmentDto)
    attachments?: IntegrationInboundAttachmentDto[];
}

/** `InboundEmail` (contract v1 requests.schema.json). */
export class IntegrationInboundEmailDto {
    @ApiProperty({ format: 'uuid', description: 'The agent the mail is for.' })
    @IsUUID()
    agentId!: string;

    @ApiProperty({ type: IntegrationInboundMessageDto })
    @ValidateNested()
    @Type(() => IntegrationInboundMessageDto)
    message!: IntegrationInboundMessageDto;
}

interface EmailListQuery {
    readonly agentId?: string;
    readonly direction?: string;
    readonly status?: string | string[];
    readonly updatedSince?: string;
    readonly cursor?: string;
    readonly limit?: string;
}

type Response = IdempotentResponse & { setHeader(name: string, value: string): unknown };

/** `POST /email/inbound` answer (contract v1 `email-inbound-result.schema.json`). */
export interface IntegrationInboundEmailResult {
    readonly message: IntegrationEmailMessageDto;
    readonly dispatch: {
        readonly mode: 'task-spawn' | 'conversation' | null;
        readonly taskId: string | null;
        readonly conversationId: string | null;
        readonly threaded: boolean;
    };
}

/**
 * Agent email of `/api/integrations/v1` (EW-P4-2 + EW-P4-1, contract v1 B.6
 * "Email").
 *
 * - `GET /email/messages[/:id]` (`email:read`): the pinned organization's agent
 *   mail, recipient-scoped like the Inbox (the events need `email:read` too).
 * - `POST /email/inbound` (`email:write`, an opt-in scope outside the Ever
 *   Gauzy preset): mail a Gauzy mailbox received, pushed to an Ever Works
 *   agent. It is stored as `email_messages(direction=inbound)` on the agent's
 *   own inbound address and goes through the SAME dispatcher as provider mail
 *   — the agent's inbound assignment decides task-spawn or conversation, and
 *   RFC threading joins an existing thread. An agent without an inbound
 *   assignment refuses (`422 domain_rule`): the agent's owner opted in by
 *   giving it one. Attachments are recorded with their URL and never fetched
 *   (no request to a caller-supplied URL).
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1/email')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationEmailController {
    constructor(
        private readonly email: IntegrationEmailService,
        private readonly resources: IntegrationResourcesService,
        private readonly idempotency: IntegrationIdempotencyService,
        private readonly scope: ScopeContextService,
        @Optional()
        @Inject(AGENT_INBOUND_EMAIL_DISPATCHER)
        private readonly dispatcher?: AgentInboundEmailDispatcher,
    ) {}

    @Get('messages')
    @RequireScopes('email:read')
    @ApiOperation({
        summary:
            "The organization's agent email (?agentId=&direction=inbound|outbound&status=&updatedSince=&cursor=&limit=)",
    })
    async list(@Query() query: EmailListQuery): Promise<KeysetPage<IntegrationEmailMessageDto>> {
        const agentId = query.agentId?.trim() || null;
        if (agentId && !UUID_RE.test(agentId)) {
            throw validationFailed('agentId', 'must be an agent id (UUID)');
        }
        const direction = query.direction?.trim() || null;
        if (direction && direction !== 'inbound' && direction !== 'outbound') {
            throw validationFailed('direction', 'must be inbound or outbound');
        }
        const statuses = listParam(query.status);
        if (
            statuses.some(
                (status) => !(EMAIL_MESSAGE_STATUSES as readonly string[]).includes(status),
            )
        ) {
            throw validationFailed('status', `must be one of ${EMAIL_MESSAGE_STATUSES.join(', ')}`);
        }
        return this.email
            .list(this.organizationId(), {
                agentId,
                direction: direction as 'inbound' | 'outbound' | null,
                statuses,
                updatedSince: parseUpdatedSince(query.updatedSince),
                cursor: query.cursor || null,
                limit: parseLimit(query.limit),
            })
            .catch(rethrowCursor);
    }

    @Get('messages/:id')
    @RequireScopes('email:read')
    @ApiOperation({ summary: 'One agent email (ETag = its version)' })
    async get(
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) res: Response,
    ): Promise<IntegrationEmailMessageDto> {
        return this.send(res, await this.email.get(this.organizationId(), id));
    }

    @Post('inbound')
    @RequireScopes('email:write')
    @ApiOperation({
        summary:
            "Push an email a Gauzy mailbox received to an Ever Works agent: stored on the agent's inbound address and dispatched like provider mail (Idempotency-Key required)",
    })
    async inbound(
        @CurrentUser() user: AuthenticatedUser,
        @Body() dto: IntegrationInboundEmailDto,
        @Req() req: IdempotentRequest,
        @Res({ passthrough: true }) res: Response,
    ): Promise<unknown> {
        const principal = principalOf(user);
        const organizationId = this.organizationId();
        if (!dto.message.text && !dto.message.html) {
            throw validationFailed('message.text', 'a message needs text, html or both');
        }
        // The agent must be one the key sees in the pinned organization.
        await this.resources.get('agent', organizationId, dto.agentId, linkSourceOf(principal));
        const inbox = await this.email.inboundAddressOf(dto.agentId);
        // `in`, not `!inbox.ok`: apps/api builds without strictNullChecks, where a
        // boolean discriminant does not narrow the union.
        if ('reason' in inbox) throw new IntegrationHttpException(422, 'domain_rule', inbox.reason);
        const address = inbox.address;
        // The stored message takes the address's organization: an address of
        // another organization (or of none) would deliver mail this key can
        // never read back.
        if (address.organizationId !== organizationId) {
            throw new IntegrationHttpException(
                422,
                'domain_rule',
                "The agent's inbound address is not an address of this organization.",
            );
        }
        if (!this.dispatcher) {
            throw new IntegrationHttpException(
                503,
                'internal_error',
                'Inbound email dispatch is not available on this server.',
            );
        }
        const dispatcher = this.dispatcher;
        return runIdempotent(this.idempotency, principal, req, res, async () => {
            const header = req.headers?.['idempotency-key'];
            const idempotencyKey = (Array.isArray(header) ? header[0] : header)?.trim() ?? '';
            const providerMessageId = integrationProviderMessageId(
                principal.keyId,
                organizationId,
                dto.message.messageId
                    ? `message-id:${dto.message.messageId}`
                    : `key:${idempotencyKey}`,
            );
            // A push replayed without its Idempotency-Key (same Message-ID): the
            // message it already delivered, never a second Task.
            const pushed = await this.email.findPushed(
                organizationId,
                address.pluginId,
                providerMessageId,
            );
            if (pushed) {
                const existing = await this.email.get(organizationId, pushed.id);
                return {
                    status: 200,
                    body: {
                        message: existing.dto,
                        dispatch: {
                            mode: null,
                            taskId: existing.dto.taskId,
                            conversationId: existing.dto.conversationId,
                            threaded: false,
                        },
                    } satisfies IntegrationInboundEmailResult,
                };
            }
            const message = dto.message;
            const outcome = await dispatcher.dispatch({
                pluginId: address.pluginId,
                recipient: { emailAddressId: address.id, userId: address.userId },
                providerMessageId,
                from: message.from,
                to: [...message.to],
                cc: message.cc?.length ? [...message.cc] : undefined,
                subject: message.subject,
                bodyText: message.text ?? '',
                bodyHtml: message.html ?? undefined,
                receivedAt: new Date(),
                // Bare ids, as the provider path stores them (RFC threading).
                messageIdHeader: normalizeMessageId(message.messageId),
                inReplyTo: normalizeMessageId(message.inReplyTo),
                references: message.references
                    ?.map((id) => normalizeMessageId(id))
                    .filter((id): id is string => !!id),
                // Recorded, never fetched: Ever Works makes no request to a
                // caller-supplied URL.
                metadata: {
                    source: 'integration',
                    integrationKeyId: principal.keyId,
                    ...(message.attachments?.length
                        ? {
                              externalAttachments: message.attachments.map((attachment) => ({
                                  filename: attachment.filename,
                                  contentType: attachment.contentType,
                                  url: attachment.url ?? null,
                              })),
                          }
                        : {}),
                },
            });
            if (!outcome.handled || !outcome.emailMessageId) {
                throw new IntegrationHttpException(
                    422,
                    'domain_rule',
                    `The agent could not take the email: ${outcome.reason ?? 'not dispatched'}.`,
                );
            }
            const stored = await this.email.get(organizationId, outcome.emailMessageId);
            res.setHeader('ETag', stored.etag);
            const body: IntegrationInboundEmailResult = {
                message: stored.dto,
                dispatch: {
                    mode: outcome.mode ?? null,
                    taskId: outcome.taskId ?? null,
                    conversationId: outcome.conversationId ?? null,
                    threaded: outcome.threaded === true,
                },
            };
            return { status: 201, body };
        });
    }

    private organizationId(): string {
        return pinnedOrganizationOf(this.scope.getScope().organizationId);
    }

    private send(res: Response, message: IntegrationEmailMessage): IntegrationEmailMessageDto {
        res.setHeader('ETag', message.etag);
        return message.dto;
    }
}
