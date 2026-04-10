import { Controller, Get, Param, Query, UseGuards, Request } from '@nestjs/common';
import {
    ApiTags,
    ApiBearerAuth,
    ApiOperation,
    ApiResponse,
    ApiParam,
    ApiQuery,
} from '@nestjs/swagger';
import { AuthSessionGuard } from '../../auth/guards/auth-session.guard';
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
    async checkConnection(@Request() req, @Param('providerId') providerId: string) {
        return this.gitProviderService.checkConnection(req.user.userId, providerId);
    }

    @Get(':providerId/organizations')
    @ApiOperation({ summary: 'Get organizations' })
    @ApiParam({ name: 'providerId', description: 'Git provider ID' })
    @ApiResponse({ status: 200, description: 'List of organizations' })
    async getOrganizations(@Request() req, @Param('providerId') providerId: string) {
        try {
            const organizations = await this.gitProviderService.getOrganizations(
                req.user.userId,
                providerId,
            );
            return { success: true, organizations };
        } catch (error) {
            return {
                success: false,
                organizations: [],
                error: error instanceof Error ? error.message : 'Failed to fetch organizations',
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
        @Request() req,
        @Param('providerId') providerId: string,
        @Query('page') page?: string,
        @Query('perPage') perPage?: string,
    ) {
        try {
            const repositories = await this.gitProviderService.getRepositories(
                req.user.userId,
                providerId,
                page ? parseInt(page, 10) : undefined,
                perPage ? parseInt(perPage, 10) : undefined,
            );
            return { success: true, repositories };
        } catch (error) {
            return {
                success: false,
                repositories: [],
                error: error instanceof Error ? error.message : 'Failed to fetch repositories',
            };
        }
    }

    @Get(':providerId/user')
    @ApiOperation({ summary: 'Get git provider user' })
    @ApiParam({ name: 'providerId', description: 'Git provider ID' })
    @ApiResponse({ status: 200, description: 'User information' })
    async getUser(@Request() req, @Param('providerId') providerId: string) {
        try {
            const user = await this.gitProviderService.getUser(req.user.userId, providerId);
            return { success: true, user };
        } catch (error) {
            return {
                success: false,
                user: null,
                error: error instanceof Error ? error.message : 'Failed to fetch user',
            };
        }
    }
}
