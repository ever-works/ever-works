import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Post,
    UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { AuthSessionGuard, CurrentUser } from '../../auth';
import { AuthenticatedUser } from '../../auth/types/auth.types';
import { DeployFacadeService } from '@ever-works/agent/facades';
import { DirectoryOwnershipService } from '@ever-works/agent/services';
import { DeployService } from './deploy.service';
import { DeploymentVerifierService } from './tasks/deployment-verifier.service';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import { DeployDirectoryDto } from './dto/deploy.dto';
import { BatchDeployDto, BatchDeployResponseDto } from './dto/batch-deploy.dto';
import { AddDomainDto } from './dto/domain.dto';

@ApiTags('Deploy')
@ApiBearerAuth('JWT-auth')
@Controller('api/deploy')
@UseGuards(AuthSessionGuard)
export class DeployController {
    constructor(
        private readonly deployService: DeployService,
        private readonly deployFacade: DeployFacadeService,
        private readonly ownershipService: DirectoryOwnershipService,
        private readonly deploymentVerifier: DeploymentVerifierService,
        private readonly activityLogService: ActivityLogService,
    ) {}

    private getProviderName(deployProvider: string | undefined): string {
        if (!deployProvider) return 'Deployment';
        const providers = this.deployFacade.getAvailableProviders();
        const provider = providers.find((p) => p.id === deployProvider);
        return provider?.name || deployProvider;
    }

    /**
     * Get available deployment providers
     */
    @Get('/providers')
    @ApiOperation({
        summary: 'List deployment providers',
        description: 'Get list of available deployment providers',
    })
    @ApiResponse({ status: 200, description: 'List of providers' })
    async listProviders() {
        const providers = this.deployFacade.getAvailableProviders();
        return {
            status: 'success',
            providers,
        };
    }

    /**
     * Check if user has configured a specific provider
     */
    @Get('/providers/:providerId/configured')
    @ApiOperation({
        summary: 'Check provider configuration',
        description: 'Check if a user has configured settings for a specific deployment provider',
    })
    @ApiParam({ name: 'providerId', description: 'Provider ID' })
    @ApiResponse({ status: 200, description: 'Provider configuration status' })
    async isProviderConfigured(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('providerId') providerId: string,
    ) {
        const providers = this.deployFacade.getAvailableProviders();
        const provider = providers.find((p) => p.id === providerId);

        if (!provider) {
            return {
                status: 'success',
                configured: false,
                available: false,
                message: `Provider '${providerId}' is not available`,
            };
        }

        if (!provider.enabled) {
            return {
                status: 'success',
                configured: false,
                available: true,
                enabled: false,
                message: `Provider '${providerId}' is not enabled`,
            };
        }

        return {
            status: 'success',
            configured: true,
            available: true,
            enabled: true,
            message: `Provider '${providerId}' is available. Token validation will occur during deployment.`,
        };
    }

