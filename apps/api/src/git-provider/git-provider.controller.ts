import {
    Controller,
    Get,
    Post,
    Delete,
    Param,
    Query,
    Body,
    UseGuards,
    Request,
    BadRequestException,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import {
    ApiTags,
    ApiBearerAuth,
    ApiOperation,
    ApiResponse,
    ApiParam,
    ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GitProviderService } from './git-provider.service';

@ApiTags('Git Providers')
@ApiBearerAuth('JWT-auth')
@Controller('api/git-providers')
@UseGuards(JwtAuthGuard)
export class GitProviderController {
    constructor(private readonly gitProviderService: GitProviderService) {}

    /**
     * Get list of available git providers
     */
    @Get()
    @ApiOperation({
        summary: 'List available git providers',
        description: 'Get all git providers available in the system',
    })
    @ApiResponse({
        status: 200,
        description: 'List of git providers',
    })
    async listProviders() {
        const providers = this.gitProviderService.getAvailableProviders();
        const isConfigured = this.gitProviderService.isConfigured();

        return {
            configured: isConfigured,
            providers,
        };
    }

    /**
     * Check connection status for a git provider
     */
    @Get(':providerId/connection')
    @ApiOperation({
        summary: 'Check git provider connection',
        description: 'Check if the user is connected to a specific git provider',
    })
    @ApiParam({
        name: 'providerId',
        description: 'Git provider ID (e.g., github, gitlab)',
    })
    @ApiResponse({
        status: 200,
        description: 'Connection status',
    })
    async checkConnection(@Request() req, @Param('providerId') providerId: string) {
        return this.gitProviderService.checkConnection(req.user.userId, providerId);
    }

    /**
     * Get organizations for a git provider
     */
    @Get(':providerId/organizations')
    @ApiOperation({
        summary: 'Get organizations',
        description: 'Get organizations accessible by the user for a specific git provider',
    })
    @ApiParam({
        name: 'providerId',
        description: 'Git provider ID (e.g., github, gitlab)',
    })
    @ApiResponse({
        status: 200,
        description: 'List of organizations',
    })
    async getOrganizations(@Request() req, @Param('providerId') providerId: string) {
        try {
            const organizations = await this.gitProviderService.getOrganizations(
                req.user.userId,
                providerId,
            );

            return {
                success: true,
                organizations,
            };
        } catch (error) {
            return {
                success: false,
                organizations: [],
                error: error instanceof Error ? error.message : 'Failed to fetch organizations',
            };
        }
    }

    /**
     * Get repositories for a git provider
     */
    @Get(':providerId/repositories')
    @ApiOperation({
        summary: 'Get repositories',
        description: 'Get repositories accessible by the user for a specific git provider',
    })
    @ApiParam({
        name: 'providerId',
        description: 'Git provider ID (e.g., github, gitlab)',
    })
    @ApiQuery({
        name: 'page',
        required: false,
        description: 'Page number',
    })
    @ApiQuery({
        name: 'perPage',
        required: false,
        description: 'Items per page',
    })
    @ApiResponse({
        status: 200,
        description: 'List of repositories',
    })
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

            return {
                success: true,
                repositories,
            };
        } catch (error) {
            return {
                success: false,
                repositories: [],
                error: error instanceof Error ? error.message : 'Failed to fetch repositories',
            };
        }
    }

    /**
     * Get user info from a git provider
     */
    @Get(':providerId/user')
    @ApiOperation({
        summary: 'Get git provider user',
        description: 'Get user information from a specific git provider',
    })
    @ApiParam({
        name: 'providerId',
        description: 'Git provider ID (e.g., github, gitlab)',
    })
    @ApiResponse({
        status: 200,
        description: 'User information',
    })
    async getUser(@Request() req, @Param('providerId') providerId: string) {
        try {
            const user = await this.gitProviderService.getUser(req.user.userId, providerId);

            return {
                success: true,
                user,
            };
        } catch (error) {
            return {
                success: false,
                user: null,
                error: error instanceof Error ? error.message : 'Failed to fetch user',
            };
        }
    }

    /**
     * Get OAuth connect URL for a git provider
     */
    @Get(':providerId/connect/url')
    @ApiOperation({
        summary: 'Get OAuth connect URL',
        description: 'Get OAuth URL for connecting to a git provider',
    })
    @ApiParam({
        name: 'providerId',
        description: 'Git provider ID (e.g., github, gitlab)',
    })
    @ApiQuery({
        name: 'callbackUrl',
        required: false,
        description: 'OAuth callback URL',
    })
    @ApiQuery({
        name: 'state',
        required: false,
        description: 'OAuth state parameter',
    })
    @ApiQuery({
        name: 'forceConsent',
        required: false,
        description: 'Force re-consent for OAuth',
    })
    @ApiResponse({
        status: 200,
        description: 'OAuth authorization URL',
    })
    async getConnectUrl(
        @Request() req,
        @Param('providerId') providerId: string,
        @Query('callbackUrl') callbackUrl?: string,
        @Query('state') state?: string,
        @Query('forceConsent') forceConsent?: string,
    ) {
        try {
            // Get OAuth URL via the git provider service (uses plugin system)
            return await this.gitProviderService.getOAuthUrl(
                req.user.userId,
                providerId,
                callbackUrl || '',
                state,
            );
        } catch (error) {
            throw new BadRequestException(
                error instanceof Error ? error.message : 'Failed to get OAuth URL',
            );
        }
    }

    /**
     * OAuth callback for git providers
     */
    @Get(':providerId/callback')
    @ApiOperation({
        summary: 'OAuth callback for git providers',
        description: 'Handle OAuth callback and store the access token',
    })
    @ApiParam({
        name: 'providerId',
        description: 'Git provider ID (e.g., github, gitlab)',
    })
    @ApiQuery({
        name: 'code',
        required: true,
        description: 'OAuth authorization code',
    })
    @ApiQuery({
        name: 'state',
        required: false,
        description: 'OAuth state parameter',
    })
    @ApiResponse({
        status: 200,
        description: 'Provider connected successfully',
    })
    async handleOAuthCallback(
        @Request() req,
        @Param('providerId') providerId: string,
        @Query('code') code: string,
        @Query('state') state?: string,
    ) {
        if (!code) {
            throw new BadRequestException('Authorization code is required');
        }

        return this.gitProviderService.handleOAuthCallback(
            req.user.userId,
            providerId,
            code,
            state,
        );
    }

    /**
     * Disconnect a git provider
     */
    @Delete(':providerId')
    @ApiOperation({
        summary: 'Disconnect git provider',
        description: 'Disconnect from a git provider and revoke stored tokens',
    })
    @ApiParam({
        name: 'providerId',
        description: 'Git provider ID (e.g., github, gitlab)',
    })
    @ApiResponse({
        status: 204,
        description: 'Provider disconnected successfully',
    })
    @HttpCode(HttpStatus.NO_CONTENT)
    async disconnectProvider(@Request() req, @Param('providerId') providerId: string) {
        await this.gitProviderService.disconnectProvider(req.user.userId, providerId);
    }
}
