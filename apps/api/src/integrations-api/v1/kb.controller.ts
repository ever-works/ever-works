import { posix } from 'node:path';
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
import {
    ArrayMaxSize,
    IsArray,
    IsIn,
    IsOptional,
    IsString,
    IsUUID,
    Length,
    MaxLength,
    ValidateIf,
    ValidateNested,
} from 'class-validator';
import {
    claimedAggregateVersionTaken,
    runWithClaimedAggregateVersion,
} from '@ever-works/agent/domain-events';
import {
    KnowledgeBaseService,
    KnowledgeLibraryService,
    type KbDocumentWithinCreate,
    type KnowledgeLibraryActor,
} from '@ever-works/agent/services';
import {
    assertIfMatch,
    DuplicateExternalRefError,
    ExternalRecordLinksService,
    installationFromOrigin,
    IntegrationIdempotencyService,
    type IntegrationKbDocument,
    type IntegrationKbFolder,
    IntegrationKbService,
    type KeysetPage,
    parseIfMatch,
    VersionMismatchError,
} from '@ever-works/agent/integrations-api';
import {
    KB_DOCUMENT_CLASSES,
    type IntegrationKbDocumentDto,
    type IntegrationKbFolderDto,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { RequireScopes } from '../../auth/integration/integration.decorators';
import { IntegrationHttpException } from '../../auth/integration/integration-http.exception';
import { OrganizationMembershipService } from '../../organizations/organization-membership.service';
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
    listParam,
    parseLimit,
    parseUpdatedSince,
    pinnedOrganizationOf,
    principalOf,
    rethrowCursor,
    validationFailed,
    IsOptionalNonNull,
} from './integration-request';
import { IntegrationExternalRefDto } from './tasks-write.controller';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Statuses a KB document may be written with (archive has its own route). */
const WRITABLE_STATUSES = ['draft', 'active'] as const;
const DOCUMENT_STATUSES = ['draft', 'active', 'archived'] as const;
/** The Markdown body limit of an integration write (the app stores bodies in `metadata.body`). */
const KB_BODY_MAX_CHARS = 1_000_000;

/**
 * An organization document's `path`: relative, no `..` segment, no `\\`, NUL
 * or drive letter — the Work path rule (`validateRelativeKbPath`) without its
 * class-folder prefix, which organization documents (`memory/…`) do not use.
 */
function assertRelativeKbPath(path: string): void {
    const segments = posix.normalize(path).split('/');
    if (
        path.includes('\\') ||
        path.includes('\0') ||
        path.startsWith('/') ||
        /^[A-Za-z]:/.test(path) ||
        segments.some((segment) => segment === '..')
    ) {
        throw validationFailed(
            'path',
            'must be a relative path without `..`, `\\` or a drive letter',
        );
    }
}

/** `KbScope` (contract v1 requests.schema.json). */
export class IntegrationKbScopeDto {
    @ApiProperty({ enum: ['organization', 'work'] })
    @IsIn(['organization', 'work'])
    type!: 'organization' | 'work';

    @ApiProperty({ format: 'uuid', description: 'The organization id, or the Work id.' })
    @IsUUID()
    id!: string;
}

/** `CreateKbDocument` (contract v1 requests.schema.json). */
export class IntegrationCreateKbDocumentDto {
    @ApiProperty({ type: IntegrationKbScopeDto })
    @ValidateNested()
    @Type(() => IntegrationKbScopeDto)
    scope!: IntegrationKbScopeDto;