    /**
     * Deploy a directory to its configured provider
     */
    @Post('/directories/:id')
    @ApiOperation({
        summary: 'Deploy directory',
        description: 'Deploy a directory website to its configured provider',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'Deployment started' })
    @ApiResponse({ status: 400, description: 'Invalid configuration or missing token' })
    async deploy(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() deployDto: DeployDirectoryDto,
        @Param('id') id: string,
    ) {
        const { directory, isCreator } = await this.ownershipService.ensureCanEdit(id, auth.userId);

        // Check if user has configured deployment credentials
        const isConfigured = await this.deployFacade.isConfigured({
            userId: isCreator ? auth.userId : directory.user.id,
            directoryId: id,
        });

        const providerName = this.getProviderName(directory.deployProvider);

        if (!isConfigured) {
            throw new BadRequestException({
                status: 'error',
                message: isCreator
                    ? `${providerName} token is required. Please configure it in Plugin Settings.`
                    : `The directory owner has not configured ${providerName} credentials.`,
            });
        }

        // Validate token
        const isValid = await this.deployFacade.validateToken({
            userId: isCreator ? auth.userId : directory.user.id,
            directoryId: id,
        });

        if (!isValid) {
            throw new BadRequestException({
                status: 'error',
                message: `Invalid ${providerName} token. Please check your token in Plugin Settings.`,
            });
        }

        // Deploy
        const deploymentInitiated = await this.deployService.deploy(
            id,
            isCreator ? auth.userId : directory.user.id,
            { teamScope: deployDto.teamScope },
        );

        if (deploymentInitiated) {
            // Start verification
            this.deploymentVerifier.startVerification(
                directory,
                isCreator ? auth.userId : directory.user.id,
                deployDto.teamScope,
            );
        }

        this.activityLogService
            .log({
                userId: auth.userId,
                directoryId: id,
                actionType: ActivityActionType.DEPLOYMENT,
                action: 'directory.deployed',
                status: ActivityStatus.COMPLETED,
                summary: `Triggered deployment for ${directory.name} via ${providerName}`,
            })
            .catch(() => {});

        return {
            status: 'pending',
            slug: directory.slug,
            owner: directory.getRepoOwner('website'),
            repository: `${directory.getRepoOwner('website')}/${directory.getWebsiteRepo()}`,
            message: 'Deployment started',
        };
    }

    /**
     * Validate user's deployment token
     */
    @Post('/validate-token')
    @ApiOperation({
        summary: 'Validate deployment token',
        description: 'Check if user has a valid deployment token configured',
    })
    @ApiResponse({ status: 200, description: 'Token validation result' })
    async validateToken(@CurrentUser() auth: AuthenticatedUser) {
        const providers = this.deployFacade.getAvailableProviders();
        const enabledProvider = providers.find((p) => p.enabled);

        return {
            status: 'success',
            valid: !!enabledProvider,
            userInfo: null,
            message: enabledProvider
                ? 'Deployment provider is available. Token will be validated during deployment.'
                : 'No deployment provider is available.',
        };
    }

    /**
     * Get deployment teams for the user (requires directory context)
     */
    @Post('/teams')
    @ApiOperation({
        summary: 'Get deployment teams',
        description: 'Get teams from user deployment provider token',
    })
    @ApiResponse({ status: 200, description: 'List of teams' })
    async getDeploymentTeams(@CurrentUser() auth: AuthenticatedUser) {
        try {
            return {
                status: 'success',
                teams: [],
                message:
                    'To fetch teams, use the directory-specific endpoint or configure your token in Plugin Settings.',
            };
        } catch (error) {
            throw new BadRequestException({
                status: 'error',
                message: error?.message || 'Failed to get teams',
            });
        }
    }

    /**
     * Get deployment teams for a specific directory
     */
    @Post('/directories/:id/teams')
    @ApiOperation({
        summary: 'Get deployment teams for directory',
        description: 'Get teams from deployment provider for a specific directory',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'List of teams' })
    async getTeamsForDirectory(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const { directory, isCreator } = await this.ownershipService.ensureCanView(id, auth.userId);
        const providerName = this.getProviderName(directory.deployProvider);

        try {
            const teams = await this.deployFacade.getTeams({
                userId: isCreator ? auth.userId : directory.user.id,
                directoryId: id,
            });

            return {
                status: 'success',
                teams,
            };
        } catch (error) {
            throw new BadRequestException({
                status: 'error',
                message:
                    error?.message ||
                    `Failed to get teams. Please configure your ${providerName} token in Plugin Settings.`,
            });
        }
    }

