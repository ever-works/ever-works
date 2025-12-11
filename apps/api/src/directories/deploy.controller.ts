import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    HttpException,
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
import { VercelTokenDto } from './dto/deploy.dto';

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
        const { VERCEL_TOKEN, GITHUB_TOKEN, vercelTeamScope } = deployVercel;

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

        const valid = await this.vercelService.validateToken(vercelToken);
        if (!valid) {
            throw new BadRequestException({
                status: 'error',
                message: 'Invalid Vercel token',
            });
        }

        // Deploy
        const deploymentInitiated = await this.vercelService.deploy(
            {
                owner: directory.getRepoOwner(),
                repo: directory.getWebsiteRepo(),
                provider: 'vercel',
                data: {
                    vercelTeamScope,
                    vercelToken,
                    ghToken,
                },
            },
            directory,
            user,
        );

        if (deploymentInitiated) {
            this.vercelDeploymentVerifierService.startVerification(
                directory,
                vercelToken,
                vercelTeamScope,
            );
        }

        return {
            status: 'pending',
            slug: directory.slug,
            owner: directory.getRepoOwner(),
            repository: `${directory.getRepoOwner()}/${directory.getWebsiteRepo()}`,
            message: 'Deployment started',
        };
    }

    @Post('/vercel/validate-token')
    async validateToken(@Body() deployToken: VercelTokenDto) {
        const userInfo = await this.vercelService.validateToken(deployToken.token);

        return {
            status: userInfo ? 'success' : 'error',
            valid: Boolean(userInfo),
            userInfo: userInfo || null,
        };
    }

    @Post('/vercel/teams')
    async getVercelTeams(@CurrentUser() auth: AuthenticatedUser) {
        try {
            const user = await this.authService.getUser(auth.userId);
            if (!user.vercelToken) {
                throw new Error('You need to configure the Vercel token first.');
            }

            const teams = await this.vercelService.getAccountTeams(user.vercelToken);

            return {
                status: 'success',
                teams,
            };
        } catch (error) {
            throw new BadRequestException({
                status: 'error',
                message: error?.message,
            });
        }
    }

    @Post('/directories/:id/vercel/lookup')
    async lookupExistingDeployment(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ) {
        const user = await this.authService.getUser(auth.userId);
        const directory = await this.validateDirectoryOwnership(id, user.id);

        if (directory.website) {
            return {
                status: 'success',
                website: directory.website,
                deploymentState: directory.deploymentState,
            };
        }

        const vercelToken = user.vercelToken;
        if (!vercelToken) {
            throw new BadRequestException({
                status: 'error',
                message: 'Vercel token is required to lookup deployments',
            });
        }

        const existingDeployment =
            await this.vercelDeploymentVerifierService.lookupExistingDeployment(
                directory,
                vercelToken,
            );

        return {
            status: 'success',
            website: existingDeployment.website,
            deploymentState: existingDeployment.deploymentState,
            found: existingDeployment.found,
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
            throw new ForbiddenException({
                status: 'error',
                message: 'You do not have permission to access this directory',
            });
        }

        return directory;
    }
}
