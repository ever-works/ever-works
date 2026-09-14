import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Optional,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    MAX_SKILL_FILE_BYTES,
    SkillBindingRepository,
    SkillFilesService,
    SkillReadinessService,
    SkillRepository,
    SkillsService,
    SkillTagRepository,
    type ListSkillsFilter,
    type Skill,
} from '@ever-works/agent/skills';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import {
    SKILL_TAG_FACET_LIMIT,
    deriveSkillCardState,
    normalizeSkillTags,
    type SkillCardState,
} from '@ever-works/contracts';
import { isTextLikeMime } from '@ever-works/agent/agents';
import { SkillsFacadeService } from '@ever-works/agent/facades';
import type { SkillCatalogEntry, SkillCatalogListResult } from '@ever-works/plugin';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { UploadsService } from '../uploads/uploads.service';
import { SkillFileContentReaderService } from './skill-file-content-reader.service';
import {
    CreateSkillBindingDto,
    CreateSkillDto,
    InstallCatalogSkillDto,
    ListSkillCatalogQueryDto,
    ListSkillsQueryDto,
    ListSkillTagsQueryDto,
    UpdateSkillDto,
    UploadSkillFileDto,
} from './dto/skill.dto';
import type {
    SkillReadinessDto,
    SkillShelfRowDto,
    SkillSwitchDto,
    SkillTagFacetsDto,
} from './dto/skill-shelf.dto';
import { provenanceOf, resolveSkillProvenanceSources } from './skill-provenance';

/** How long an on-demand re-check may take before the cached verdict is returned (FR-28). */
export const SKILL_READINESS_REFRESH_BUDGET_MS = 3_000;

/**
 * Agents/Skills/Tasks PR #1017 — Phase 8.7. Read-only Skills API.
 *
 *   GET /api/skills/catalog          paginated catalog from enabled
 *                                    skills-provider plugins
 *   GET /api/skills/catalog/:slug    one catalog entry by slug
 *   GET /api/skills                  the user's installed Skills
 *   GET /api/skills/:id              one Skill
 *
 * Write paths (POST/PATCH/DELETE) ship with Phase 9 alongside
 * SkillsService + bindings CRUD.
 *
 * Cross-user reads return 404 (security spec §8 — no existence
 * leak via 403).
 */
@ApiTags('skills')
@Controller('api/skills')
export class SkillsController {
    constructor(
        private readonly skills: SkillRepository,
        private readonly facade: SkillsFacadeService,
        private readonly service: SkillsService,
        private readonly files: SkillFilesService,
        private readonly uploads: UploadsService,
        private readonly fileContent: SkillFileContentReaderService,
        // Skills shelf. APPENDED LAST + `@Optional()` so every existing
        // positional construction keeps compiling; unbound, the list answers
        // exactly as it did before and the shelf endpoints 404.
        @Optional() private readonly readiness?: SkillReadinessService,
        @Optional() private readonly skillTags?: SkillTagRepository,
        @Optional() private readonly skillBindings?: SkillBindingRepository,
        @Optional() private readonly pluginRegistry?: PluginRegistryService,
    ) {}

    @Get('catalog')
    @ApiOperation({
        summary: 'List catalog skills (union across enabled skills-provider plugins).',
    })
    @HttpCode(HttpStatus.OK)
    async catalog(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListSkillCatalogQueryDto,
    ): Promise<SkillCatalogListResult> {
        return this.facade.listEntries(
            {
                limit: query.limit ?? 50,
                offset: query.offset ?? 0,
                search: query.search,
                tags: query.tags,
            },
            { userId: auth.userId },
        );
    }

