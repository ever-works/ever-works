import {
    BadRequestException,
    Controller,
    Get,
    Inject,
    Param,
    Query,
    Req,
    Res,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from '../decorators/public.decorator';

// Minimal duck-typed shapes — the platform deliberately doesn't depend on
// `@types/express` (other controllers in apps/api use the same pattern).
type OAuthRequest = {
    ip?: string;
    headers: Record<string, string | string[] | undefined>;
};
type OAuthResponse = {
    getHeader(name: string): string | string[] | number | undefined;
    setHeader(name: string, value: string | string[]): void;
};
import { SocialAuthService } from '../services/social-auth.service';
import { OAuthStateService } from '../services/oauth-state.service';
import { AUTH_PROVIDER } from '../providers/auth-provider.constants';
import { AuthProvider } from '../providers/auth-provider.abstract';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';

@ApiTags('Auth')
@Controller('api/oauth')
export class OAuthController {
    constructor(
        private readonly socialAuthService: SocialAuthService,
        private readonly activityLogService: ActivityLogService,
        private readonly oauthState: OAuthStateService,
        @Inject(AUTH_PROVIDER)
        private readonly authProvider: AuthProvider,
    ) {}

    @Public()
    @Get(':providerId/url')
    @ApiOperation({
        summary: 'Get OAuth URL',
        description: 'Generate an OAuth authorization URL for a supported provider',
    })
    @ApiResponse({
        status: 200,
        description:
            'Returns `{ url, state }`. The OAuth provider redirect_uri points at the ' +
            "web app, NOT this API, so the `ew_oauth_state` cookie set here isn't sent " +
            'on the callback in the normal user flow. The web tier mirrors `state` into ' +
            'its own host-scoped cookie and validates it on the callback. Both layers ' +
            'agree on the same server-minted value.',
    })
    async getAuthUrl(
        @Param('providerId') providerId: string,
        @Res({ passthrough: true }) res: OAuthResponse,
    ) {
        // C-03: mint a server-side state nonce. Set it as an HttpOnly cookie
        // on this origin AND return it in the body so the web tier can mirror
        // it into its own `oauth_state` cookie on its origin. The OAuth
        // provider's `redirect_uri` points at the web app
        // (`${WEB_URL}/api/oauth/:p/callback`), so the cookie set here is
        // never sent on the callback in the normal user flow — the web's
        // cookie carries the CSRF check, and both layers verify against the
        // identical server-minted value.
        const { state, setCookie } = this.oauthState.mint({
            secure: process.env.NODE_ENV === 'production',
        });
        // Append to any existing Set-Cookie headers rather than overwriting.
        const existing = res.getHeader('Set-Cookie');
        if (Array.isArray(existing)) {
            res.setHeader('Set-Cookie', [...existing, setCookie]);
        } else if (typeof existing === 'string') {
            res.setHeader('Set-Cookie', [existing, setCookie]);
        } else {
            res.setHeader('Set-Cookie', setCookie);
        }
        const url = this.socialAuthService.getAuthorizationUrl(providerId, undefined, state);
        return { url, state };
    }

    @Public()
    @Get(':providerId/callback')
    @ApiOperation({
        summary: 'Handle OAuth callback',
        description: 'Exchange an OAuth callback code for an authenticated user session',
    })
    @ApiResponse({ status: 200, description: 'Successfully authenticated' })
    async authRedirect(
        @Param('providerId') providerId: string,
        @Query('code') code: string,
        @Query('state') state: string,
        @Req() req: OAuthRequest,
        @Res({ passthrough: true }) res: OAuthResponse,
    ) {
        // C-03: verify the callback's `state` query param against the
        // browser's `ew_oauth_state` cookie BEFORE we exchange the code.
        // Without this an attacker can complete a victim's OAuth flow.
        const rawCookieHeader = req.headers.cookie;
        const cookieHeader = Array.isArray(rawCookieHeader) ? rawCookieHeader[0] : rawCookieHeader;
        const stateResult = this.oauthState.verify({
            cookieHeader,
            stateQuery: typeof state === 'string' ? state : undefined,
            secure: process.env.NODE_ENV === 'production',
        });
        // Clear the cookie regardless of outcome (single-use).
        res.setHeader('Set-Cookie', stateResult.clearCookie);
        if (!stateResult.valid) {
            throw new BadRequestException(`OAuth state verification failed: ${stateResult.reason}`);
        }

        const userAgentHeader = req.headers['user-agent'];
        const userAgent: string | null =
            typeof userAgentHeader === 'string' ? userAgentHeader : null;
        const xForwardedFor = req.headers['x-forwarded-for'];
        const ipAddress: string | null =
            (typeof req.ip === 'string' && req.ip) ||
            (typeof xForwardedFor === 'string'
                ? xForwardedFor.split(',')[0].trim()
                : Array.isArray(xForwardedFor) && typeof xForwardedFor[0] === 'string'
                  ? xForwardedFor[0]
                  : null);
        const user = await this.socialAuthService.authenticate(providerId, code);
        // H-04: bind the OAuth-issued session to the requesting client.
        const result = await this.authProvider.issueSession(user.id, {
            ipAddress: typeof ipAddress === 'string' ? ipAddress : null,
            userAgent: typeof userAgent === 'string' ? userAgent : null,
        });

        this.activityLogService
            .log({
                userId: user.id,
                actionType: ActivityActionType.USER_LOGIN,
                action: `user.login.${providerId}`,
                status: ActivityStatus.COMPLETED,
                summary: `Signed in via ${this.socialAuthService.getProviderDisplayName(providerId)}`,
                ipAddress,
                userAgent,
                metadata: {
                    provider: providerId,
                },
            })
            .catch(() => {});

        return result;
    }
}
