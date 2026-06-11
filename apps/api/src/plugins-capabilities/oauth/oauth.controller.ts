import {
    Controller,
    Get,
    Delete,
    Param,
    Query,
    UseGuards,
    Request,
    Res,
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
import { OAuthStateService } from '../../auth/services/oauth-state.service';
import { OAuthService } from './oauth.service';

// Minimal duck-typed shapes — the platform deliberately doesn't depend on
// `@types/express` (same pattern as auth/controllers/oauth.controller.ts).
type OAuthCallbackRequest = {
    user: { userId: string };
    headers: Record<string, string | string[] | undefined>;
};
type OAuthResponseLike = {
    getHeader(name: string): string | string[] | number | undefined;
    setHeader(name: string, value: string | string[]): void;
};

@ApiTags('OAuth')
@ApiBearerAuth('JWT-auth')
@Controller('api/oauth')
@UseGuards(AuthSessionGuard)
export class OAuthController {
    constructor(
        private readonly oauthService: OAuthService,
        // EW-722 #20: same server-minted `state` + HttpOnly-cookie CSRF
        // binding the auth login flow uses (C-03). AuthModule exports it.
        private readonly oauthState: OAuthStateService,
    ) {}

    /** Append a Set-Cookie value without clobbering ones already queued. */
    private appendSetCookie(res: OAuthResponseLike, cookie: string): void {
        const existing = res.getHeader('Set-Cookie');
        if (Array.isArray(existing)) {
            res.setHeader('Set-Cookie', [...existing.map(String), cookie]);
        } else if (typeof existing === 'string') {
            res.setHeader('Set-Cookie', [existing, cookie]);
        } else {
            res.setHeader('Set-Cookie', cookie);
        }
    }

    /**
     * EW-722 #20: verify the callback's `state` query param against the
     * `ew_oauth_state` cookie BEFORE any credential lookup or code
     * exchange. Without this an attacker could complete a victim's plugin
     * OAuth flow and link an attacker-controlled provider account
     * (arbitrary code-to-account linkage). The cookie is cleared
     * regardless of outcome (single-use). Server-to-server callers (the
     * web callback routes) synthesize the cookie from the same value they
     * already validated against their own host-scoped cookie.
     */
    private verifyOAuthStateOrThrow(
        req: OAuthCallbackRequest,
        res: OAuthResponseLike,
        state?: string,
    ): void {
        const rawCookieHeader = req.headers.cookie;
        const cookieHeader = Array.isArray(rawCookieHeader) ? rawCookieHeader[0] : rawCookieHeader;
        const result = this.oauthState.verify({
            cookieHeader,
            stateQuery: typeof state === 'string' ? state : undefined,
            secure: process.env.NODE_ENV === 'production',
        });
        this.appendSetCookie(res, result.clearCookie);
        if (!result.valid) {
            throw new BadRequestException(`OAuth state verification failed: ${result.reason}`);
        }
    }

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
    @ApiQuery({ name: 'forceConsent', required: false })
    @ApiResponse({ status: 200, description: 'OAuth authorization URL' })
    async getConnectUrl(
        @Request() req,
        @Param('providerId') providerId: string,
        @Res({ passthrough: true }) res: OAuthResponseLike,
        @Query('callbackUrl') callbackUrl?: string,
        @Query('forceConsent') forceConsent?: string,
    ) {
        // EW-722 #20: server-mint the OAuth `state` and bind it to the
        // browser via an HttpOnly cookie. The minted value (never a
        // client-supplied `?state=`, which is now ignored) is embedded in
        // the authorize URL AND returned in the body so the web tier can
        // mirror it into its own host-scoped cookie — the same
        // dual-channel contract the auth login flow uses (C-03). Minting
        // before the credential lookup is harmless: the unconfigured-
        // provider 400 contract below is unchanged.
        const { state, setCookie } = this.oauthState.mint({
            secure: process.env.NODE_ENV === 'production',
        });
        this.appendSetCookie(res, setCookie);
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
    @ApiQuery({ name: 'state', required: true })
    @ApiResponse({ status: 200, description: 'Provider connected successfully' })
    async handleOAuthCallback(
        @Request() req,
        @Param('providerId') providerId: string,
        @Res({ passthrough: true }) res: OAuthResponseLike,
        @Query('code') code: string,
        @Query('state') state?: string,
    ) {
        if (!code) {
            throw new BadRequestException('Authorization code is required');
        }
        // EW-722 #20: state verification runs AFTER the code-presence
        // check (the e2e suite pins 'Authorization code is required' as
        // the first gate) and BEFORE any credential lookup/code exchange.
        this.verifyOAuthStateOrThrow(req, res, state);
        return this.oauthService.handleOAuthCallback(req.user.userId, providerId, code);
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
    @ApiQuery({ name: 'forceConsent', required: false })
    @ApiResponse({ status: 200, description: 'OAuth authorization URL' })
    async getReadPackagesConnectUrl(
        @Request() req,
        @Param('providerId') providerId: string,
        @Res({ passthrough: true }) res: OAuthResponseLike,
        @Query('callbackUrl') callbackUrl?: string,
        @Query('forceConsent') forceConsent?: string,
    ) {
        // EW-722 #20: same server-minted state + cookie binding as
        // `getConnectUrl` — see the comment there.
        const { state, setCookie } = this.oauthState.mint({
            secure: process.env.NODE_ENV === 'production',
        });
        this.appendSetCookie(res, setCookie);
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
    @ApiQuery({ name: 'state', required: true })
    @ApiResponse({ status: 200, description: 'Read-packages PAT saved' })
    async handleReadPackagesOAuthCallback(
        @Request() req,
        @Param('providerId') providerId: string,
        @Res({ passthrough: true }) res: OAuthResponseLike,
        @Query('code') code: string,
        @Query('state') state?: string,
    ) {
        if (!code) {
            throw new BadRequestException('Authorization code is required');
        }
        // EW-722 #20: code-presence gate first (e2e-pinned), then state.
        this.verifyOAuthStateOrThrow(req, res, state);
        return this.oauthService.handleReadPackagesOAuthCallback(req.user.userId, providerId, code);
    }
}
