import {
	BadRequestException,
	Controller,
	Get,
	HttpCode,
	HttpStatus,
	NotFoundException,
	Param,
	ParseUUIDPipe,
	Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
	SkillRepository,
	type ListSkillsFilter,
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
	) {}

	@Get('catalog')
	@ApiOperation({ summary: 'List catalog skills (union across enabled skills-provider plugins).' })
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
	async getOne(
		@CurrentUser() auth: AuthenticatedUser,
		@Param('id', ParseUUIDPipe) id: string,
	) {
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
}