    @Get('catalog/:slug')
    @ApiOperation({ summary: 'Get one catalog entry by slug.' })
    @HttpCode(HttpStatus.OK)
    async catalogEntry(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('slug') slug: string,
    ): Promise<{ entry: SkillCatalogEntry; providerId: string }> {
        if (!slug || !/^[a-z0-9-]{1,80}$/.test(slug)) {
            throw new BadRequestException('Invalid skill slug.');
        }
        const found = await this.facade.getEntry(slug, { userId: auth.userId });
        if (!found) {
            throw new NotFoundException(`Catalog skill "${slug}" not found.`);
        }
        return found;
    }

    @Get()
    @ApiOperation({
        summary:
            'List my installed Skills (filterable by ownerType / search / tags / readiness / provenance / enabled; sortable).',
    })
    @HttpCode(HttpStatus.OK)
    async list(@CurrentUser() auth: AuthenticatedUser, @Query() query: ListSkillsQueryDto) {
        const provenanceSources = resolveSkillProvenanceSources(this.pluginRegistry);
        const filter: ListSkillsFilter = {
            ownerType: query.ownerType,
            ownerId: query.ownerId,
            search: query.search,
            limit: query.limit ?? 50,
            offset: query.offset ?? 0,
        };
        // Skills shelf filters — only set when asked for, so a request with
        // none of them builds exactly the query it built before.
        if (query.tags?.length) filter.tags = query.tags;
        if (query.readiness) filter.readiness = query.readiness;
        if (query.provenance) {
            filter.provenance = query.provenance;
            filter.provenanceSources = provenanceSources;
        }
        if (query.enabled !== undefined) filter.enabled = query.enabled;
        if (query.sort) filter.sort = query.sort;

        const { rows, total } = await this.skills.findByUserIdFiltered(auth.userId, filter);
        const ids = rows.map((row) => row.id);
        const [tagsBySkill, bindingCounts, counts] = await Promise.all([
            this.skillTags?.findBySkillIds(ids, auth.userId) ?? new Map<string, string[]>(),
            this.skillBindings?.countBySkillIds(ids, auth.userId) ?? new Map<string, number>(),
            this.skills.countsByCardState(auth.userId, {
                ownerType: query.ownerType,
                ownerId: query.ownerId,
            }),
        ]);
        const data: SkillShelfRowDto[] = rows.map((row) =>
            Object.assign(row, {
                tags: tagsBySkill.get(row.id) ?? [],
                cardState: deriveSkillCardState(row),
                provenance: provenanceOf(row, provenanceSources),
                boundTargetCount: bindingCounts.get(row.id) ?? 0,
            }),
        );
        this.recheckVisibleInBackground(rows);
        return {
            data,
            meta: { total, limit: filter.limit, offset: filter.offset },
            // Skills shelf — per-card-state counts for the summary line, over
            // the whole shelf (not the current search/tag narrowing).
            counts,
        };
    }

    // NOTE: declared BEFORE `:id` so the literal segment wins route
    // matching (`:id` runs ParseUUIDPipe and would 400 on "tags").
    @Get('tags')
    @ApiOperation({
        summary:
            'Skills shelf: tags across my Skills with how many Skills carry each, most-used first (at most 200).',
    })
    @HttpCode(HttpStatus.OK)
    async tags(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListSkillTagsQueryDto,
    ): Promise<SkillTagFacetsDto> {
        if (!this.skillTags) return { tags: [], total: 0 };
        return this.skillTags.facets(auth.userId, query.limit ?? SKILL_TAG_FACET_LIMIT);
    }

