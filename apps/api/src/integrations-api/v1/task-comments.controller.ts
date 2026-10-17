import {
    Body,
    Controller,
    Delete,
    ForbiddenException,
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
import { Type } from 'class-transformer';
import { IsOptional, IsString, Length, MaxLength, ValidateNested } from 'class-validator';
import { TaskChatService } from '@ever-works/agent/tasks-domain';
import {
    DuplicateExternalRefError,
    ExternalRecordLinksService,
    installationFromOrigin,
    IntegrationIdempotencyService,
    IntegrationResourcesService,
    type KeysetPage,
} from '@ever-works/agent/integrations-api';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { RequireScopes } from '../../auth/integration/integration.decorators';
import { IntegrationHttpException } from '../../auth/integration/integration-http.exception';
import { writeAttribution } from '../../auth/integration/integration-attribution';
import { ScopeContextService } from '../../scope/scope-context.service';
import { IntegrationOnlyGuard } from './integration-only.guard';
import { IntegrationExceptionFilter } from './integration-exception.filter';
import {
    runIdempotent,
    type IdempotentRequest,
    type IdempotentResponse,
} from './integration-idempotency';
import {
    assertOwnLinkSource,
    linkSourceOf,
    parseLimit,
    parseUpdatedSince,
    pinnedOrganizationOf,
    principalOf,
    rethrowCursor,
} from './integration-request';
import { IntegrationExternalRefDto } from './tasks-write.controller';

export class IntegrationExternalAuthorDto {
    @ApiProperty({ minLength: 1, maxLength: 200 })
    @IsString()
    @Length(1, 200)
    name!: string;

    @ApiProperty({ required: false, nullable: true, maxLength: 2048 })
    @IsOptional()
    @IsString()
    @MaxLength(2048)
    avatarUrl?: string | null;

    @ApiProperty({ required: false, maxLength: 100 })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    source?: string;
}

/** `CreateComment` (contract v1 requests.schema.json). */
export class IntegrationCreateCommentDto {
    @ApiProperty({ minLength: 1, maxLength: 16384 })
    @IsString()
    @Length(1, 16_384)
    body!: string;

    @ApiProperty({ required: false, type: () => IntegrationExternalAuthorDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => IntegrationExternalAuthorDto)
    externalAuthor?: IntegrationExternalAuthorDto;

    @ApiProperty({ required: false, type: () => IntegrationExternalRefDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => IntegrationExternalRefDto)
    externalRef?: IntegrationExternalRefDto;
}

/** `UpdateComment` (contract v1 requests.schema.json). */
export class IntegrationUpdateCommentDto {
    @ApiProperty({ minLength: 1, maxLength: 16384 })
    @IsString()
    @Length(1, 16_384)
    body!: string;
}

interface CommentListQuery {
    readonly updatedSince?: string;
    readonly cursor?: string;
    readonly limit?: string;
}

/**
 * Task comments of `/api/integrations/v1` (EW-P1-4, contract v1 B.6): a
 * comment is a child of the task aggregate — no version of its own, no
 * If-Match; each write records `task.comment.created|updated|deleted` with the
 * task's new version.
 *
 * Author (contract v1 §B.6): with `X-Act-As-User` the author is that user;
 * without it the author is the integration (`authorType: 'integration'`,
 * `authorId` = the key) shown with its `externalAuthor`. An integration edits
 * and deletes only what IT wrote, with no edit window; an act-as user keeps
 * the app's 5-minute edit window. A comment an integration posts never starts
 * an agent run (D9): `@agent` mentions are not resolved.
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1/tasks/:id/comments')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationTaskCommentsController {
    constructor(
        private readonly chat: TaskChatService,
        private readonly resources: IntegrationResourcesService,
        private readonly links: ExternalRecordLinksService,
        private readonly idempotency: IntegrationIdempotencyService,
        private readonly scope: ScopeContextService,
    ) {}

    @Get()
    @RequireScopes('tasks:read')
    @ApiOperation({ summary: "The task's comments" })
    async list(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: CommentListQuery,
    ): Promise<KeysetPage<Record<string, unknown>>> {
        return this.resources
            .comments(
                this.organizationId(),
                id,
                {
                    updatedSince: parseUpdatedSince(query.updatedSince),
                    cursor: query.cursor || null,
                    limit: parseLimit(query.limit),
                },
                linkSourceOf(principalOf(user)),
            )
            .catch(rethrowCursor);
    }

    @Post()
    @RequireScopes('tasks:write')
    @ApiOperation({
        summary: 'Comment on a task (Idempotency-Key required; externalRef de-duplicates)',
    })
    async create(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationCreateCommentDto,
        @Headers('x-sync-origin') syncOrigin: string | undefined,
        @Req() req: IdempotentRequest,
        @Res({ passthrough: true }) res: IdempotentResponse,
    ): Promise<unknown> {
        const principal = principalOf(user);
        const organizationId = this.organizationId();
        const source = linkSourceOf(principal);
        assertOwnLinkSource(dto.externalRef, source);
        return runIdempotent(this.idempotency, principal, req, res, async () => {
            // The task must be one the caller sees (404 otherwise).
            await this.resources.get('task', organizationId, id, source);
            const linkScope = dto.externalRef
                ? {
                      organizationId,
                      tenantId: principal.tenantId,
                      source: dto.externalRef.source,
                      installationId: installationFromOrigin(
                          dto.externalRef.installationId,
                          syncOrigin,
                          dto.externalRef.source,
                      ),
                      integrationKeyId: principal.keyId,
                  }
                : null;
            if (linkScope && dto.externalRef) {
                const existing = await this.links.findByExternal(
                    linkScope,
                    'task_comment',
                    dto.externalRef.externalId,
                );
                if (existing) {
                    return {
                        status: 200,
                        body: await this.resources.comment(
                            organizationId,
                            id,
                            existing.entityId,
                            source,
                        ),
                    };
                }
            }

            const author = writeAttribution(user);
            const message = await this.chat.post(
                user.userId,
                {
                    taskId: id,
                    authorType: author.type,
                    authorId: author.id,
                    body: dto.body,
                    externalAuthor:
                        author.type === 'integration' && dto.externalAuthor
                            ? {
                                  name: dto.externalAuthor.name,
                                  avatarUrl: dto.externalAuthor.avatarUrl ?? null,
                                  source: dto.externalAuthor.source ?? source,
                              }
                            : null,
                },
                // D9 — no agent lookups: an `@agent` token is stripped, no run starts.
                {},
                this.scope.getScope() as never,
            );

            if (linkScope && dto.externalRef) {
                try {
                    await this.links.create(linkScope, {
                        entityType: 'task_comment',
                        entityId: message.id,
                        externalId: dto.externalRef.externalId,
                        externalUrl: dto.externalRef.externalUrl ?? null,
                    });
                } catch (error) {
                    // A concurrent create with the same externalRef won: undo ours
                    // and answer theirs.
                    await this.chat.remove(
                        user.userId,
                        message.id,
                        this.scope.getScope() as never,
                        integrationAuthorOf(author),
                    );
                    if (error instanceof DuplicateExternalRefError && error.side === 'external') {
                        const winner = await this.links.findByExternal(
                            linkScope,
                            'task_comment',
                            dto.externalRef.externalId,
                        );
                        if (winner) {
                            return {
                                status: 200,
                                body: await this.resources.comment(
                                    organizationId,
                                    id,
                                    winner.entityId,
                                    source,
                                ),
                            };
                        }
                    }
                    throw error;
                }
            }
            return {
                status: 201,
                body: await this.resources.comment(organizationId, id, message.id, source),
            };
        });
    }

    @Patch(':cid')
    @RequireScopes('tasks:write')
    @ApiOperation({
        summary: 'Edit a comment (integration-authored: no edit window; act-as user: 5 minutes)',
    })
    async update(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('cid', ParseUUIDPipe) cid: string,
        @Body() dto: IntegrationUpdateCommentDto,
    ): Promise<Record<string, unknown>> {
        const organizationId = this.organizationId();
        const source = linkSourceOf(principalOf(user));
        await this.resources.comment(organizationId, id, cid, source);
        await this.asDomainRule(() =>
            this.chat.edit(
                user.userId,
                cid,
                dto.body,
                {},
                this.scope.getScope() as never,
                integrationAuthorOf(writeAttribution(user)),
            ),
        );
        return this.resources.comment(organizationId, id, cid, source);
    }

    @Delete(':cid')
    @RequireScopes('tasks:write')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Delete a comment (its author only)' })
    async remove(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('cid', ParseUUIDPipe) cid: string,
    ): Promise<void> {
        const organizationId = this.organizationId();
        await this.resources.comment(organizationId, id, cid, linkSourceOf(principalOf(user)));
        await this.asDomainRule(() =>
            this.chat.remove(
                user.userId,
                cid,
                this.scope.getScope() as never,
                integrationAuthorOf(writeAttribution(user)),
            ),
        );
        await this.links.removeAllFor(organizationId, 'task_comment', cid);
    }

    private organizationId(): string {
        return pinnedOrganizationOf(this.scope.getScope().organizationId);
    }

    /**
     * The comment is visible (checked first), so a refusal by the chat service
     * — not the author, or the edit window passed — is a domain rule (`422`),
     * not the `404` the envelope gives an ordinary `403`.
     */
    private async asDomainRule<T>(work: () => Promise<T>): Promise<T> {
        try {
            return await work();
        } catch (error) {
            if (error instanceof ForbiddenException) {
                throw new IntegrationHttpException(422, 'domain_rule', error.message);
            }
            throw error;
        }
    }
}

/** The key id when the integration itself is the author, else `undefined` (act-as user). */
function integrationAuthorOf(author: { type: string; id: string }): string | undefined {
    return author.type === 'integration' ? author.id : undefined;
}
