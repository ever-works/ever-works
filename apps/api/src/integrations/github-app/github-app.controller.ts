import {
    Controller,
    Get,
    Inject,
    Param,
    Post,
    Query,
    Request,
    UnauthorizedException,
} from '@nestjs/common';
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
    async callback(@Query() query: GitHubAppCallbackQueryDto) {
        const result = await this.gitHubAppOnboardingService.completeUserAuth({
            code: query.code,
            state: query.state,
        });
        const auth = await this.authProvider.issueSession(result.user.id);

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
}