    // NOTE: declared BEFORE `:id` so the literal segment wins route
    // matching (`:id` runs ParseUUIDPipe and would 400 on "invocable").
    @Get('invocable')
    @ApiOperation({
        summary: 'List my skills that carry an invocation slug (composer autocomplete).',
    })
    @HttpCode(HttpStatus.OK)
    async invocable(@CurrentUser() auth: AuthenticatedUser) {
        const rows = await this.service.listInvocable(auth.userId);
        return {
            data: rows.map((skill) => ({
                id: skill.id,
                title: skill.title,
                slug: skill.slug,
                invocationSlug: skill.invocationSlug,
                description: skill.description,
            })),
        };
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get one Skill.' })
    @HttpCode(HttpStatus.OK)
    async getOne(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        const skill = await this.skills.findByIdAndUser(id, auth.userId);
        if (!skill) {
            throw new NotFoundException(`Skill ${id} not found.`);
        }
        return skill;
    }

    // ── Phase 9 — write paths ────────────────────────────────────

    @Post()
    @ApiOperation({ summary: 'Create a custom Skill.' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async create(@CurrentUser() auth: AuthenticatedUser, @Body() body: CreateSkillDto) {
        return withTagsDropped(
            await this.service.create(auth.userId, {
                ownerType: body.ownerType,
                ownerId: body.ownerId,
                title: body.title,
                description: body.description,
                instructionsMd: body.instructionsMd,
                frontmatter: body.frontmatter
                    ? ({
                          name: String(body.frontmatter.name ?? body.slug ?? body.title),
                          description: String(body.frontmatter.description ?? body.description),
                          ...body.frontmatter,
                      } as any)
                    : undefined,
                slug: body.slug,
                version: body.version,
                invocationSlug: body.invocationSlug,
            }),
        );
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update Skill body / frontmatter.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: UpdateSkillDto,
    ) {
        return withTagsDropped(
            await this.service.update(auth.userId, id, {
                title: body.title,
                description: body.description,
                instructionsMd: body.instructionsMd,
                frontmatter: body.frontmatter as any,
                version: body.version,
                invocationSlug: body.invocationSlug,
            }),
        );
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete a Skill (cascades to bindings).' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ deleted: true }> {
        return this.service.remove(auth.userId, id);
    }

    @Post('install')
    @ApiOperation({ summary: 'Install a catalog skill at the requested scope.' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async install(@CurrentUser() auth: AuthenticatedUser, @Body() body: InstallCatalogSkillDto) {
        const found = await this.facade.getEntry(body.slug, { userId: auth.userId });
        if (!found) throw new NotFoundException(`Catalog skill "${body.slug}" not found.`);

        return this.service.installFromCatalog(auth.userId, {
            catalogProviderId: found.providerId,
            catalogSlug: body.slug,
            ownerType: body.ownerType,
            ownerId: body.ownerId,
            entry: found.entry,
        });
    }

    // ── Skill files (companion files over the uploads spine) ────────

    @Post(':id/files')
    @ApiOperation({
        summary:
            'Upload a companion file (script/reference/config/asset) for a Skill. Multipart field "file"; optional "kind" (defaults by extension). 2 MB cap, 20 files per skill.',
    })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SKILL_FILE_BYTES } }))
    async uploadFile(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @UploadedFile() file: Express.Multer.File | undefined,
        @Body() body: UploadSkillFileDto,
    ) {
        if (!file || !file.buffer || file.buffer.length === 0) {
            throw new BadRequestException("Multipart field 'file' is required.");
        }
        // Ownership FIRST — a cross-user skill id must 404 before any
        // bytes are stored (no existence leak, no orphan writes).
        await this.service.getOne(auth.userId, id);
        if (file.size > MAX_SKILL_FILE_BYTES) {
            throw new BadRequestException(
                `Skill files are capped at ${MAX_SKILL_FILE_BYTES / (1024 * 1024)} MB.`,
            );
        }

        // The uploads spine accepts a FIXED mime allow-list; browsers
        // report code files (.py/.sh/.toml/…) with exotic or empty
        // mimes. Coerce anything the spine would reject — but whose bytes
        // are valid UTF-8 — to text/plain so a script upload doesn't
        // bounce off that allow-list; the display filename (and kind)
        // keep the real identity.
        //
        // The predicate MUST be the spine's own `acceptsSaveFileMime`,
        // not "does it start with text/". Chrome/Firefox report `.py` as
        // `text/x-python`, which is text-like by that looser test yet is
        // NOT in the spine's `TEXT_LIKE_MIMES` map — leaving it uncoerced
        // made every script upload 400 with `MimeNotAllowed`.
        const declared = (file.mimetype || '').toLowerCase();
        let effectiveMime = declared;
        let textContent: string | undefined;
        try {
            textContent = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
        } catch {
            textContent = undefined;
        }
        if (textContent !== undefined && !this.uploads.acceptsSaveFileMime(declared)) {
            effectiveMime = 'text/plain';
        }

        const stored = await this.uploads.saveFile(auth.userId, {
            buffer: file.buffer,
            mimetype: effectiveMime,
            size: file.size,
            originalname: file.originalname,
        });

        return this.files.add(auth.userId, {
            skillId: id,
            uploadId: stored.hash,
            filename: file.originalname,
            kind: body.kind,
            sizeBytes: file.size,
            mime: effectiveMime,
            // Text uploads are secret-scanned with the same scanner
            // skill bodies use (inside SkillFilesService.add).
            textContent: isTextLikeMime(effectiveMime) ? textContent : undefined,
        });
    }

    @Get(':id/files')
    @ApiOperation({ summary: "List a Skill's companion files." })
    @HttpCode(HttpStatus.OK)
    async listFiles(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        return this.files.list(auth.userId, id);
    }

    @Get(':id/files/:fileId/content')
    @ApiOperation({
        summary: "Fetch a text companion file's content (owner-gated; binary files are refused).",
    })
    @HttpCode(HttpStatus.OK)
    @Header('Content-Type', 'text/plain; charset=utf-8')
    // Security: never let a stored file render in the browser context.
    @Header('Content-Disposition', 'attachment')
    @Header('X-Content-Type-Options', 'nosniff')
    async fileContentEndpoint(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('fileId', ParseUUIDPipe) fileId: string,
    ): Promise<string> {
        const file = await this.files.getOne(auth.userId, id, fileId);
        if (!isTextLikeMime(file.mime)) {
            throw new BadRequestException(
                `File "${file.filename}" is binary (${file.mime}) — content retrieval supports text files only.`,
            );
        }
        const result = await this.fileContent.readTextContent({
            userId: auth.userId,
            uploadId: file.uploadId,
            mime: file.mime,
            filename: file.filename,
        });
        if ('error' in result) {
            throw new NotFoundException(result.error);
        }
        return result.content;
    }

    @Delete(':id/files/:fileId')
    @ApiOperation({
        summary: 'Remove a companion file from a Skill (bytes stay in the uploads spine).',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async removeFile(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('fileId', ParseUUIDPipe) fileId: string,
    ): Promise<{ deleted: true }> {
        return this.files.remove(auth.userId, id, fileId);
    }

    // ── Skills shelf — on/off switch and readiness ─────────────────

    @Post(':id/enable')
    @ApiOperation({
        summary:
            'Switch a Skill back on. Idempotent. Its bindings are untouched; takes effect on the next run.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async enable(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<SkillSwitchDto> {
        return this.switchResult(auth.userId, await this.service.enable(auth.userId, id));
    }

    @Post(':id/disable')
    @ApiOperation({
        summary:
            'Switch a Skill off for every run started from now on. Idempotent. Its bindings are untouched.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async disable(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<SkillSwitchDto> {
        return this.switchResult(auth.userId, await this.service.disable(auth.userId, id));
    }

    @Get(':id/readiness')
    @ApiOperation({
        summary:
            "A Skill's cached readiness verdict and the requirements behind it (identifiers only).",
    })
    @HttpCode(HttpStatus.OK)
    async getReadiness(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<SkillReadinessDto> {
        return readinessDto(await this.service.getOne(auth.userId, id));
    }

    @Post(':id/readiness/refresh')
    @ApiOperation({
        summary:
            "Re-check a Skill's readiness now. Answers within 3 seconds; past that, the cached verdict comes back marked stale while the re-check finishes.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    async refreshReadiness(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<SkillReadinessDto> {
        const skill = await this.service.getOne(auth.userId, id);
        if (!this.readiness) return readinessDto(skill);

        let timer: ReturnType<typeof setTimeout> | undefined;
        const budget = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), SKILL_READINESS_REFRESH_BUDGET_MS);
        });
        const work = this.readiness.refreshSkill(skill).then(
            () => 'done' as const,
            () => 'failed' as const,
        );
        const outcome = await Promise.race([work, budget]);
        if (timer) clearTimeout(timer);
        if (outcome === 'done') return readinessDto(skill);
        // Over budget or failed: the previous verdict, honestly labelled.
        return {
            ...readinessDto(skill),
            cardState: stateOrUnknown(skill),
            stale: true,
        };
    }

    // ── Phase 9 — Bindings CRUD ──────────────────────────────────

    @Get(':id/bindings')
    @ApiOperation({ summary: 'List bindings for one Skill.' })
    @HttpCode(HttpStatus.OK)
    async listBindings(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        return this.service.listBindings(auth.userId, id);
    }

    @Post(':id/bindings')
    @ApiOperation({ summary: 'Create a binding for a Skill.' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async createBinding(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: CreateSkillBindingDto,
    ) {
        return this.service.createBinding(auth.userId, {
            skillId: id,
            targetType: body.targetType,
            targetId: body.targetId,
            priority: body.priority,
            injectIntoAgent: body.injectIntoAgent,
            injectIntoGenerator: body.injectIntoGenerator,
        });
    }

    /**
     * Skills shelf — top up the verdicts of the Skills on screen that nothing
     * has checked yet (every Skill starts that way) or whose verdict is stale,
     * a few per request (`SkillReadinessService.recheckVisible` holds the cap).
     *
     * Fire-and-forget, the same posture as a run folding a suppression into
     * the cached verdict: the list has already been built and never waits on
     * this, and nothing it does can fail the response. The fresh verdicts show
     * on the next load; the hourly sweep covers whatever this skips.
     */
    private recheckVisibleInBackground(rows: Skill[]): void {
        const readiness = this.readiness;
        if (!readiness || rows.length === 0) return;
        void Promise.resolve()
            .then(() => readiness.recheckVisible(rows))
            .catch(() => undefined);
    }

    private async switchResult(
        userId: string,
        result: {
            id: string;
            cardState: SkillCardState;
            disabledAt: Date | null;
            changed: boolean;
        },
    ): Promise<SkillSwitchDto> {
        const skill = await this.skills.findByIdAndUser(result.id, userId);
        return {
            id: result.id,
            cardState: result.cardState,
            readiness: skill?.readiness ?? 'unknown',
            disabledAt: result.disabledAt,
            changed: result.changed,
        };
    }
}

function readinessDto(skill: Skill): SkillReadinessDto {
    return {
        id: skill.id,
        readiness: skill.readiness ?? 'unknown',
        readinessDetail: skill.readinessDetail ?? null,
        readinessCheckedAt: skill.readinessCheckedAt ?? null,
        cardState: deriveSkillCardState(skill),
    };
}

/**
 * A re-check that did not land: the switches still win, everything else reads
 * "Couldn't check" (`check_failed`) — never the neutral "Not checked yet" a
 * Skill carries before anything has looked at it.
 */
function stateOrUnknown(skill: Skill): SkillCardState {
    const state = deriveSkillCardState(skill);
    return state === 'disabled' || state === 'needs_review' ? state : 'check_failed';
}

/**
 * FR-10 — when a Skill declares more than 12 tags, the extra ones are not
 * indexed; say which. Added only when something was dropped, so the common
 * response is exactly the Skill as before.
 */
function withTagsDropped<T extends { frontmatter?: { tags?: unknown } }>(skill: T): T {
    const { dropped } = normalizeSkillTags(skill?.frontmatter?.tags);
    if (dropped.length === 0) return skill;
    return Object.assign(skill, { tagsDropped: dropped });
}