    /**
     * Check if deployment is possible for a directory
     */
    @Post('/directories/:id/check')
    @ApiOperation({
        summary: 'Check deployment capability',
        description: 'Check if deployment is configured for a directory',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'Deployment capability status' })
    async checkDeploymentCapability(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ) {
        const { directory, isCreator } = await this.ownershipService.ensureCanView(id, auth.userId);

        const canDeploy = await this.deployFacade.isConfigured({
            userId: isCreator ? auth.userId : directory.user.id,
            directoryId: id,
        });

        const ownerCanDeploy = await this.deployFacade.isConfigured({
            userId: directory.user.id,
            directoryId: id,
        });

        const userCanDeploy = await this.deployFacade.isConfigured({
            userId: auth.userId,
            directoryId: id,
        });

        return {
            status: 'success',
            canDeploy,
            isShared: !isCreator,
            ownerHasToken: ownerCanDeploy,
            userHasToken: userCanDeploy,
        };
    }

    /**
     * Lookup existing deployment for a directory
     */
    @Post('/directories/:id/lookup')
    @ApiOperation({
        summary: 'Lookup existing deployment',
        description: 'Check if a directory has an existing deployment',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'Deployment lookup result' })
    async lookupExistingDeployment(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ) {
        const { directory, isCreator } = await this.ownershipService.ensureCanView(id, auth.userId);

        if (directory.website) {
            return {
                status: 'success',
                website: directory.website,
                deploymentState: directory.deploymentState,
                found: true,
            };
        }

        const isConfigured = await this.deployFacade.isConfigured({
            userId: isCreator ? auth.userId : directory.user.id,
            directoryId: id,
        });

        const providerName = this.getProviderName(directory.deployProvider);

        if (!isConfigured) {
            throw new BadRequestException({
                status: 'error',
                message: isCreator
                    ? `${providerName} token is required to lookup deployments. Configure it in Plugin Settings.`
                    : `The directory owner has not configured ${providerName} credentials.`,
            });
        }

        const result = await this.deploymentVerifier.lookupExistingDeployment(
            directory,
            isCreator ? auth.userId : directory.user.id,
        );

        return {
            status: 'success',
            website: result.website,
            deploymentState: result.deploymentState,
            found: result.found,
        };
    }

    /**
     * Batch deploy multiple directories
     */
    @Post('/batch')
    @ApiOperation({
        summary: 'Batch deploy',
        description: 'Deploy multiple directories',
    })
    @ApiResponse({ status: 200, description: 'Batch deployment result' })
    async batchDeploy(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() batchDeployDto: BatchDeployDto,
    ): Promise<BatchDeployResponseDto> {
        for (const item of batchDeployDto.directories) {
            await this.ownershipService.ensureCanEdit(item.directoryId, auth.userId);
        }

        const result = await this.deployService.deployBatch(
            batchDeployDto.directories,
            auth.userId,
            batchDeployDto.teamScope,
        );

        this.activityLogService
            .log({
                userId: auth.userId,
                actionType: ActivityActionType.DEPLOYMENT,
                action: 'deployment.batch_started',
                status: ActivityStatus.COMPLETED,
                summary: `Triggered batch deploy for ${batchDeployDto.directories.length} directories`,
                details: {
                    directoryIds: batchDeployDto.directories.map((item) => item.directoryId),
                },
            })
            .catch(() => {});

        for (const deployResult of result.results) {
            if (deployResult.status === 'pending' && deployResult.directoryId) {
                const { directory } = await this.ownershipService.ensureCanEdit(
                    deployResult.directoryId,
                    auth.userId,
                );
                this.deploymentVerifier.startVerification(
                    directory,
                    auth.userId,
                    batchDeployDto.teamScope,
                );
            }
        }

        let status: 'success' | 'partial' | 'error';
        if (result.failed === 0) {
            status = 'success';
        } else if (result.successfullyStarted > 0) {
            status = 'partial';
        } else {
            status = 'error';
        }

        return {
            status,
            message: `Batch deployment: ${result.successfullyStarted} started, ${result.failed} failed`,
            totalRequested: result.totalRequested,
            successfullyStarted: result.successfullyStarted,
            failed: result.failed,
            results: result.results,
        };
    }

