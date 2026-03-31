import { Controller, UseGuards, Request, Get, Query } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { AuthService } from '../services/auth.service';
import { OAuthUrlService } from '../services/oauth-url.service';
import { Public } from '../decorators/public.decorator';
import { AuthProvider } from '../../config/constants';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';

@ApiTags('Auth')
@Controller('api/oauth')
export class OAuthController {
    constructor(
        private authService: AuthService,
        private oauthUrlService: OAuthUrlService,
        private readonly activityLogService: ActivityLogService,
    ) {}

    @Public()
    @Get('github/url')
    @ApiOperation({
        summary: 'Get GitHub OAuth URL',
        description: 'Generate a GitHub OAuth authorization URL',
    })
    @ApiQuery({
        name: 'callbackUrl',
        required: false,
        description: 'URL to redirect after authentication',
    })
    @ApiQuery({ name: 'state', required: false, description: 'Optional state parameter' })
    @ApiResponse({ status: 200, description: 'Returns the GitHub OAuth URL' })
    async getGitHubAuthUrl(
        @Query('callbackUrl') callbackUrl?: string,
        @Query('state') state?: string,
    ) {
        const url = this.oauthUrlService.generateGitHubAuthUrl(callbackUrl, state);
        return { url };
    }

    @Public()
    @Get('google/url')
    @ApiOperation({
        summary: 'Get Google OAuth URL',
        description: 'Generate a Google OAuth authorization URL',
    })
    @ApiQuery({
        name: 'callbackUrl',
        required: false,
        description: 'URL to redirect after authentication',
    })
    @ApiQuery({ name: 'state', required: false, description: 'Optional state parameter' })
    @ApiResponse({ status: 200, description: 'Returns the Google OAuth URL' })
    async getGoogleAuthUrl(
        @Query('callbackUrl') callbackUrl?: string,
        @Query('state') state?: string,
    ) {
        const url = this.oauthUrlService.generateGoogleAuthUrl(callbackUrl, state);
        return { url };
    }

    @Public()
    @Get('github')
    @UseGuards(AuthGuard(AuthProvider.GITHUB))
    async githubAuth(@Request() req) {}

    @Public()
    @Get('github/callback')
    @UseGuards(AuthGuard(AuthProvider.GITHUB))
    async githubAuthRedirect(@Request() req) {
        const userAgent = req.headers['user-agent'];
        const ipAddress = req.ip || req.headers['x-forwarded-for'];
        const result = await this.authService.login(req.user, userAgent, ipAddress);

        this.activityLogService
            .log({
                userId: req.user.id,
                actionType: ActivityActionType.USER_LOGIN,
                action: 'user.login.github',
                status: ActivityStatus.COMPLETED,
                summary: 'Signed in via GitHub',
                ipAddress,
                userAgent,
                metadata: {
                    provider: AuthProvider.GITHUB,
                },
            })
            .catch(() => {});

        return result;
    }

    @Public()
    @Get('google')
    @UseGuards(AuthGuard(AuthProvider.GOOGLE))
    async googleAuth(@Request() req) {}

    @Public()
    @Get('google/callback')
    @UseGuards(AuthGuard(AuthProvider.GOOGLE))
    async googleAuthRedirect(@Request() req) {
        const userAgent = req.headers['user-agent'];
        const ipAddress = req.ip || req.headers['x-forwarded-for'];
        const result = await this.authService.login(req.user, userAgent, ipAddress);

        this.activityLogService
            .log({
                userId: req.user.id,
                actionType: ActivityActionType.USER_LOGIN,
                action: 'user.login.google',
                status: ActivityStatus.COMPLETED,
                summary: 'Signed in via Google',
                ipAddress,
                userAgent,
                metadata: {
                    provider: AuthProvider.GOOGLE,
                },
            })
            .catch(() => {});

        return result;
    }
}
