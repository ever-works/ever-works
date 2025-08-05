import { Body, Controller, NotFoundException, Param, Post } from '@nestjs/common';
import { DirectoryRepository } from '@packages/agent/database';
import { DeployVercelDto, VercelService } from '@packages/agent/deploy';
import { AuthService, CurrentUser } from '@src/auth';
import { config as agentConfig } from '@packages/agent/config';
import { AuthenticatedUser } from '@src/auth/types/jwt.types';

@Controller('api/deploy')
export class DeployController {
    constructor(
        private readonly vercelService: VercelService,
        private readonly directoryRepository: DirectoryRepository,
        private readonly authService: AuthService,
    ) {}

    @Post('/:dirname/vercel')
    async toVercel(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() deployVercel: DeployVercelDto,
        @Param('dirname') slug: string,
    ) {
        const { VERCEL_TOKEN, GITHUB_TOKEN } = deployVercel;

        const directory = await this.directoryRepository.findByUserAndSlug(auth.userId, slug);
        if (!directory) {
            throw new NotFoundException('Directory not found');
        }

        const user = await this.authService.getUser(auth.userId);

        const vercelToken = VERCEL_TOKEN || user.vercelToken || agentConfig.vercel.getToken();
        const ghToken = GITHUB_TOKEN || user.getGitToken() || agentConfig.github.getApiKey();

        if (!vercelToken) {
            throw new NotFoundException('Vercel token is required');
        }

        await this.vercelService.deploy(
            {
                owner: directory.getRepoOwner(),
                repo: directory.getWebsiteRepo(),
                provider: 'vercel',
                data: {
                    vercelToken: vercelToken,
                    ghToken: ghToken,
                },
            },
            directory,
            user,
        );
    }
}
