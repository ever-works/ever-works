import { Body, Controller, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { DirectoryRepository } from '@packages/agent/database';
import { DeployVercelDto, VercelService } from '@packages/agent/deploy';
import { AuthService, CurrentUser, JwtAuthGuard } from '../auth';
import { config as agentConfig } from '@packages/agent/config';
import { AuthenticatedUser } from '../auth/types/jwt.types';

@Controller('api/deploy')
@UseGuards(JwtAuthGuard)
export class DeployController {
    constructor(
        private readonly vercelService: VercelService,
        private readonly directoryRepository: DirectoryRepository,
        private readonly authService: AuthService,
    ) {}

    @Post('/directories/:id/vercel')
    async toVercel(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() deployVercel: DeployVercelDto,
        @Param('id') id: string,
    ) {
        const { VERCEL_TOKEN, GITHUB_TOKEN } = deployVercel;

        const directory = await this.directoryRepository.findById(id);
        if (!directory) {
            throw new NotFoundException('Directory not found');
        }

        // Validate that the user owns this directory
        if (directory.userId !== auth.userId) {
            throw new NotFoundException('You do not have permission to deploy this directory');
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

        return {
            status: 'pending',
            slug: directory.slug,
            owner: directory.getRepoOwner(),
            repository: `${directory.getRepoOwner()}/${directory.getWebsiteRepo()}`,
            message: 'Deployment started',
        };
    }
}
