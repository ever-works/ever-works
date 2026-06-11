import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
    ApiTags,
    ApiBearerAuth,
    ApiOperation,
    ApiResponse,
    ApiParam,
    ApiQuery,
} from '@nestjs/swagger';
import { AuthSessionGuard } from '../../auth/guards/auth-session.guard';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import { AuthenticatedUser } from '../../auth/types/auth.types';
import { GitProviderService } from './git-provider.service';

@ApiTags('Git Providers')
@ApiBearerAuth('JWT-auth')
@Controller('api/git-providers')
@UseGuards(AuthSessionGuard)
export class GitProviderController {
    constructor(private readonly gitProviderService: GitProviderService) {}

    @Get()
    @ApiOperation({ summary: 'List available git providers' })
    @ApiResponse({ status: 200, description: 'List of git providers' })
    async listProviders() {
        const providers = this.gitProviderService.getAvailableProviders();
        const isConfigured = this.gitProviderService.isConfigured();
        return { configured: isConfigured, providers };
    }

    @Get(':providerId/connection')
    @ApiOperation({ summary: 'Check git provider connection' })
    @ApiParam({ name: 'providerId', description: 'Git provider ID (e.g., github, gitlab)' })
    @ApiResponse({ status: 200, description: 'Connection status' })
    async checkConnection(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('providerId') providerId: string,
    ) {
        return this.gitProviderService.checkConnection(auth.userId, providerId);
    }

    @Get(':providerId/organizations')
    @ApiOperation({ summary: 'Get organizations' })
    @ApiParam({ name: 'providerId', description: 'Git provider ID' })
    @ApiResponse({ status: 200, description: 'List of organizations' })
    async getOrganizations(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('providerId') providerId: string,
    ) {
        try {
            const organizations = await this.gitProviderService.getOrganizations(
                auth.userId,
                providerId,
            );
            return { success: true, organizations };
        } catch {
            return {
                success: false,
                organizations: [],
                error: 'Failed to fetch organizations',
            };
        }
    }

    @Get(':providerId/repositories')
    @ApiOperation({ summary: 'Get repositories' })
    @ApiParam({ name: 'providerId', description: 'Git provider ID' })
    @ApiQuery({ name: 'page', required: false })
    @ApiQuery({ name: 'perPage', required: false })
    @ApiResponse({ status: 200, description: 'List of repositories' })
    async getRepositories(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('providerId') providerId: string,
        @Query('page') page?: string,
        @Query('perPage') perPage?: string,
    ) {
        try {
            const repositories = await this.gitProviderService.getRepositories(
                auth.userId,
                providerId,
                page ? parseInt(page, 10) : undefined,
                perPage ? Math.min(parseInt(perPage, 10), 100) : undefined,
            );
            return { success: true, repositories };
        } catch {
            return {
                success: false,
                repositories: [],
                error: 'Failed to fetch repositories',
            };
        }
    }

    @Get(':providerId/user')
    @ApiOperation({ summary: 'Get git provider user' })
    @ApiParam({ name: 'providerId', description: 'Git provider ID' })
    @ApiResponse({ status: 200, description: 'User information' })
    async getUser(@CurrentUser() auth: AuthenticatedUser, @Param('providerId') providerId: string) {
        try {
            const user = await this.gitProviderService.getUser(auth.userId, providerId);
            return { success: true, user };
        } catch {
            return {
                success: false,
                user: null,
                error: 'Failed to fetch user',
            };
        }
    }
}
