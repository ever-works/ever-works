import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
    SkillRepository,
    SkillsService,
    type ListSkillsFilter,
    type SkillBindingTargetType,
    type SkillOwnerType,
} from '@ever-works/agent/skills';
import { SkillsFacadeService } from '@ever-works/agent/facades';
import type { SkillCatalogEntry, SkillCatalogListResult } from '@ever-works/plugin';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';

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
    ) {}

    @Get('catalog')
    @ApiOperation({
        summary: 'List catalog skills (union across enabled skills-provider plugins).',
    })
    @HttpCode(HttpStatus.OK)
    async catalog(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
        @Query('search') search?: string,
        @Query('tags') tagsCsv?: string,
    ): Promise<SkillCatalogListResult> {
        const lim = limit ? Math.min(200, Math.max(1, parseInt(limit, 10) || 50)) : 50;
        const off = offset ? Math.max(0, parseInt(offset, 10) || 0) : 0;
        const tags = tagsCsv
            ? tagsCsv
                  .split(',')
                  .map((t) => t.trim())
                  .filter(Boolean)
            : undefined;
        return this.facade.listEntries(
            { limit: lim, offset: off, search, tags },
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
    @ApiOperation({ summary: 'List my installed Skills (filterable by ownerType / search).' })
    @HttpCode(HttpStatus.OK)
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query('ownerType') ownerType?: string,
        @Query('ownerId') ownerId?: string,
        @Query('search') search?: string,
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
    ) {
        const filter: ListSkillsFilter = {
            ownerType: this.parseOwnerType(ownerType),
            ownerId,
            search,
            limit: limit ? Math.min(200, Math.max(1, parseInt(limit, 10) || 50)) : 50,
            offset: offset ? Math.max(0, parseInt(offset, 10) || 0) : 0,
        };
        const { rows, total } = await this.skills.findByUserIdFiltered(auth.userId, filter);
        return { data: rows, meta: { total, limit: filter.limit, offset: filter.offset } };
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

    private parseOwnerType(value?: string): SkillOwnerType | undefined {
        if (!value) return undefined;
        if (['tenant', 'mission', 'idea', 'work', 'agent'].includes(value)) {
            return value as SkillOwnerType;
        }
        throw new BadRequestException(`Invalid ownerType "${value}".`);
    }

    // ── Phase 9 — write paths ────────────────────────────────────

    @Post()
    @ApiOperation({ summary: 'Create a custom Skill.' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Body()
        body: {
            ownerType: SkillOwnerType;
            ownerId: string;
            title: string;
            description: string;
            instructionsMd: string;
            frontmatter?: Record<string, unknown>;
            slug?: string;
            version?: string;
        },
    ) {
        const ownerType = this.parseOwnerType(body.ownerType);
        if (!ownerType) throw new BadRequestException('ownerType is required.');
        if (!body.ownerId) throw new BadRequestException('ownerId is required.');
        if (!body.title || !body.description || typeof body.instructionsMd !== 'string') {
            throw new BadRequestException('title, description, and instructionsMd are required.');
        }
        return this.service.create(auth.userId, {
            ownerType,
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
        });
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update Skill body / frontmatter.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 60, ttl: 60_000 } })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body()
        body: {
            title?: string;
            description?: string;
            instructionsMd?: string;
            frontmatter?: Record<string, unknown>;
            version?: string;
        },
    ) {
        return this.service.update(auth.userId, id, {
            title: body.title,
            description: body.description,
            instructionsMd: body.instructionsMd,
            frontmatter: body.frontmatter as any,
            version: body.version,
        });
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete a Skill (cascades to bindings).' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
    async remove(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ deleted: true }> {
        return this.service.remove(auth.userId, id);
    }

    @Post('install')
    @ApiOperation({ summary: 'Install a catalog skill at the requested scope.' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ default: { limit: 60, ttl: 60_000 } })
    async install(
        @CurrentUser() auth: AuthenticatedUser,
        @Body()
        body: { slug: string; ownerType: SkillOwnerType; ownerId: string },
    ) {
        const ownerType = this.parseOwnerType(body.ownerType);
        if (!ownerType) throw new BadRequestException('ownerType is required.');
        if (!body.ownerId) throw new BadRequestException('ownerId is required.');

        const found = await this.facade.getEntry(body.slug, { userId: auth.userId });
        if (!found) throw new NotFoundException(`Catalog skill "${body.slug}" not found.`);

        return this.service.installFromCatalog(auth.userId, {
            catalogProviderId: found.providerId,
            catalogSlug: body.slug,
            ownerType,
            ownerId: body.ownerId,
            entry: found.entry,
        });
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
    @Throttle({ default: { limit: 60, ttl: 60_000 } })
    async createBinding(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body()
        body: {
            targetType: SkillBindingTargetType;
            targetId?: string | null;
            priority?: number;
            injectIntoAgent?: boolean;
            injectIntoGenerator?: boolean;
        },
    ) {
        if (!['agent', 'work', 'mission', 'idea', 'tenant'].includes(body.targetType)) {
            throw new BadRequestException(`Invalid targetType "${body.targetType}".`);
        }
        return this.service.createBinding(auth.userId, {
            skillId: id,
            targetType: body.targetType,
            targetId: body.targetId,
            priority: body.priority,
            injectIntoAgent: body.injectIntoAgent,
            injectIntoGenerator: body.injectIntoGenerator,
        });
    }
}
