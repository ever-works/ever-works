import { BadRequestException, Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { DeployVercelDto, VercelService } from '@packages/agent/deploy';
import { DirectoryOwnershipService } from '@packages/agent/services';
import { AuthService, CurrentUser, JwtAuthGuard } from '../auth';
import { AuthenticatedUser } from '../auth/types/jwt.types';
import { VercelDeploymentVerifierService } from './tasks/vercel-deployment-verifier.service';
import { VercelTokenDto } from './dto/deploy.dto';

@Controller('api/deploy')
@UseGuards(JwtAuthGuard)
export class DeployController {
    constructor(
        private readonly vercelService: VercelService,
        private readonly ownershipService: DirectoryOwnershipService,
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
        const { directory, isCreator } = await this.ownershipService.ensureCanEdit(id, user.id);

        // For shared directories, use the directory owner's tokens
        // The owner set up the infrastructure, collaborators just trigger deployments
        const directoryOwner = directory.user;

        // Use owner's GitHub token for shared directories (they connected the repos)
        const ghToken =
            GITHUB_TOKEN || (isCreator ? user.getGitToken() : directoryOwner.getGitToken());

        // Use owner's Vercel token for shared directories (they configured deployment)
        const vercelToken =
            VERCEL_TOKEN || (isCreator ? user.vercelToken : directoryOwner.vercelToken);
        if (!vercelToken) {
            throw new BadRequestException({
                status: 'error',
                message: isCreator
                    ? 'Vercel token is required. Please configure it in your settings.'
                    : 'The directory owner has not configured a Vercel token for deployment.',
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

    /**
     * Check if deployment is possible for a directory.
     * For shared directories, checks the owner's Vercel token.
     */
    @Post('/directories/:id/vercel/check')
    async checkDeploymentCapability(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ) {
        const user = await this.authService.getUser(auth.userId);
        const { directory, isCreator } = await this.ownershipService.ensureCanView(id, user.id);

        // Determine which Vercel token to check
        const directoryOwner = directory.user;
        const vercelToken = isCreator ? user.vercelToken : directoryOwner.vercelToken;

        return {
            status: 'success',
            canDeploy: Boolean(vercelToken),
            isShared: !isCreator,
            ownerHasToken: Boolean(directoryOwner.vercelToken),
            userHasToken: Boolean(user.vercelToken),
        };
    }

    @Post('/directories/:id/vercel/lookup')
    async lookupExistingDeployment(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ) {
        const user = await this.authService.getUser(auth.userId);
        const { directory, isCreator } = await this.ownershipService.ensureCanView(id, user.id);

        if (directory.website) {
            return {
                status: 'success',
                website: directory.website,
                deploymentState: directory.deploymentState,
            };
        }

        // For shared directories, use the directory owner's Vercel token
        const directoryOwner = directory.user;
        const vercelToken = isCreator ? user.vercelToken : directoryOwner.vercelToken;
        if (!vercelToken) {
            throw new BadRequestException({
                status: 'error',
                message: isCreator
                    ? 'Vercel token is required to lookup deployments'
                    : 'The directory owner has not configured a Vercel token',
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
}
