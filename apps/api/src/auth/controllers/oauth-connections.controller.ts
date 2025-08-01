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

@Controller('api/auth/connections')
@UseGuards(JwtAuthGuard)
export class OAuthConnectionsController {
    constructor(private oauthConnectionService: OAuthConnectionService) {}

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
     * Initiate OAuth connection flow for a provider
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
