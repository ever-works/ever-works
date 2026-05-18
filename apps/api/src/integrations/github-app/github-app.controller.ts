import {
    BadRequestException,
    Controller,
    Get,
    Inject,
    NotFoundException,
    Param,
    Post,
    Query,
    Request,
    UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from '@src/auth';
import { Public } from '@src/auth/decorators/public.decorator';
import { AuthProvider } from '@src/auth/providers/auth-provider.abstract';
import { AUTH_PROVIDER } from '@src/auth/providers/auth-provider.constants';
import { GitHubAppCallbackQueryDto, GitHubAppSetupQueryDto } from './dto/github-app.dto';
import { GitHubAppOnboardingService } from './github-app-onboarding.service';
import { GitHubAppSyncService } from './github-app-sync.service';

@Controller('api/github-app')
export class GitHubAppController {
    constructor(
        private readonly gitHubAppOnboardingService: GitHubAppOnboardingService,
        private readonly gitHubAppSyncService: GitHubAppSyncService,
        private readonly authService: AuthService,
        @Inject(AUTH_PROVIDER)
        private readonly authProvider: AuthProvider,
    ) {}

    @Public()
    @Get('setup')
    async setup(@Query() query: GitHubAppSetupQueryDto) {
        return this.gitHubAppOnboardingService.beginSetup({
            installationId: query.installation_id,
            setupAction: query.setup_action,
            redirectTo: query.redirectTo,
        });
    }

    @Public()
    @Get('callback')
    async callback(@Query() query: GitHubAppCallbackQueryDto, @Request() req) {
        const result = await this.gitHubAppOnboardingService.completeUserAuth({
            code: query.code,
            state: query.state,
        });
        // H-04: bind the GitHub-App-issued session to the requesting client.
        const ipAddress =
            (typeof req.ip === 'string' && req.ip) ||
            (typeof req.headers['x-forwarded-for'] === 'string'
                ? (req.headers['x-forwarded-for'] as string).split(',')[0].trim()
                : null);
        const userAgent =
            typeof req.headers['user-agent'] === 'string'
                ? (req.headers['user-agent'] as string)
                : null;
        const auth = await this.authProvider.issueSession(result.user.id, { ipAddress, userAgent });

        return {
            ...auth,
            installationId: result.installation.installationId,
            redirectTo: result.redirectTo,
        };
    }

    @Get('installations')
    async listInstallations(@Request() req) {
        return this.gitHubAppSyncService.listInstallationsForUser(req.user.userId);
    }

    @Post('installations/:installationId/sync')
    async syncInstallation(@Param('installationId') installationId: string, @Request() req) {
        const installation = await this.gitHubAppSyncService.syncInstallation(
            installationId,
            req.user.userId,
        );

        if (!installation) {
            throw new UnauthorizedException('GitHub App installation not found for this user');
        }

        return installation;
    }

    @Post('installations/:installationId/repositories/:repositoryId/onboard')
    async onboardRepository(
        @Param('installationId') installationId: string,
        @Param('repositoryId') repositoryId: string,
        @Request() req,
    ) {
        const user = await this.authService.getUser(req.user.userId);
        const result = await this.gitHubAppSyncService.onboardInstallationRepository(
            installationId,
            repositoryId,
            user,
        );

        if (!result) {
            throw new NotFoundException('GitHub App repository not found for this user');
        }

        if (result.status === 'error') {
            throw new BadRequestException(result.message);
        }

        return result;
    }
}