    /**
     * List domains for a directory deployment
     */
    @Get('/directories/:id/domains')
    @ApiOperation({
        summary: 'List domains',
        description: 'Get custom domains for a deployed directory',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'List of domains' })
    async listDomains(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const { directory, isCreator } = await this.ownershipService.ensureCanView(id, auth.userId);

        if (!directory.website) {
            throw new BadRequestException({
                status: 'error',
                message:
                    'No deployment exists for this directory. Deploy first before managing domains.',
            });
        }

        try {
            const domains = await this.deployFacade.getDomains({
                userId: isCreator ? auth.userId : directory.user.id,
                directoryId: id,
            });
            return { status: 'success', domains };
        } catch (error) {
            throw new BadRequestException({
                status: 'error',
                message: error?.message || 'Failed to get domains',
            });
        }
    }

    /**
     * Add a domain to a directory deployment
     */
    @Post('/directories/:id/domains')
    @ApiOperation({
        summary: 'Add domain',
        description: 'Add a custom domain to a deployed directory',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiResponse({ status: 200, description: 'Domain added' })
    async addDomain(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() dto: AddDomainDto,
    ) {
        const { directory, isCreator } = await this.ownershipService.ensureCanEdit(id, auth.userId);

        if (!directory.website) {
            throw new BadRequestException({
                status: 'error',
                message:
                    'No deployment exists for this directory. Deploy first before adding domains.',
            });
        }

        try {
            const result = await this.deployFacade.addDomain(dto.domain, {
                userId: isCreator ? auth.userId : directory.user.id,
                directoryId: id,
            });
            return { status: 'success', ...result };
        } catch (error) {
            throw new BadRequestException({
                status: 'error',
                message: error?.message || 'Failed to add domain',
            });
        }
    }

    /**
     * Remove a domain from a directory deployment
     */
    @Delete('/directories/:id/domains/:domain')
    @ApiOperation({
        summary: 'Remove domain',
        description: 'Remove a custom domain from a deployed directory',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiParam({ name: 'domain', description: 'Domain name to remove' })
    @ApiResponse({ status: 200, description: 'Domain removed' })
    async removeDomain(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('domain') domain: string,
    ) {
        const { isCreator, directory } = await this.ownershipService.ensureCanEdit(id, auth.userId);

        if (!directory.website) {
            throw new BadRequestException({
                status: 'error',
                message:
                    'No deployment exists for this directory. Deploy first before managing domains.',
            });
        }

        try {
            const removed = await this.deployFacade.removeDomain(domain, {
                userId: isCreator ? auth.userId : directory.user.id,
                directoryId: id,
            });
            return { status: 'success', removed };
        } catch (error) {
            throw new BadRequestException({
                status: 'error',
                message: error?.message || 'Failed to remove domain',
            });
        }
    }

    /**
     * Verify a domain on a directory deployment
     */
    @Post('/directories/:id/domains/:domain/verify')
    @ApiOperation({
        summary: 'Verify domain',
        description: 'Trigger DNS verification for a domain on a deployed directory',
    })
    @ApiParam({ name: 'id', description: 'Directory ID' })
    @ApiParam({ name: 'domain', description: 'Domain name to verify' })
    @ApiResponse({ status: 200, description: 'Verification result' })
    async verifyDomain(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('domain') domain: string,
    ) {
        const { isCreator, directory } = await this.ownershipService.ensureCanEdit(id, auth.userId);

        if (!directory.website) {
            throw new BadRequestException({
                status: 'error',
                message:
                    'No deployment exists for this directory. Deploy first before managing domains.',
            });
        }

        try {
            const result = await this.deployFacade.verifyDomain(domain, {
                userId: isCreator ? auth.userId : directory.user.id,
                directoryId: id,
            });
            return { status: 'success', domain: result };
        } catch (error) {
            throw new BadRequestException({
                status: 'error',
                message: error?.message || 'Failed to verify domain',
            });
        }
    }
}
