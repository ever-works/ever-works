import { Controller, Get, Inject, Param, Query, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { Public } from '../decorators/public.decorator';
import { SocialAuthService } from '../services/social-auth.service';
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
        @Inject(AUTH_PROVIDER)
        private readonly authProvider: AuthProvider,
    ) {}

    @Public()
    @Get(':providerId/url')
    @ApiOperation({
        summary: 'Get OAuth URL',
        description: 'Generate an OAuth authorization URL for a supported provider',
    })
    @ApiQuery({
        name: 'callbackUrl',
        required: false,
        description: 'URL to redirect after authentication',
    })
    @ApiQuery({ name: 'state', required: false, description: 'Optional state parameter' })
    @ApiResponse({ status: 200, description: 'Returns the OAuth URL' })
    async getAuthUrl(
        @Param('providerId') providerId: string,
        @Query('callbackUrl') callbackUrl?: string,
        @Query('state') state?: string,
    ) {
        const url = this.socialAuthService.getAuthorizationUrl(providerId, callbackUrl, state);
        return { url };
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
        @Query('callbackUrl') callbackUrl: string | undefined,
        @Request() req,
    ) {
        const userAgent = req.headers['user-agent'];
        const ipAddress = req.ip || req.headers['x-forwarded-for'];
        const user = await this.socialAuthService.authenticate(providerId, code, callbackUrl);
        const result = await this.authProvider.issueSession(user.id);

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
