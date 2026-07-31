import {
    BadRequestException,
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Logger,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Post,
    Put,
    Query,
    UnprocessableEntityException,
    UploadedFile,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
    ApiBearerAuth,
    ApiBody,
    ApiConsumes,
    ApiOperation,
    ApiQuery,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Transform, Type } from 'class-transformer';
import { CreateKbUploadDto } from '@ever-works/agent/dto';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
} from 'class-validator';
import {
    KnowledgeBaseService,
    MemoryConsolidationService,
    MemoryHealthService,
    type MemoryConsolidationReport,
} from '@ever-works/agent/services';
import type {
    KbDocumentClass,
    KbDocumentSource,
    KbDocumentStatus,
} from '@ever-works/agent/entities';
import {
    KB_DOCUMENT_CLASSES,
    KB_DOCUMENT_SOURCES,
    KB_DOCUMENT_STATUSES,
    KB_MEMORY_CONSOLIDATION_CADENCES,
    KB_MEMORY_CONSOLIDATION_MODES,
    type KbMemoryConsolidationSettings,
    type KbMemoryHealth,
} from '@ever-works/contracts';
import { UserUploadRepository } from '@ever-works/agent/database';
import { UploadsService } from '../uploads/uploads.service';
import { OrganizationMembershipService } from '../organizations/organization-membership.service';
import { ScopeContextService } from '../scope';
import { AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';

/**
 * Normalize a query-string facet param to `string[]`.
 *
 * Accepts the three shapes Nest/Express hand us for a repeatable query
 * key: an array (`?type=a&type=b`), a comma-joined string (`?type=a,b`),
 * or a single string (`?type=a`). Empty segments are dropped. Anything
 * else (object, number) collapses to `[]`.
 */
function toStringArray(value: unknown): string[] {
    const raw = Array.isArray(value) ? value : [value];
    return raw
        .flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
}

/**
 * Upper bound (and server-side default) for the Memory feed page size.
 *
 * Bounds the `limit` param so a caller can't request an unbounded page
 * and force the API to materialize every KB document across the org
 * into memory at once (OOM vector). Matches the web shell's default page
 * size (`MemoryShell.DEFAULT_LIMIT`) so the app's own requests validate.
 */
export const MEMORY_MAX_LIMIT = 200;

/**
 * Query params for `GET /api/memory` (Org-wide Memory, Cortex P1).
 *
 * The active Organization is resolved from the request SCOPE CONTEXT,
 * never from a query/body param — so there is deliberately no `orgId`
 * here. Facet params are multi-value (repeatable or comma-joined).
 */
export class MemoryQueryDto {
    @IsOptional()
    @IsString()
    @MaxLength(200)
    q?: string;

    @IsOptional()
    @Transform(({ value }) => toStringArray(value))
    @IsIn(KB_DOCUMENT_CLASSES as unknown as readonly string[], { each: true })
    type?: KbDocumentClass[];

    @IsOptional()
    @Transform(({ value }) => toStringArray(value))
    @IsString({ each: true })
    @MaxLength(64, { each: true })
    work?: string[];

    @IsOptional()
    @Transform(({ value }) => toStringArray(value))
    @IsIn(KB_DOCUMENT_STATUSES as unknown as readonly string[], { each: true })
    status?: KbDocumentStatus[];

    @IsOptional()
    @Transform(({ value }) => toStringArray(value))
    @IsIn(KB_DOCUMENT_SOURCES as unknown as readonly string[], { each: true })
    source?: KbDocumentSource[];

    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(MEMORY_MAX_LIMIT)
    @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
    limit?: number;

    @IsOptional()
    @IsInt()
    @Min(0)
    @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
    offset?: number;
}

/**
 * Query params for `GET /api/memory/health` (Memory eval loop, M10).
 *
 * Both knobs are bounded server-side by `MemoryHealthService`; the
 * validation here only rejects nonsense before it reaches the service.
 */
export class MemoryHealthQueryDto {
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(365)
    @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
    windowDays?: number;

    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(3650)
    @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
    staleAfterDays?: number;
}

/**
 * Body for `POST /api/memory/consolidate` (Memory Consolidation).
 * `apply` defaults to `false` — a bare POST is always a dry-run preview;
 * persisting markers requires an explicit `{ "apply": true }`.
 */
export class MemoryConsolidateDto {
    @IsOptional()
    @IsBoolean()
    apply?: boolean;
}

/**
 * Same cap, same env var, as the per-Work KB upload route — Memory is a
 * different destination for the same bytes, so a file that is acceptable
 * to one and rejected by the other would be arbitrary.
 */
const MEMORY_UPLOAD_MAX_BYTES = Number(process.env.KB_UPLOAD_MAX_BYTES) || 200 * 1024 * 1024;

/**
 * Body for `POST /api/memory/uploads/from-attachments`.
 *
 * The ids are content hashes the client already holds from the chat
 * composer — the same `<sha256>` segment of an `/api/uploads/...` URL.
 */
export class IngestAttachmentsDto {
    @IsArray()
    @ArrayMaxSize(20)
    @IsString({ each: true })
    @Matches(/^[a-f0-9]{64}$/, { each: true })
    attachmentIds: string[];
}

/**
 * Body for `PUT /api/memory/consolidation/settings`.
 *
 * Every field is optional so a caller can flip one knob without
 * restating the rest; the handler merges onto what is stored.
 */
export class MemoryConsolidationSettingsDto {
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;

    @IsOptional()
    @IsIn(KB_MEMORY_CONSOLIDATION_CADENCES as unknown as readonly string[])
    cadence?: string;

    @IsOptional()
    @IsIn(KB_MEMORY_CONSOLIDATION_MODES as unknown as readonly string[])
    mode?: string;

    @IsOptional()
    @IsBoolean()
    notify?: boolean;
}

/** Query for `GET /api/memory/uploads`. */
export class ListMemoryUploadsDto {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(200)
    limit?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    offset?: number;
}

/**
 * Org-wide Memory (Cortex P1) — the aggregation surface over the
 * per-Work Knowledge Base, fanned in across the active Organization.
 *
 * This is a NEW read-mostly surface that sits ABOVE the existing per-Work
 * KB workbench; it removes/renames nothing. It reuses the existing
 * `KnowledgeBaseService` + `WorkKnowledgeDocument` tables read-only — no
 * new embedding or storage logic.
 *
 * **Org resolution + security.** Unlike the per-Work KB routes, Memory
 * is session-scoped: the Organization comes from the request SCOPE
 * CONTEXT (`ScopeContextService.getOrganizationId()`), which the
 * `SessionScopeGuard` seeds from the authenticated user's validated
 * last-active Org on these legacy un-prefixed routes — never from a
 * query/body param. When no Organization is resolvable (bare-Tenant
 * "personal" surface, or an un-upgraded user) the endpoint returns an
 * EMPTY aggregation — there is no unscoped or cross-tenant scan (spec
 * §2.1 / §7). As defense-in-depth we also assert org membership via the
 * shared `OrganizationMembershipService` (mirrors `OrgKbController`).
 */
@ApiTags('Memory (Organization)')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(AuthSessionGuard)
export class OrgMemoryController {
    constructor(
        private readonly kb: KnowledgeBaseService,
        private readonly consolidation: MemoryConsolidationService,
        private readonly membership: OrganizationMembershipService,
        private readonly scopeContext: ScopeContextService,
        private readonly health: MemoryHealthService,
        private readonly uploads: UploadsService,
        private readonly userUploads: UserUploadRepository,
    ) {}

    private readonly logger = new Logger(OrgMemoryController.name);

    @Get('memory/health')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Memory health — retrieval quality metrics for the active Organization',
        description:
            'Memory upgrades M10. Joins the append-only KB retrieval log against citation rows and the KB documents themselves to report: the recall-hit rate (were the documents we injected actually cited?), the stale-decision rate (settled calls nobody has revisited), the proposed-review backlog and its age, and the gap topics (questions retrieval could not answer). Every rate is `number | null` — `null` means "not measurable yet" and must never be rendered as 0%. The Organization comes from the request scope context, not a param.',
    })
    @ApiQuery({
        name: 'windowDays',
        required: false,
        description: 'Rolling window for the retrieval metrics (default 30, clamped 1…365).',
    })
    @ApiQuery({
        name: 'staleAfterDays',
        required: false,
        description: 'Age at which an untouched accepted decision counts as stale (default 90).',
    })
    @ApiResponse({ status: 200, description: 'Memory health metrics' })
    async getMemoryHealth(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: MemoryHealthQueryDto,
    ): Promise<KbMemoryHealth> {
        const organizationId = this.scopeContext.getOrganizationId();
        if (!organizationId) {
            // No active Organization ⇒ the empty payload (all counts 0,
            // every rate null). Mirrors the GET aggregation — never a
            // cross-tenant scan.
            return this.health.emptyHealth({
                windowDays: query.windowDays,
                staleAfterDays: query.staleAfterDays,
            });
        }

        // Same defense-in-depth membership gate as the aggregation +
        // consolidate routes: NotFound (not Forbidden) on a cross-tenant
        // mismatch, matching the existence-leak contract.
        await this.membership.ensureMember(organizationId, auth.userId);

        return this.health.getOrgHealth(organizationId, {
            windowDays: query.windowDays,
            staleAfterDays: query.staleAfterDays,
        });
    }

    @Get('memory')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Org-wide Memory — faceted aggregation of KB documents',
        description:
            'Aggregates every Knowledge Base document across all Works in the active Organization (∪ the org-level documents), faceted by Type / Work / Source / Status and lexically searchable. The Organization is taken from the request scope context, not a param.',
    })
    @ApiQuery({
        name: 'q',
        required: false,
        description: 'Lexical search over title + description',
    })
    @ApiQuery({
        name: 'type',
        required: false,
        isArray: true,
        description: 'KB document class filter',
    })
    @ApiQuery({ name: 'work', required: false, isArray: true, description: 'Work id filter' })
    @ApiQuery({ name: 'status', required: false, isArray: true })
    @ApiQuery({ name: 'source', required: false, isArray: true })
    @ApiResponse({ status: 200, description: 'Aggregated Memory feed + counts + facets' })
    async getMemory(@CurrentUser() auth: AuthenticatedUser, @Query() query: MemoryQueryDto) {
        const organizationId = this.scopeContext.getOrganizationId();
        if (!organizationId) {
            // No active Organization ⇒ empty aggregation. Never a
            // cross-tenant scan — Memory is org-bounded by construction.
            return {
                documents: [],
                counts: { documents: 0, indexed: 0 },
                facets: { types: [], works: [], statuses: [], sources: [] },
            };
        }

        // Defense-in-depth: the caller must belong to the Tenant that owns
        // the active org. The scope was seeded from the user's own
        // validated last-active Org, so this is normally a formality — but
        // it keeps the authorization explicit and consistent with the
        // sibling org-KB routes. Throws NotFound (not Forbidden) on a
        // cross-tenant mismatch, matching the existence-leak contract.
        await this.membership.ensureMember(organizationId, auth.userId);

        return this.kb.aggregateOrgMemory(organizationId, {
            classes: query.type,
            statuses: query.status,
            sources: query.source,
            workIds: query.work,
            q: query.q,
            // Default the page size server-side so an omitted `limit` can't
            // fall through to an unbounded scan of the whole org's KB (the
            // repository skips its LIMIT clause when `limit` is undefined).
            limit: query.limit ?? MEMORY_MAX_LIMIT,
            offset: query.offset,
        });
    }

    @Post('memory/consolidate')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Memory Consolidation — curate the org-wide Memory feed',
        description:
            'On-demand consolidation pass over the active Organization’s aggregated Memory: near-duplicate documents are SUPERSEDED (marked, never deleted), the strongest documents are PROMOTED (top-N by a transparent additive score), and — when an AI provider is configured — duplicate clusters of 3+ documents are synthesized into one merged org document. `apply` defaults to false (dry-run preview that writes nothing); pass `{ "apply": true }` to persist the markers. The Organization comes from the request scope context, not a param.',
    })
    @ApiResponse({
        status: 200,
        description:
            'Consolidation report — { scanned, promoted, synthesized, superseded, dryRun, notes, details }',
    })
    async consolidateMemory(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: MemoryConsolidateDto,
    ): Promise<MemoryConsolidationReport> {
        const apply = body.apply === true;
        const organizationId = this.scopeContext.getOrganizationId();
        if (!organizationId) {
            // No active Organization ⇒ nothing to consolidate. Mirrors the
            // GET aggregation's empty payload — never a cross-tenant scan.
            return {
                scanned: 0,
                promoted: 0,
                synthesized: 0,
                superseded: 0,
                dryRun: !apply,
                notes: ['No active Organization — nothing to consolidate.'],
                details: { promotedIds: [], supersededPairs: [], synthesizedIds: [] },
            };
        }

        // Same defense-in-depth membership gate as the GET aggregation:
        // throws NotFound (not Forbidden) on a cross-tenant mismatch,
        // matching the existence-leak contract.
        // WRITE side => `ensureAdmin`, not `ensureMember`. Identical checks
        // today (no org-admin role in the schema yet) — routing writes
        // through this name is what gives the future role model a single
        // seam to tighten, instead of a retrofit across every route.
        await this.membership.ensureAdmin(organizationId, auth.userId);

        return this.consolidation.runConsolidation(
            { organizationId, userId: auth.userId },
            { apply },
        );
    }

    @Post('memory/uploads')
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MEMORY_UPLOAD_MAX_BYTES } }))
    @ApiConsumes('multipart/form-data')
    @ApiOperation({
        summary: 'Upload a file into global Memory',
        description:
            'Multipart upload of a file into the active Organization’s global Memory, rather than into a single Work’s Knowledge Base. The server computes SHA-256, dedups against existing Memory originals, persists the bytes via the configured storage plugin, extracts the text to markdown where an extractor route exists, and materializes an organization-scoped document. The Organization comes from the request scope context, not a param.',
    })
    @ApiBody({
        schema: {
            type: 'object',
            required: ['file'],
            properties: {
                file: { type: 'string', format: 'binary' },
                targetClass: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                autoClassify: { type: 'boolean' },
            },
        },
    })
    @ApiResponse({ status: 201, description: 'Upload accepted; returns the upload row + document' })
    @ApiResponse({ status: 400, description: 'Missing file or invalid metadata' })
    @ApiResponse({ status: 422, description: 'No active Organization on the request scope' })
    @ApiResponse({ status: 503, description: 'Storage plugin not configured' })
    async createMemoryUpload(
        @CurrentUser() auth: AuthenticatedUser,
        @UploadedFile() file: Express.Multer.File | undefined,
        @Body() body: CreateKbUploadDto,
    ) {
        if (!file) {
            throw new BadRequestException({
                status: 'error',
                message: "Multipart field 'file' is required",
            });
        }

        const organizationId = this.scopeContext.getOrganizationId();
        if (!organizationId) {
            // Deliberately NOT the empty-payload treatment the read paths
            // give this case. A read with no active Organization has an
            // honest answer ("nothing"); a write does not — silently
            // accepting bytes that belong to no Organization would report
            // success for a file the user could never retrieve.
            throw new UnprocessableEntityException({
                status: 'error',
                message: 'No active Organization — select one before uploading to Memory',
            });
        }

        // WRITE side => `ensureAdmin`, not `ensureMember`. Identical checks
        // today (no org-admin role in the schema yet) — routing writes
        // through this name is what gives the future role model a single
        // seam to tighten, instead of a retrofit across every route.
        await this.membership.ensureAdmin(organizationId, auth.userId);

        return this.kb.createOrgUpload({
            organizationId,
            userId: auth.userId,
            file: {
                buffer: file.buffer,
                originalFilename: file.originalname,
                mimeType: file.mimetype,
                size: file.size,
            },
            // Same cast the per-Work upload route makes: the DTO types
            // this against the contracts' KbDocumentClass while the
            // service signature uses the entities' one. Identical unions,
            // two declarations.
            targetClass: body.targetClass as KbDocumentClass | undefined,
            title: body.title,
            description: body.description ?? null,
            tags: body.tags,
            autoClassify: body.autoClassify,
        });
    }

    @Post('memory/uploads/from-attachments')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Ingest already-uploaded chat attachments into global Memory',
        description:
            'Takes content hashes of files the caller previously uploaded through `/api/uploads` — the ids the chat composer already holds — and copies them into the active Organization’s Memory. The bytes are read back from the storage spine that wrote them rather than being re-uploaded from the browser. Each id is resolved against the CALLER’s own uploads, so an id belonging to someone else resolves to nothing. Per-attachment failures are reported in the response rather than failing the batch, because this runs alongside a chat message that must not be lost.',
    })
    @ApiResponse({ status: 200, description: '{ results: [{ attachmentId, status, uploadId? }] }' })
    @ApiResponse({ status: 422, description: 'No active Organization on the request scope' })
    async ingestAttachmentsIntoMemory(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: IngestAttachmentsDto,
    ) {
        const organizationId = this.scopeContext.getOrganizationId();
        if (!organizationId) {
            throw new UnprocessableEntityException({
                status: 'error',
                message: 'No active Organization — cannot ingest attachments into Memory',
            });
        }
        // WRITE side => `ensureAdmin`, not `ensureMember`. Identical checks
        // today (no org-admin role in the schema yet) — routing writes
        // through this name is what gives the future role model a single
        // seam to tighten, instead of a retrofit across every route.
        await this.membership.ensureAdmin(organizationId, auth.userId);

        const results: Array<{ attachmentId: string; status: string; uploadId?: string }> = [];
        for (const attachmentId of body.attachmentIds) {
            // Ownership is the lookup: `findOwnedByUser` scopes to the
            // caller, so a hash belonging to another user simply is not
            // found. No separate authorization check to forget.
            const record = await this.userUploads.findOwnedByUser(attachmentId, auth.userId);
            if (!record) {
                results.push({ attachmentId, status: 'not_found' });
                continue;
            }

            try {
                // The stored object's basename is what `readFile` keys on;
                // deriving it from `storagePath` rather than rebuilding
                // `<sha>.<ext>` keeps this correct for every backend's own
                // path shape.
                const filename = record.storagePath.split('/').pop() ?? '';
                const { buffer, mimeType } = await this.uploads.readFile(auth.userId, filename, {
                    workId: record.workId ?? undefined,
                });

                const { upload } = await this.kb.createOrgUpload({
                    organizationId,
                    userId: auth.userId,
                    file: {
                        buffer,
                        originalFilename: record.originalFilename ?? filename,
                        mimeType: record.mimeType ?? mimeType,
                        size: buffer.length,
                    },
                    autoClassify: true,
                });
                results.push({ attachmentId, status: 'ingested', uploadId: upload.id });
            } catch (error) {
                // Best-effort by design: this is triggered by sending a
                // chat message, and a storage hiccup on one attachment
                // must not fail the others or the message itself.
                this.logger.warn(
                    `Memory ingest failed for attachment ${attachmentId}: ${
                        (error as Error).message
                    }`,
                );
                results.push({ attachmentId, status: 'failed' });
            }
        }

        return { results };
    }

    @Get('memory/consolidation/settings')
    @ApiOperation({
        summary: 'Scheduled Memory Consolidation settings',
        description:
            'Cadence, mode and notification settings for the scheduled consolidation pass, plus `lastRunAt`. Returns the defaults when the Organization has never configured it.',
    })
    @ApiResponse({ status: 200, description: 'Current settings' })
    async getConsolidationSettings(@CurrentUser() auth: AuthenticatedUser) {
        const organizationId = this.scopeContext.getOrganizationId();
        if (!organizationId) {
            return { enabled: false, cadence: 'weekly', mode: 'dry-run', notify: true };
        }
        await this.membership.ensureMember(organizationId, auth.userId);
        return this.consolidation.getScheduleSettings(organizationId);
    }

    @Put('memory/consolidation/settings')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Configure scheduled Memory Consolidation',
        description:
            'Turns the scheduled pass on or off and sets its cadence and mode. Until this exists the settings column was never written by anything, so the scheduler — which only selects organizations whose settings are non-null — could never run for anyone. `mode` defaults to `dry-run`: the pass reports without persisting, and nothing is ever auto-accepted.',
    })
    @ApiResponse({ status: 200, description: 'The stored settings' })
    @ApiResponse({ status: 422, description: 'No active Organization on the request scope' })
    async putConsolidationSettings(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: MemoryConsolidationSettingsDto,
    ) {
        const organizationId = this.scopeContext.getOrganizationId();
        if (!organizationId) {
            throw new UnprocessableEntityException({
                status: 'error',
                message: 'No active Organization — cannot configure Memory Consolidation',
            });
        }
        // WRITE side => `ensureAdmin`, not `ensureMember`. Identical checks
        // today (no org-admin role in the schema yet) — routing writes
        // through this name is what gives the future role model a single
        // seam to tighten, instead of a retrofit across every route.
        await this.membership.ensureAdmin(organizationId, auth.userId);
        return this.consolidation.updateScheduleSettings(
            organizationId,
            body as Partial<KbMemoryConsolidationSettings>,
        );
    }

    @Get('memory/review')
    @ApiOperation({
        summary: 'Memory review queue — documents awaiting a human',
        description:
            'Organization documents with `reviewState: proposed`. Memory Consolidation lands LLM-synthesized merges here rather than accepting them automatically; they are withheld from context injection until accepted. The Organization comes from the request scope context.',
    })
    @ApiQuery({ name: 'limit', required: false, type: Number })
    @ApiQuery({ name: 'offset', required: false, type: Number })
    @ApiResponse({ status: 200, description: '{ items, total }' })
    async listMemoryReviewQueue(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListMemoryUploadsDto,
    ) {
        const organizationId = this.scopeContext.getOrganizationId();
        if (!organizationId) {
            return { items: [], total: 0 };
        }
        await this.membership.ensureMember(organizationId, auth.userId);
        return this.kb.listOrgReviewQueue(organizationId, {
            limit: query.limit ?? 50,
            offset: query.offset ?? 0,
        });
    }

    @Post('memory/review/:docId/accept')
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Accept a proposed Memory document',
        description:
            'Marks a proposed organization document as accepted, which makes it eligible for context injection and — for an inheritable class — overlays it into every Work. Returns 404 when the document does not exist, belongs to another organization, or is Work-scoped.',
    })
    @ApiResponse({ status: 200, description: 'The accepted document' })
    @ApiResponse({ status: 404, description: 'No such document in this Organization' })
    @ApiResponse({ status: 422, description: 'No active Organization on the request scope' })
    async acceptMemoryDocument(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('docId', new ParseUUIDPipe()) docId: string,
    ) {
        const organizationId = this.scopeContext.getOrganizationId();
        if (!organizationId) {
            throw new UnprocessableEntityException({
                status: 'error',
                message: 'No active Organization — cannot accept a Memory document',
            });
        }
        // WRITE side => `ensureAdmin`, not `ensureMember`. Identical checks
        // today (no org-admin role in the schema yet) — routing writes
        // through this name is what gives the future role model a single
        // seam to tighten, instead of a retrofit across every route.
        await this.membership.ensureAdmin(organizationId, auth.userId);

        const accepted = await this.kb.acceptOrgDocument(organizationId, docId, auth.userId);
        if (!accepted) {
            // Deliberately indistinguishable from "does not exist": a
            // caller must not be able to probe which document ids belong
            // to another Organization.
            throw new NotFoundException({ status: 'error', message: 'Document not found' });
        }
        return accepted;
    }

    @Get('memory/uploads')
    @ApiOperation({
        summary: 'List global-Memory originals',
        description:
            'Paginated list of the uploaded source files backing the active Organization’s Memory, with their extraction status. Work-scoped uploads are excluded.',
    })
    @ApiQuery({ name: 'limit', required: false, type: Number })
    @ApiQuery({ name: 'offset', required: false, type: Number })
    @ApiResponse({ status: 200, description: '{ items, total }' })
    async listMemoryUploads(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListMemoryUploadsDto,
    ) {
        const organizationId = this.scopeContext.getOrganizationId();
        if (!organizationId) {
            return { items: [], total: 0 };
        }
        await this.membership.ensureMember(organizationId, auth.userId);
        return this.kb.listOrgUploads(organizationId, {
            limit: query.limit ?? 50,
            offset: query.offset ?? 0,
        });
    }
}
