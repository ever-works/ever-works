import {
    BadRequestException,
    Body,
    Controller,
    NotFoundException,
    Param,
    Post,
    UseGuards,
} from '@nestjs/common';
import { DirectoryRepository } from '@packages/agent/database';
import { DeployVercelDto, VercelService } from '@packages/agent/deploy';
import { AuthService, CurrentUser, JwtAuthGuard } from '../auth';
import { AuthenticatedUser } from '../auth/types/jwt.types';
import { VercelDeploymentVerifierService } from './tasks/vercel-deployment-verifier.service';
import { Directory } from '@packages/agent/entities';

@Controller('api/deploy')
@UseGuards(JwtAuthGuard)
export class DeployController {
    constructor(
        private readonly vercelService: VercelService,
        private readonly directoryRepository: DirectoryRepository,
        private readonly authService: AuthService,
        private readonly vercelDeploymentVerifierService: VercelDeploymentVerifierService,
    ) {}

    @Post('/directories/:id/vercel')
    async toVercel(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() deployVercel: DeployVercelDto,
        @Param('id') id: string,
    ) {
        const { VERCEL_TOKEN, GITHUB_TOKEN } = deployVercel;

        const user = await this.authService.getUser(auth.userId);
        const directory = await this.validateDirectoryOwnership(id, user.id);

        const ghToken = GITHUB_TOKEN || user.getGitToken();

        // Validate vercel token
        const vercelToken = VERCEL_TOKEN || user.vercelToken;
        if (!vercelToken) {
            throw new BadRequestException({
                status: 'error',
                message: 'Vercel token is required',
            });
        }

        const valid = await this.vercelDeploymentVerifierService.validateToken(vercelToken);
        if (!valid) {
            throw new BadRequestException({
                status: 'error',
                message: 'Invalid Vercel token',
            });
        }

        // Deploy
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

        this.vercelDeploymentVerifierService.startVerification(directory, vercelToken);

        return {
            status: 'pending',
            slug: directory.slug,
            owner: directory.getRepoOwner(),
            repository: `${directory.getRepoOwner()}/${directory.getWebsiteRepo()}`,
            message: 'Deployment started',
        };
    }

    private async validateDirectoryOwnership(
        directoryId: string,
        userId: string,
    ): Promise<Directory> {
        const directory = await this.directoryRepository.findById(directoryId);

        if (!directory) {
            throw new NotFoundException({
                status: 'error',
                message: `Directory with id '${directoryId}' not found`,
            });
        }

        if (directory.userId !== userId) {
            throw new BadRequestException({
                status: 'error',
                message: 'You do not have permission to access this directory',
            });
        }

        return directory;
    }
}
