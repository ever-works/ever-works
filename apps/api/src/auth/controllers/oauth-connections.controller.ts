import {
    Controller,
    Get,
    Post,
    Delete,
    UseGuards,
    Request,
    Param,
    Query,
    Body,
    HttpCode,
    HttpStatus,
    BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { OAuthConnectionService } from '../services/oauth-connection.service';
import { OAuthUrlService } from '../services/oauth-url.service';
import { AuthProviders, config } from '../../config/constants';

@Controller('api/auth/connections')
@UseGuards(JwtAuthGuard)
export class OAuthConnectionsController {
    constructor(
        private oauthConnectionService: OAuthConnectionService,
        private oauthUrlService: OAuthUrlService,
    ) {}

    /**
     * Get all connected OAuth accounts for the current user
     */
    @Get()
    async getConnections(@Request() req): Promise<any> {
        return this.oauthConnectionService.getUserConnections(req.user.userId);
    }

    /**
     * Check if user has a specific provider connected
     */
    @Get(':provider')
    async checkConnection(@Request() req, @Param('provider') provider: string): Promise<any> {
        return this.oauthConnectionService.checkConnection(req.user.userId, provider);
    }

    /**
     * Get OAuth URL for connecting a provider (returns JSON)
     */
    @Get(':provider/connect/url')
    async getConnectUrl(
        @Request() req,
        @Param('provider') provider: AuthProviders,
        @Query('callbackUrl') callbackUrl?: string,
        @Query('state') state?: string,
    ) {
        // Generate state if not provided for CSRF protection
        const finalState = state || this.oauthConnectionService.generateState(req.user.userId);

        let url: string;
        switch (provider.toLowerCase() as AuthProviders) {
            case 'github':
                // Use connect callback URL for connections
                const githubCallbackUrl = callbackUrl || config.github.connectCallbackUrl();
                url = this.oauthUrlService.generateGitHubAuthUrl(githubCallbackUrl, finalState);
                break;

            case 'google':
                // For now, use same callback pattern for Google connections
                const googleCallbackUrl = callbackUrl || config.google.connectCallbackUrl();
                url = this.oauthUrlService.generateGoogleAuthUrl(googleCallbackUrl, finalState);
                break;
            default:
                throw new BadRequestException(`Unsupported provider: ${provider}`);
        }

        return { url, state: finalState };
    }

    /**
     * Initiate OAuth connection flow for a provider (redirect approach)
     * Used when user wants to connect an additional OAuth provider
     */
    @Get(':provider/connect')
    @UseGuards(AuthGuard('github-connect'))
    async connectProvider(
        @Request() req,
        @Param('provider') provider: string,
        @Query('scopes') scopes?: string,
    ) {
        // The guard will handle the OAuth flow
        // This endpoint is reached after successful OAuth callback
    }

    /**
     * OAuth callback for connecting additional providers
     */
    @Get(':provider/callback')
    async connectCallback(
        @Request() req,
        @Param('provider') provider: string,
        @Query('code') code: string,
        @Query('state') state?: string,
    ): Promise<any> {
        if (!code) {
            throw new BadRequestException('Authorization code is required');
        }

        // Verify state parameter to prevent CSRF
        if (state && !this.oauthConnectionService.verifyState(state, req.user.userId)) {
            throw new BadRequestException('Invalid state parameter');
        }

        return this.oauthConnectionService.handleConnectionCallback(
            req.user.userId,
            provider,
            code,
        );
    }

    /**
     * Request additional scopes for an existing connection
     */
    @Post(':provider/request-scopes')
    async requestAdditionalScopes(
        @Request() req,
        @Param('provider') provider: string,
        @Body() body: { scopes: string[] },
    ) {
        return this.oauthConnectionService.requestAdditionalScopes(
            req.user.userId,
            provider,
            body.scopes,
        );
    }

    /**
     * Disconnect an OAuth provider
     */
    @Delete(':provider')
    @HttpCode(HttpStatus.NO_CONTENT)
    async disconnectProvider(@Request() req, @Param('provider') provider: string) {
        await this.oauthConnectionService.disconnectProvider(req.user.userId, provider);
    }

    /**
     * Get GitHub repositories accessible with current permissions
     */
    @Get('github/repositories')
    async getGitHubRepositories(@Request() req): Promise<any> {
        return this.oauthConnectionService.getGitHubRepositories(req.user.userId);
    }

    /**
     * Check if user has required GitHub scopes
     */
    @Get('github/check-scopes')
    async checkGitHubScopes(@Request() req, @Query('required') requiredScopes: string) {
        const scopes = requiredScopes ? requiredScopes.split(',') : [];
        return this.oauthConnectionService.checkGitHubScopes(req.user.userId, scopes);
    }
}
