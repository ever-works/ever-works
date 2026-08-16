import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Put,
    Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RepoRegistryService } from '@ever-works/agent/services';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import {
    CreateRepoConnectionDto,
    ListRepoConnectionsQueryDto,
    SetRepoConnectionEnvFilesDto,
    UpdateRepoConnectionDto,
} from './dto/repo-connection.dto';

/**
 * Repository registry (Feature G).
 *
 *   GET    /api/repo-connections                       list (?includeDerived=true
 *                                                      appends computed Work entries)
 *   POST   /api/repo-connections                       create
 *   GET    /api/repo-connections/:id                   one (env files masked)
 *   PATCH  /api/repo-connections/:id                   partial update
 *   DELETE /api/repo-connections/:id                   delete
 *   GET    /api/repo-connections/:id/env-files         FULL env-file contents
 *                                                      (owner-gated reveal)
 *   PUT    /api/repo-connections/:id/env-files         replace the env-file set
 *   POST   /api/repo-connections/import/github-app/:installationRepoId
 *                                                      one-click import
 *
 * Env-file MASKING: every list/get response carries paths + sizes only;
 * contents leave the API exclusively via the explicit env-files GET.
 * Cross-user rows read as 404, never 403.
 */
@ApiTags('repo-connections')
@Controller('api/repo-connections')
export class RepoConnectionsController {
    constructor(private readonly registry: RepoRegistryService) {}

    @Get()
    @ApiOperation({ summary: 'List registry repositories (optionally with Work-derived entries).' })
    @HttpCode(HttpStatus.OK)
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: ListRepoConnectionsQueryDto,
    ) {
        return this.registry.list(auth.userId, { includeDerived: query.includeDerived === true });
    }

    @Post()
    @ApiOperation({ summary: 'Create a registry repository.' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async create(@CurrentUser() auth: AuthenticatedUser, @Body() dto: CreateRepoConnectionDto) {
        return this.registry.create(auth.userId, dto);
    }

    @Post('import/github-app/:installationRepoId')
    @ApiOperation({ summary: 'Import a GitHub App installation repository into the registry.' })
    @HttpCode(HttpStatus.CREATED)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async importFromGithubApp(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('installationRepoId', ParseUUIDPipe) installationRepoId: string,
    ) {
        return this.registry.importFromGithubApp(auth.userId, installationRepoId);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get one registry repository (env files masked).' })
    @HttpCode(HttpStatus.OK)
    async get(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        return this.registry.get(auth.userId, id);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update a registry repository.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 120, ttl: 60_000 } })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: UpdateRepoConnectionDto,
    ) {
        return this.registry.update(auth.userId, id, dto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete a registry repository (detaches every agent).' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async remove(@CurrentUser() auth: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
        return this.registry.remove(auth.userId, id);
    }

    @Get(':id/env-files')
    @ApiOperation({ summary: 'Reveal FULL env-file contents (owner only).' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async getEnvFiles(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ) {
        return this.registry.getEnvFiles(auth.userId, id);
    }

    @Put(':id/env-files')
    @ApiOperation({ summary: 'Replace the env-file set ("Save All").' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    async setEnvFiles(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: SetRepoConnectionEnvFilesDto,
    ) {
        return this.registry.setEnvFiles(auth.userId, id, dto.files);
    }
}