    @ApiProperty({ required: false, nullable: true, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    folderId?: string | null;

    @ApiProperty({ maxLength: 512, description: 'Relative path, e.g. `brand/voice.md`.' })
    @IsString()
    @Length(1, 512)
    path!: string;

    @ApiProperty({ maxLength: 255 })
    @IsString()
    @Length(1, 255)
    title!: string;

    @ApiProperty({ enum: [...KB_DOCUMENT_CLASSES] })
    @IsIn(KB_DOCUMENT_CLASSES as unknown as string[])
    class!: string;

    @ApiProperty({ maxLength: KB_BODY_MAX_CHARS, description: 'Markdown.' })
    @IsString()
    @MaxLength(KB_BODY_MAX_CHARS)
    body!: string;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsString()
    @MaxLength(4000)
    description?: string | null;

    @ApiProperty({ required: false, type: [String] })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    @IsString({ each: true })
    @MaxLength(100, { each: true })
    tags?: string[];

    @ApiProperty({ required: false, type: [String] })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    @IsString({ each: true })
    @MaxLength(100, { each: true })
    categories?: string[];

    @ApiProperty({ required: false, maxLength: 8 })
    @IsOptional()
    @IsString()
    @Length(2, 8)
    language?: string;

    @ApiProperty({ required: false, enum: WRITABLE_STATUSES })
    @IsOptional()
    @IsIn(WRITABLE_STATUSES as unknown as string[])
    status?: 'draft' | 'active';

    @ApiProperty({ required: false, type: IntegrationExternalRefDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => IntegrationExternalRefDto)
    externalRef?: IntegrationExternalRefDto;
}

/** `UpdateKbDocument` (contract v1 requests.schema.json): at least one field. */
export class IntegrationUpdateKbDocumentDto {
    @ApiProperty({ required: false, maxLength: 255 })
    @IsOptionalNonNull()
    @IsString()
    @Length(1, 255)
    title?: string;

    @ApiProperty({ required: false, maxLength: KB_BODY_MAX_CHARS })
    @IsOptionalNonNull()
    @IsString()
    @MaxLength(KB_BODY_MAX_CHARS)
    body?: string;

    @ApiProperty({ required: false, nullable: true })
    @IsOptional()
    @IsString()
    @MaxLength(4000)
    description?: string | null;

    @ApiProperty({ required: false, enum: [...KB_DOCUMENT_CLASSES] })
    @IsOptionalNonNull()
    @IsIn(KB_DOCUMENT_CLASSES as unknown as string[])
    class?: string;

    @ApiProperty({ required: false, type: [String] })
    @IsOptionalNonNull()
    @IsArray()
    @ArrayMaxSize(50)
    @IsString({ each: true })
    @MaxLength(100, { each: true })
    tags?: string[];

    @ApiProperty({ required: false, type: [String] })
    @IsOptionalNonNull()
    @IsArray()
    @ArrayMaxSize(50)
    @IsString({ each: true })
    @MaxLength(100, { each: true })
    categories?: string[];

    @ApiProperty({ required: false, maxLength: 8 })
    @IsOptionalNonNull()
    @IsString()
    @Length(2, 8)
    language?: string;

    @ApiProperty({ required: false, enum: WRITABLE_STATUSES })
    @IsOptionalNonNull()
    @IsIn(WRITABLE_STATUSES as unknown as string[])
    status?: 'draft' | 'active';
}

/** `MoveKbDocument`: file into a library folder, or `null` = Unfiled. */
export class IntegrationMoveKbDocumentDto {
    @ApiProperty({ nullable: true, format: 'uuid' })
    @ValidateIf((_dto, value) => value !== null)
    @IsUUID()
    folderId!: string | null;
}

/** `CreateKbFolder`. */
export class IntegrationCreateKbFolderDto {
    @ApiProperty({ maxLength: 120 })
    @IsString()
    @Length(1, 120)
    name!: string;

    @ApiProperty({ required: false, nullable: true, format: 'uuid' })
    @IsOptional()
    @IsUUID()
    parentId?: string | null;

    @ApiProperty({ required: false, type: IntegrationExternalRefDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => IntegrationExternalRefDto)
    externalRef?: IntegrationExternalRefDto;
}

/** `UpdateKbFolder`: rename and / or move (`parentId: null` = top level). */
export class IntegrationUpdateKbFolderDto {
    @ApiProperty({ required: false, maxLength: 120 })
    @IsOptionalNonNull()
    @IsString()
    @Length(1, 120)
    name?: string;

    @ApiProperty({ required: false, nullable: true, format: 'uuid' })
    @IsOptional()
    @ValidateIf((_dto, value) => value !== null)
    @IsUUID()
    parentId?: string | null;
}

interface DocumentListQuery {
    readonly scope?: string;
    readonly workId?: string;
    readonly folderId?: string;
    readonly class?: string | string[];
    readonly status?: string | string[];
    readonly includeArchived?: string;
    readonly updatedSince?: string;
    readonly cursor?: string;
    readonly limit?: string;
}

interface FolderListQuery {
    readonly updatedSince?: string;
    readonly cursor?: string;
    readonly limit?: string;
}

type Response = IdempotentResponse & { setHeader(name: string, value: string): unknown };

/** The edit the Knowledge Base applies (`KnowledgeBaseService.updateDocument`'s input). */
type KbDocumentPatch = NonNullable<Parameters<KnowledgeBaseService['updateDocument']>[3]>;

/**
 * The Knowledge Base of `/api/integrations/v1` (EW-P3-2, contract v1 B.6 "KB"):
 * documents (organization- or Work-scoped Markdown) and the organization
 * library folders.
 *
 * Every write delegates to the app's own services, so the Git mirror, the
 * embeddings, the organization overlay into Works, locks, revisions, the
 * activity trail and the `kb.document.*` / `kb.folder.*` events behave exactly
 * as from the Knowledge Base and the Knowledge library. The writer is the
 * `X-Act-As-User` person, else the key's owner; the app's rules decide what
 * they may change (editing a Work's documents needs edit access to the Work;
 * organization documents and library folders need organization admin), and a
 * refusal answers `422 domain_rule`.
 *
 * Organization documents are archived, never deleted (`DELETE` answers
 * `422 domain_rule`, D8); a Work document's `DELETE` is the app's own delete.
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1/kb')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationKbController {
    constructor(
        private readonly kb: IntegrationKbService,
        private readonly knowledgeBase: KnowledgeBaseService,
        private readonly library: KnowledgeLibraryService,
        private readonly membership: OrganizationMembershipService,
        private readonly links: ExternalRecordLinksService,
        private readonly idempotency: IntegrationIdempotencyService,
        private readonly scope: ScopeContextService,
    ) {}

    // ── Documents ────────────────────────────────────────────────────────

    @Get('documents')
    @RequireScopes('kb:read')
    @ApiOperation({
        summary:
            "The organization's documents and its Works' (?scope=organization|work&workId=&folderId=<id>|unfiled&class=&status=&includeArchived=&updatedSince=&cursor=&limit=)",
    })
    async listDocuments(
        @Query() query: DocumentListQuery,
    ): Promise<KeysetPage<IntegrationKbDocumentDto>> {
        const scope = query.scope?.trim() || null;
        if (scope !== null && scope !== 'organization' && scope !== 'work') {
            throw validationFailed('scope', 'must be organization or work');
        }
        const workId = query.workId?.trim() || null;
        if (workId && !UUID_RE.test(workId)) {
            throw validationFailed('workId', 'must be a Work id (UUID)');
        }
        const folderId = query.folderId?.trim() || null;
        if (folderId && folderId !== 'unfiled' && !UUID_RE.test(folderId)) {
            throw validationFailed('folderId', 'must be a folder id (UUID) or unfiled');
        }
        return this.kb
            .listDocuments(this.organizationId(), {
                scopeType: scope as 'organization' | 'work' | null,
                workId,
                folderId,
                classes: closedList('class', query.class, KB_DOCUMENT_CLASSES),
                statuses: closedList('status', query.status, DOCUMENT_STATUSES),
                includeArchived: query.includeArchived === 'true',
                updatedSince: parseUpdatedSince(query.updatedSince),
                cursor: query.cursor || null,
                limit: parseLimit(query.limit),
            })
            .catch(rethrowCursor);
    }

    @Get('documents/:id')
    @RequireScopes('kb:read')
    @ApiOperation({ summary: 'One document with its Markdown body (ETag = its version)' })
    async getDocument(
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) res: Response,
    ): Promise<IntegrationKbDocumentDto> {
        return this.sendDocument(res, await this.kb.getDocument(this.organizationId(), id));
    }

    @Post('documents')
    @RequireScopes('kb:write')
    @ApiOperation({
        summary:
            'Create a document in the organization library or in one of its Works (Idempotency-Key required; externalRef de-duplicates)',
    })
    async createDocument(
        @CurrentUser() user: AuthenticatedUser,
        @Body() dto: IntegrationCreateKbDocumentDto,
        @Headers('x-sync-origin') syncOrigin: string | undefined,
        @Req() req: IdempotentRequest,
        @Res({ passthrough: true }) res: Response,
    ): Promise<unknown> {
        const principal = principalOf(user);
        const organizationId = this.organizationId();
        const source = linkSourceOf(principal);
        assertOwnLinkSource(dto.externalRef, source);
        if (dto.scope.type === 'organization' && dto.scope.id !== organizationId) {
            throw validationFailed('scope.id', 'must be the pinned organization (X-Scope-Slug)');
        }
        if (dto.scope.type === 'work') {
            await this.kb.assertWorkOfOrganization(organizationId, dto.scope.id);
        }
        return runIdempotent(this.idempotency, principal, req, res, async () => {
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
                    'kb_document',
                    dto.externalRef.externalId,
                );
                if (existing) {
                    const found = await this.kb.getDocument(organizationId, existing.entityId);
                    res.setHeader('ETag', found.etag);
                    return { status: 200, body: found.dto };
                }
            }
            const input = {
                path: dto.path,
                title: dto.title,
                class: dto.class as never,
                body: dto.body,
                description: dto.description ?? null,
                tags: dto.tags,
                categories: dto.categories,
                language: dto.language,
                status: dto.status as never,
                // A person writing through the integration authors it; the key
                // itself imports it.
                source: (principal.actAsUserId ? 'user' : 'imported') as never,
                // Works-security lane 3a — a document with NO person behind it
                // (the key writing as itself) lands `proposed`: an `accepted`
                // document feeds every later agent prompt, so the M7 review
                // gate applies until a person accepts it (in Ever Works, or in
                // the integration's own review queue, relayed through
                // `POST /kb/documents/:id/accept`). A person's write relayed
                // with X-Act-As-User stays `accepted`, as their own edit in Ever
                // Works would be.
                ...(principal.actAsUserId ? {} : { reviewState: 'proposed' as never }),
            };
            // Before the create: filing afterwards would leave the document
            // behind (one more per retry) when the folder is not one of this
            // organization's library folders (404).
            if (dto.folderId) await this.kb.getFolder(organizationId, dto.folderId);
            // A Work path is checked by the Knowledge Base; an organization
            // path (no class-folder prefix) at least stays relative.
            if (dto.scope.type === 'organization') assertRelativeKbPath(dto.path);
            // The document and its externalRef link commit in ONE transaction
            // (the T17a pattern): a lost race rolls the create back instead of
            // leaving a duplicate to archive, and a crash cannot leave an
            // unlinked document behind.
            const externalRef = dto.externalRef;
            const withinCreate: KbDocumentWithinCreate | undefined =
                linkScope && externalRef
                    ? async (document, manager) => {
                          await this.links.create(
                              linkScope,
                              {
                                  entityType: 'kb_document',
                                  entityId: document.id,
                                  externalId: externalRef.externalId,
                                  externalUrl: externalRef.externalUrl ?? null,
                              },
                              manager,
                          );
                      }
                    : undefined;
            let created: { id: string };
            try {
                created = await asDomainRule(async () => {
                    if (dto.scope.type === 'organization') {
                        await this.assertOrganizationAdmin(organizationId, user.userId);
                        return this.knowledgeBase.createOrgDocument(
                            organizationId,
                            user.userId,
                            input,
                            { withinCreate },
                        );
                    }
                    return this.knowledgeBase.createDocument(
                        { ...input, workId: dto.scope.id, userId: user.userId },
                        { withinCreate },
                    );
                });
            } catch (error) {
                // A concurrent create with the same externalRef won (ours rolled
                // back with its link): answer theirs.
                if (
                    linkScope &&
                    externalRef &&
                    error instanceof DuplicateExternalRefError &&
                    error.side === 'external'
                ) {
                    const winner = await this.links.findByExternal(
                        linkScope,
                        'kb_document',
                        externalRef.externalId,
                    );
                    if (winner) {
                        const found = await this.kb.getDocument(organizationId, winner.entityId);
                        res.setHeader('ETag', found.etag);
                        return { status: 200, body: found.dto };
                    }
                }
                throw error;
            }
            if (dto.folderId) {
                await asDomainRule(async () =>
                    this.library.fileDocuments(await this.actor(user, organizationId), {
                        documentIds: [created.id],
                        folderId: dto.folderId ?? null,
                    }),
                );
            }
            const fresh = await this.kb.getDocument(organizationId, created.id);
            res.setHeader('ETag', fresh.etag);
            return { status: 201, body: fresh.dto };
        });
    }

    @Patch('documents/:id')
    @RequireScopes('kb:write')
    @ApiOperation({ summary: 'Edit a document (If-Match optional)' })
    async updateDocument(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationUpdateKbDocumentDto,
        @Headers('if-match') ifMatch: string | undefined,
        @Res({ passthrough: true }) res: Response,
    ): Promise<IntegrationKbDocumentDto> {
        const patch: KbDocumentPatch = {};
        if (dto.title !== undefined) patch.title = dto.title;
        if (dto.body !== undefined) patch.body = dto.body;
        if (dto.description !== undefined) patch.description = dto.description;
        if (dto.class !== undefined) patch.class = dto.class as KbDocumentPatch['class'];
        if (dto.tags !== undefined) patch.tags = dto.tags;
        if (dto.categories !== undefined) patch.categories = dto.categories;
        if (dto.language !== undefined) patch.language = dto.language;
        if (dto.status !== undefined) patch.status = dto.status as KbDocumentPatch['status'];
        if (Object.keys(patch).length === 0) {
            throw validationFailed('body', 'must change at least one field');
        }
        // Works-security lane 3a — a content edit with NO person behind it (the
        // key writing as itself) puts the document back to `proposed`, exactly
        // like a key-only create: otherwise a key could rewrite an accepted
        // document straight into every later prompt. A person's edit relayed
        // with X-Act-As-User leaves the review state alone.
        if (
            !principalOf(user).actAsUserId &&
            (patch.title !== undefined ||
                patch.body !== undefined ||
                patch.description !== undefined ||
                patch.class !== undefined)
        ) {
            patch.reviewState = 'proposed' as KbDocumentPatch['reviewState'];
        }
        const organizationId = this.organizationId();
        const current = await this.kb.getDocument(organizationId, id);
        // Malformed or stale If-Match first (400 / 412), before any other rule.
        assertIfMatch(expectedVersion(ifMatch), current.dto.version);
        if (patch.status !== undefined && current.dto.status === 'archived') {
            // A status write would un-archive it half-way (archive markers and
            // the decision left behind, `updated` instead of `unarchived`).
            throw new IntegrationHttpException(
                422,
                'domain_rule',
                'An archived document is restored with POST /kb/documents/:id/unarchive, not by setting its status.',
            );
        }
        // Checked before the If-Match claim, so a refusal does not move the version.
        if (!current.workId) {
            await asDomainRule(() => this.assertOrganizationAdmin(organizationId, user.userId));
        }
        await this.ifMatchWrite('kb_document', id, ifMatch, current.dto.version, () =>
            asDomainRule(async () => {
                if (current.workId) {
                    await this.knowledgeBase.updateDocument(current.workId, id, user.userId, patch);
                    return;
                }
                await this.knowledgeBase.updateOrgDocument(organizationId, id, user.userId, patch);
            }),
        );
        return this.sendDocument(res, await this.kb.getDocument(organizationId, id));
    }

    @Delete('documents/:id')
    @RequireScopes('kb:write')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary:
            'Delete a Work document (If-Match optional); organization documents are archived, not deleted (422)',
    })
    async deleteDocument(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Headers('if-match') ifMatch: string | undefined,
    ): Promise<void> {
        const organizationId = this.organizationId();
        const current = await this.kb.getDocument(organizationId, id);
        assertIfMatch(expectedVersion(ifMatch), current.dto.version);
        if (!current.workId) {
            throw new IntegrationHttpException(
                422,
                'domain_rule',
                'Organization documents are archived, never deleted: POST /kb/documents/:id/archive.',
            );
        }
        const workId = current.workId;
        await this.ifMatchWrite('kb_document', id, ifMatch, current.dto.version, () =>
            asDomainRule(() => this.knowledgeBase.deleteDocument(workId, id, user.userId)),
        );
        await this.links.removeAllFor(organizationId, 'kb_document', id);
    }

    @Post('documents/:id/accept')
    @HttpCode(HttpStatus.OK)
    @RequireScopes('kb:write')
    @ApiOperation({ summary: 'Accept a proposed (agent-written) document' })
    async acceptDocument(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) res: Response,
    ): Promise<IntegrationKbDocumentDto> {
        // Works-security lane 3a — kept open to integration keys on purpose:
        // this is how an integration RELAYS a person's review decision (Ever
        // Gauzy calls it when a reviewer approves the page in Gauzy's own
        // review queue). A document an integration creates lands `proposed`,
        // so the review happens there and this route records its outcome.
        const organizationId = this.organizationId();
        const current = await this.kb.getDocument(organizationId, id);
        await asDomainRule(async () => {
            if (current.workId) {
                await this.knowledgeBase.acceptDocument(current.workId, id, user.userId);
                return;
            }
            await this.assertOrganizationAdmin(organizationId, user.userId);
            await this.knowledgeBase.acceptOrgDocument(organizationId, id, user.userId);
        });
        return this.sendDocument(res, await this.kb.getDocument(organizationId, id));
    }

    @Post('documents/:id/archive')
    @HttpCode(HttpStatus.OK)
    @RequireScopes('kb:write')
    @ApiOperation({ summary: 'Archive a document (idempotent)' })
    async archiveDocument(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) res: Response,
    ): Promise<IntegrationKbDocumentDto> {
        const organizationId = this.organizationId();
        await this.kb.getDocument(organizationId, id);
        const actor = await this.actor(user, organizationId);
        await asDomainRule(() => this.library.archive(actor, id));
        return this.sendDocument(res, await this.kb.getDocument(organizationId, id));
    }

    @Post('documents/:id/unarchive')
    @HttpCode(HttpStatus.OK)
    @RequireScopes('kb:write')
    @ApiOperation({ summary: 'Restore an archived document (idempotent)' })
    async unarchiveDocument(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) res: Response,
    ): Promise<IntegrationKbDocumentDto> {
        const organizationId = this.organizationId();
        await this.kb.getDocument(organizationId, id);
        const actor = await this.actor(user, organizationId);
        await asDomainRule(() => this.library.unarchive(actor, id));
        return this.sendDocument(res, await this.kb.getDocument(organizationId, id));
    }

    @Post('documents/:id/move')
    @HttpCode(HttpStatus.OK)
    @RequireScopes('kb:write')
    @ApiOperation({ summary: 'File a document into a library folder, or folderId: null = Unfiled' })
    async moveDocument(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationMoveKbDocumentDto,
        @Res({ passthrough: true }) res: Response,
    ): Promise<IntegrationKbDocumentDto> {
        const organizationId = this.organizationId();
        await this.kb.getDocument(organizationId, id);
        const actor = await this.actor(user, organizationId);
        await asDomainRule(() =>
            this.library.fileDocuments(actor, {
                documentIds: [id],
                folderId: dto.folderId ?? null,
            }),
        );
        return this.sendDocument(res, await this.kb.getDocument(organizationId, id));
    }

    // ── Library folders ──────────────────────────────────────────────────

    @Get('folders')
    @RequireScopes('kb:read')
    @ApiOperation({ summary: "The organization's library folders (?updatedSince=&cursor=&limit=)" })
    async listFolders(
        @Query() query: FolderListQuery,
    ): Promise<KeysetPage<IntegrationKbFolderDto>> {
        return this.kb
            .listFolders(this.organizationId(), {
                updatedSince: parseUpdatedSince(query.updatedSince),
                cursor: query.cursor || null,
                limit: parseLimit(query.limit),
            })
            .catch(rethrowCursor);
    }

    @Get('folders/:id')
    @RequireScopes('kb:read')
    @ApiOperation({ summary: 'One library folder (ETag = its version)' })
    async getFolder(
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) res: Response,
    ): Promise<IntegrationKbFolderDto> {
        return this.sendFolder(res, await this.kb.getFolder(this.organizationId(), id));
    }

    @Post('folders')
    @RequireScopes('kb:write')
    @ApiOperation({
        summary: 'Create a library folder (Idempotency-Key required; externalRef de-duplicates)',
    })
    async createFolder(
        @CurrentUser() user: AuthenticatedUser,
        @Body() dto: IntegrationCreateKbFolderDto,
        @Headers('x-sync-origin') syncOrigin: string | undefined,
        @Req() req: IdempotentRequest,
        @Res({ passthrough: true }) res: Response,
    ): Promise<unknown> {
        const principal = principalOf(user);
        const organizationId = this.organizationId();
        const source = linkSourceOf(principal);
        assertOwnLinkSource(dto.externalRef, source);
        return runIdempotent(this.idempotency, principal, req, res, async () => {
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
                    'kb_folder',
                    dto.externalRef.externalId,
                );
                if (existing) {
                    const found = await this.kb.getFolder(organizationId, existing.entityId);
                    res.setHeader('ETag', found.etag);
                    return { status: 200, body: found.dto };
                }
            }
            const actor = await this.actor(user, organizationId);
            // The folder and its externalRef link commit in ONE transaction (the
            // folder tree's): a lost race rolls the folder back.
            const externalRef = dto.externalRef;
            let folder: { id: string };
            try {
                folder = await asDomainRule(() =>
                    this.library.createFolder(
                        actor,
                        { name: dto.name, parentId: dto.parentId ?? null },
                        linkScope && externalRef
                            ? {
                                  withinCreate: async (row, manager) => {
                                      await this.links.create(
                                          linkScope,
                                          {
                                              entityType: 'kb_folder',
                                              entityId: row.id,
                                              externalId: externalRef.externalId,
                                              externalUrl: externalRef.externalUrl ?? null,
                                          },
                                          manager,
                                      );
                                  },
                              }
                            : {},
                    ),
                );
            } catch (error) {
                if (
                    linkScope &&
                    externalRef &&
                    error instanceof DuplicateExternalRefError &&
                    error.side === 'external'
                ) {
                    const winner = await this.links.findByExternal(
                        linkScope,
                        'kb_folder',
                        externalRef.externalId,
                    );
                    if (winner) {
                        const found = await this.kb.getFolder(organizationId, winner.entityId);
                        res.setHeader('ETag', found.etag);
                        return { status: 200, body: found.dto };
                    }
                }
                throw error;
            }
            const fresh = await this.kb.getFolder(organizationId, folder.id);
            res.setHeader('ETag', fresh.etag);
            return { status: 201, body: fresh.dto };
        });
    }

    @Patch('folders/:id')
    @RequireScopes('kb:write')
    @ApiOperation({ summary: 'Rename and / or move a library folder (If-Match optional)' })
    async updateFolder(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: IntegrationUpdateKbFolderDto,
        @Headers('if-match') ifMatch: string | undefined,
        @Res({ passthrough: true }) res: Response,
    ): Promise<IntegrationKbFolderDto> {
        if (dto.name === undefined && dto.parentId === undefined) {
            throw validationFailed('body', 'must set name, parentId or both');
        }
        const organizationId = this.organizationId();
        const current = await this.kb.getFolder(organizationId, id);
        assertIfMatch(expectedVersion(ifMatch), current.dto.version);
        const actor = await this.actor(user, organizationId);
        assertCanManageLibrary(actor);
        await this.ifMatchWrite('kb_folder', id, ifMatch, current.dto.version, () =>
            asDomainRule(async () => {
                if (dto.name !== undefined) await this.library.renameFolder(actor, id, dto.name);
                if (dto.parentId !== undefined) {
                    await this.library.moveFolder(actor, id, dto.parentId ?? null);
                }
            }),
        );
        return this.sendFolder(res, await this.kb.getFolder(organizationId, id));
    }

    @Delete('folders/:id')
    @RequireScopes('kb:write')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:
            'Delete a library folder and its subfolders; their documents move to Unfiled, none is deleted (If-Match optional)',
    })
    async deleteFolder(
        @CurrentUser() user: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Headers('if-match') ifMatch: string | undefined,
    ): Promise<{ deletedFolders: number; unfiledDocuments: number }> {
        const organizationId = this.organizationId();
        const current = await this.kb.getFolder(organizationId, id);
        assertIfMatch(expectedVersion(ifMatch), current.dto.version);
        const actor = await this.actor(user, organizationId);
        assertCanManageLibrary(actor);
        const result = await this.ifMatchWrite('kb_folder', id, ifMatch, current.dto.version, () =>
            asDomainRule(() => this.library.deleteFolder(actor, id)),
        );
        await this.links.removeAllFor(organizationId, 'kb_folder', id);
        return result;
    }

    // ── internals ────────────────────────────────────────────────────────

    private organizationId(): string {
        return pinnedOrganizationOf(this.scope.getScope().organizationId);
    }

    /** The Knowledge library actor: the writing person, and whether they may curate organization content. */
    private async actor(
        user: AuthenticatedUser,
        organizationId: string,
    ): Promise<KnowledgeLibraryActor> {
        let canManageOrganization = false;
        try {
            await this.membership.ensureAdmin(organizationId, user.userId);
            canManageOrganization = true;
        } catch {
            canManageOrganization = false;
        }
        return { userId: user.userId, organizationId, canManageOrganization };
    }

    private async assertOrganizationAdmin(organizationId: string, userId: string): Promise<void> {
        try {
            await this.membership.ensureAdmin(organizationId, userId);
        } catch {
            throw new ForbiddenException(
                'Organization documents need organization admin (send X-Act-As-User of an admin).',
            );
        }
    }

    /**
     * `If-Match` as a compare-and-set. The pre-check (already done by the
     * caller) answers a stale or malformed version at once; then the claim, a
     * conditional UPDATE on `version`, makes this write the only one that
     * moves the record from that version: a concurrent writer with the same
     * `If-Match` gets `412`. The write runs with the claimed version, so its
     * event does not bump it again. Without `If-Match` the write just runs.
     */
    private async ifMatchWrite<T>(
        kind: 'kb_document' | 'kb_folder',
        id: string,
        ifMatch: string | undefined,
        currentVersion: number,
        write: () => Promise<T>,
    ): Promise<T> {
        const expected = expectedVersion(ifMatch);
        assertIfMatch(expected, currentVersion);
        if (expected === null) return write();
        if (!(await this.kb.claimVersion(kind, id, expected))) {
            const organizationId = this.organizationId();
            const now =
                kind === 'kb_document'
                    ? await this.kb.getDocument(organizationId, id)
                    : await this.kb.getFolder(organizationId, id);
            throw new VersionMismatchError(expected, now.dto.version);
        }
        // Review 2026-10-17 F53: the claim committed on its own. A write that is refused
        // (no edit access, a locked document) or changes nothing records no event, so its
        // claimed version is released; otherwise the row kept a version no event carries
        // and the integration's next If-Match on the old one answered 412.
        let taken = false;
        try {
            return await runWithClaimedAggregateVersion(
                { aggregateType: kind, id, version: expected + 1 },
                async () => {
                    try {
                        return await write();
                    } finally {
                        taken = claimedAggregateVersionTaken() === true;
                    }
                },
            );
        } finally {
            if (!taken) {
                await this.kb.releaseClaimedVersion(kind, id, expected).catch(() => undefined);
            }
        }
    }

    private sendDocument(res: Response, doc: IntegrationKbDocument): IntegrationKbDocumentDto {
        res.setHeader('ETag', doc.etag);
        return doc.dto;
    }

    private sendFolder(res: Response, folder: IntegrationKbFolder): IntegrationKbFolderDto {
        res.setHeader('ETag', folder.etag);
        return folder.dto;
    }
}

/**
 * The app's own refusal (no edit access to the Work, not an organization admin,
 * a locked document) is the integration's `422 domain_rule`, as for comments
 * (CR-2); every other error passes through.
 */
async function asDomainRule<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        if (error instanceof ForbiddenException) {
            const body = error.getResponse();
            const message =
                typeof body === 'object' && body !== null && 'message' in body
                    ? String((body as { message: unknown }).message)
                    : error.message;
            throw new IntegrationHttpException(422, 'domain_rule', message);
        }
        throw error;
    }
}

/**
 * Library folders need organization admin; checked before an `If-Match` claim
 * so a refusal does not move the version (the library checks it again).
 */
function assertCanManageLibrary(actor: KnowledgeLibraryActor): void {
    if (!actor.canManageOrganization) {
        throw new IntegrationHttpException(
            422,
            'domain_rule',
            'Library folders need organization admin (send X-Act-As-User of an admin).',
        );
    }
}

/** A comma-separated / repeated filter of a closed vocabulary (`400` for anything else). */
function closedList(
    path: string,
    value: string | string[] | undefined,
    allowed: readonly string[],
): string[] {
    const values = listParam(value);
    if (values.some((entry) => !allowed.includes(entry))) {
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
