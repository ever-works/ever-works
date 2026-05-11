import {
    Controller,
    Get,
    Delete,
    Param,
    Query,
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
import { AuthSessionGuard } from '../../auth/guards/auth-session.guard';
import { OAuthService } from './oauth.service';

@ApiTags('OAuth')
@ApiBearerAuth('JWT-auth')
@Controller('api/oauth')
@UseGuards(AuthSessionGuard)
export class OAuthController {
    constructor(private readonly oauthService: OAuthService) {}

    @Get('providers')
    @ApiOperation({ summary: 'List available OAuth providers' })
    @ApiResponse({ status: 200, description: 'List of OAuth providers' })
    async listProviders() {
        const providers = this.oauthService.getAvailableProviders();
        const isConfigured = this.oauthService.isConfigured();
        return { configured: isConfigured, providers };
    }

    @Get(':providerId/connection')
    @ApiOperation({ summary: 'Check OAuth provider connection status' })
    @ApiParam({ name: 'providerId', description: 'OAuth provider ID' })
    @ApiResponse({ status: 200, description: 'Connection status' })
    async checkConnection(@Request() req, @Param('providerId') providerId: string) {
        return this.oauthService.checkConnection(req.user.userId, providerId);
    }

    @Get(':providerId/connect/url')
    @ApiOperation({ summary: 'Get OAuth authorization URL' })
    @ApiParam({ name: 'providerId', description: 'OAuth provider ID' })
    @ApiQuery({ name: 'callbackUrl', required: false })
    @ApiQuery({ name: 'state', required: false })
    @ApiQuery({ name: 'forceConsent', required: false })
    @ApiResponse({ status: 200, description: 'OAuth authorization URL' })
    async getConnectUrl(
        @Request() req,
        @Param('providerId') providerId: string,
        @Query('callbackUrl') callbackUrl?: string,
        @Query('state') state?: string,
        @Query('forceConsent') forceConsent?: string,
    ) {
        try {
            return await this.oauthService.getOAuthUrl({
                userId: req.user.userId,
                redirectUri: callbackUrl || '',
                forceConsent: forceConsent === 'true',
                providerId,
                state,
            });
        } catch (error) {
            throw new BadRequestException(
                error instanceof Error ? error.message : 'Failed to get OAuth URL',
            );
        }
    }

    @Get(':providerId/callback/plugins')
    @ApiOperation({ summary: 'OAuth callback handler' })
    @ApiParam({ name: 'providerId', description: 'OAuth provider ID' })
    @ApiQuery({ name: 'code', required: true })
    @ApiQuery({ name: 'state', required: false })
    @ApiResponse({ status: 200, description: 'Provider connected successfully' })
    async handleOAuthCallback(
        @Request() req,
        @Param('providerId') providerId: string,
        @Query('code') code: string,
        @Query('state') state?: string,
    ) {
        if (!code) {
            throw new BadRequestException('Authorization code is required');
        }
        return this.oauthService.handleOAuthCallback(req.user.userId, providerId, code, state);
    }

    @Get(':providerId/user')
    @ApiOperation({ summary: 'Get OAuth provider user info' })
    @ApiParam({ name: 'providerId', description: 'OAuth provider ID' })
    @ApiResponse({ status: 200, description: 'User information' })
    async getUser(@Request() req, @Param('providerId') providerId: string) {
        try {
            const user = await this.oauthService.getUser(req.user.userId, providerId);
            return { success: true, user };
        } catch (error) {
            return {
                success: false,
                user: null,
                error: error instanceof Error ? error.message : 'Failed to fetch user',
            };
        }
    }

    @Delete(':providerId')
    @ApiOperation({ summary: 'Disconnect OAuth provider' })
    @ApiParam({ name: 'providerId', description: 'OAuth provider ID' })
    @ApiResponse({ status: 204, description: 'Provider disconnected' })
    @HttpCode(HttpStatus.NO_CONTENT)
    async disconnectProvider(@Request() req, @Param('providerId') providerId: string) {
        await this.oauthService.disconnectProvider(req.user.userId, providerId);
    }

    @Get(':providerId/read-packages/connect/url')
    @ApiOperation({
        summary: 'Get OAuth authorization URL for read:packages + write:packages',
        description:
            'Variant of `connect/url` that requests `read:packages` + `write:packages` scopes. The resulting token is stored on the plugin settings under `readPackagesPat` instead of replacing the main OAuth connection.',
    })
    @ApiParam({ name: 'providerId', description: 'OAuth provider ID' })
    @ApiQuery({ name: 'callbackUrl', required: false })
    @ApiQuery({ name: 'state', required: false })
    @ApiQuery({ name: 'forceConsent', required: false })
    @ApiResponse({ status: 200, description: 'OAuth authorization URL' })
    async getReadPackagesConnectUrl(
        @Request() req,
        @Param('providerId') providerId: string,
        @Query('callbackUrl') callbackUrl?: string,
        @Query('state') state?: string,
        @Query('forceConsent') forceConsent?: string,
    ) {
        try {
            return await this.oauthService.getReadPackagesOAuthUrl({
                userId: req.user.userId,
                redirectUri: callbackUrl || '',
                forceConsent: forceConsent === 'true',
                providerId,
                state,
            });
        } catch (error) {
            throw new BadRequestException(
                error instanceof Error ? error.message : 'Failed to get OAuth URL',
            );
        }
    }

    @Get(':providerId/callback/plugins/read-packages')
    @ApiOperation({
        summary: 'OAuth callback handler for the read-packages flow',
        description:
            "Receives the GitHub OAuth callback for the read-packages variant. Exchanges the code for a token and writes it to the user's plugin settings under `readPackagesPat` (used by the Kubernetes deploy provider as an imagePullSecret password for private GHCR images). Does NOT touch the main OAuth connection.",
    })
    @ApiParam({ name: 'providerId', description: 'OAuth provider ID' })
    @ApiQuery({ name: 'code', required: true })
    @ApiQuery({ name: 'state', required: false })
    @ApiResponse({ status: 200, description: 'Read-packages PAT saved' })
    async handleReadPackagesOAuthCallback(
        @Request() req,
        @Param('providerId') providerId: string,
        @Query('code') code: string,
        @Query('state') state?: string,
    ) {
        if (!code) {
            throw new BadRequestException('Authorization code is required');
        }
        return this.oauthService.handleReadPackagesOAuthCallback(
            req.user.userId,
            providerId,
            code,
            state,
        );
    }
}
