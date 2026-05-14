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
import { WorkOwnershipService } from '@ever-works/agent/services';
import { WorkDeploymentRepository } from '@ever-works/agent/database';
import { DeployService } from './deploy.service';
import { DeploymentVerifierService } from './tasks/deployment-verifier.service';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import {
    ActivityActionType,
    ActivityStatus,
    DeploymentEnvironment,
    DeploymentTriggerSource,
} from '@ever-works/agent/entities';
import { DeployWorkDto, RollbackDto } from './dto/deploy.dto';
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
        private readonly ownershipService: WorkOwnershipService,
        private readonly deploymentVerifier: DeploymentVerifierService,
        private readonly deploymentRepository: WorkDeploymentRepository,
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
    async listProviders(@CurrentUser() auth: AuthenticatedUser) {
        const providers = await this.deployFacade.getAvailableProvidersForUser(auth.userId);
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

        const configured = await this.deployFacade.isProviderConfigured(providerId, auth.userId);

        return {
            status: 'success',
            configured,
            available: true,
            enabled: true,
            message: configured
                ? `Provider '${providerId}' is configured.`
                : `Provider '${providerId}' is available but not configured.`,
        };
    }

    /**
     * Deploy a work to its configured provider
     */
    @Post('/works/:id')
    @ApiOperation({
        summary: 'Deploy work',
        description: 'Deploy a work website to its configured provider',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Deployment started' })
    @ApiResponse({ status: 400, description: 'Invalid configuration or missing token' })
    async deploy(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() deployDto: DeployWorkDto,
        @Param('id') id: string,
    ) {
        const { work, isCreator } = await this.ownershipService.ensureCanEdit(id, auth.userId);

        // Check if user has configured deployment credentials
        const isConfigured = await this.deployFacade.isConfigured({
            userId: isCreator ? auth.userId : work.user.id,
            workId: id,
        });

        const providerName = this.getProviderName(work.deployProvider);

        if (!isConfigured) {
            throw new BadRequestException({
                status: 'error',
                message: isCreator
                    ? `${providerName} token is required. Please configure it in Plugin Settings.`
                    : `The work owner has not configured ${providerName} credentials.`,
            });
        }

        // Validate token
        const isValid = await this.deployFacade.validateToken({
            userId: isCreator ? auth.userId : work.user.id,
            workId: id,
        });

        if (!isValid) {
            throw new BadRequestException({
                status: 'error',
                message: `Invalid ${providerName} token. Please check your token in Plugin Settings.`,
            });
        }

        const { dispatched, deploymentId } = await this.deployService.deploy(
            id,
            isCreator ? auth.userId : work.user.id,
            { teamScope: deployDto.teamScope },
        );

        if (!dispatched) {
            throw new BadRequestException({
                status: 'error',
                message: `Failed to initiate ${providerName} deployment. Check that the repository has the provider workflow configured.`,
            });
        }

        this.deploymentVerifier.startVerification(
            work,
            isCreator ? auth.userId : work.user.id,
            deployDto.teamScope,
            deploymentId,
        );

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.DEPLOYMENT,
                action: 'work.deployed',
                status: ActivityStatus.COMPLETED,
                summary: `Triggered deployment for ${work.name} via ${providerName}`,
            })
            .catch(() => {});

        return {
            status: 'pending',
            slug: work.slug,
            owner: work.getRepoOwner('website'),
            repository: `${work.getRepoOwner('website')}/${work.getWebsiteRepo()}`,
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
        const providers = await this.deployFacade.getAvailableProvidersForUser(auth.userId);
        const enabledProvider = providers.find((p) => p.enabled && p.configured);

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
     * Get deployment teams for the user (requires work context)
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
                    'To fetch teams, use the work-specific endpoint or configure your token in Plugin Settings.',
            };
        } catch (error) {
            throw new BadRequestException({
                status: 'error',
                message: error?.message || 'Failed to get teams',
            });
        }
    }

    /**
     * Get deployment teams for a specific work
     */
    @Post('/works/:id/teams')
    @ApiOperation({
        summary: 'Get deployment teams for work',
        description: 'Get teams from deployment provider for a specific work',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'List of teams' })
    async getTeamsForWork(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const { work, isCreator } = await this.ownershipService.ensureCanView(id, auth.userId);
        const providerName = this.getProviderName(work.deployProvider);

        try {
            const teams = await this.deployFacade.getTeams({
                userId: isCreator ? auth.userId : work.user.id,
                workId: id,
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
     * Check if deployment is possible for a work
     */
    @Post('/works/:id/check')
    @ApiOperation({
        summary: 'Check deployment capability',
        description: 'Check if deployment is configured for a work',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Deployment capability status' })
    async checkDeploymentCapability(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ) {
        const { work, isCreator } = await this.ownershipService.ensureCanView(id, auth.userId);

        const canDeploy = await this.deployFacade.isConfigured({
            userId: isCreator ? auth.userId : work.user.id,
            workId: id,
        });

        const ownerCanDeploy = await this.deployFacade.isConfigured({
            userId: work.user.id,
            workId: id,
        });

        const userCanDeploy = await this.deployFacade.isConfigured({
            userId: auth.userId,
            workId: id,
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
     * Lookup existing deployment for a work
     */
    @Post('/works/:id/lookup')
    @ApiOperation({
        summary: 'Lookup existing deployment',
        description: 'Check if a work has an existing deployment',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Deployment lookup result' })
    async lookupExistingDeployment(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ) {
        const { work, isCreator } = await this.ownershipService.ensureCanView(id, auth.userId);

        if (work.website) {
            return {
                status: 'success',
                website: work.website,
                deploymentState: work.deploymentState,
                found: true,
            };
        }

        const isConfigured = await this.deployFacade.isConfigured({
            userId: isCreator ? auth.userId : work.user.id,
            workId: id,
        });

        const providerName = this.getProviderName(work.deployProvider);

        if (!isConfigured) {
            throw new BadRequestException({
                status: 'error',
                message: isCreator
                    ? `${providerName} token is required to lookup deployments. Configure it in Plugin Settings.`
                    : `The work owner has not configured ${providerName} credentials.`,
            });
        }

        const result = await this.deploymentVerifier.lookupExistingDeployment(
            work,
            isCreator ? auth.userId : work.user.id,
        );

        return {
            status: 'success',
            website: result.website,
            deploymentState: result.deploymentState,
            found: result.found,
        };
    }

    /**
     * Batch deploy multiple works
     */
    @Post('/batch')
    @ApiOperation({
        summary: 'Batch deploy',
        description: 'Deploy multiple works',
    })
    @ApiResponse({ status: 200, description: 'Batch deployment result' })
    async batchDeploy(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() batchDeployDto: BatchDeployDto,
    ): Promise<BatchDeployResponseDto> {
        for (const item of batchDeployDto.works) {
            await this.ownershipService.ensureCanEdit(item.workId, auth.userId);
        }

        const result = await this.deployService.deployBatch(
            batchDeployDto.works,
            auth.userId,
            batchDeployDto.teamScope,
        );

        this.activityLogService
            .log({
                userId: auth.userId,
                actionType: ActivityActionType.DEPLOYMENT,
                action: 'deployment.batch_started',
                status: ActivityStatus.COMPLETED,
                summary: `Triggered batch deploy for ${batchDeployDto.works.length} works`,
                details: {
                    workIds: batchDeployDto.works.map((item) => item.workId),
                },
            })
            .catch(() => {});

        for (const deployResult of result.results) {
            if (deployResult.status === 'pending' && deployResult.workId) {
                const { work } = await this.ownershipService.ensureCanEdit(
                    deployResult.workId,
                    auth.userId,
                );
                this.deploymentVerifier.startVerification(
                    work,
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
     * List domains for a work deployment
     */
    @Get('/works/:id/domains')
    @ApiOperation({
        summary: 'List domains',
        description: 'Get custom domains for a deployed work',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'List of domains' })
    async listDomains(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        const { work, isCreator } = await this.ownershipService.ensureCanView(id, auth.userId);

        if (!work.website) {
            throw new BadRequestException({
                status: 'error',
                message:
                    'No deployment exists for this work. Deploy first before managing domains.',
            });
        }

        try {
            const domains = await this.deployFacade.getDomains({
                userId: isCreator ? auth.userId : work.user.id,
                workId: id,
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
     * Add a domain to a work deployment
     */
    @Post('/works/:id/domains')
    @ApiOperation({
        summary: 'Add domain',
        description: 'Add a custom domain to a deployed work',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Domain added' })
    async addDomain(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() dto: AddDomainDto,
    ) {
        const { work, isCreator } = await this.ownershipService.ensureCanEdit(id, auth.userId);

        if (!work.website) {
            throw new BadRequestException({
                status: 'error',
                message: 'No deployment exists for this work. Deploy first before adding domains.',
            });
        }

        try {
            const result = await this.deployFacade.addDomain(dto.domain, {
                userId: isCreator ? auth.userId : work.user.id,
                workId: id,
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
     * Remove a domain from a work deployment
     */
    @Delete('/works/:id/domains/:domain')
    @ApiOperation({
        summary: 'Remove domain',
        description: 'Remove a custom domain from a deployed work',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiParam({ name: 'domain', description: 'Domain name to remove' })
    @ApiResponse({ status: 200, description: 'Domain removed' })
    async removeDomain(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('domain') domain: string,
    ) {
        const { isCreator, work } = await this.ownershipService.ensureCanEdit(id, auth.userId);

        if (!work.website) {
            throw new BadRequestException({
                status: 'error',
                message:
                    'No deployment exists for this work. Deploy first before managing domains.',
            });
        }

        try {
            const removed = await this.deployFacade.removeDomain(domain, {
                userId: isCreator ? auth.userId : work.user.id,
                workId: id,
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
     * Verify a domain on a work deployment
     */
    @Post('/works/:id/domains/:domain/verify')
    @ApiOperation({
        summary: 'Verify domain',
        description: 'Trigger DNS verification for a domain on a deployed work',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiParam({ name: 'domain', description: 'Domain name to verify' })
    @ApiResponse({ status: 200, description: 'Verification result' })
    async verifyDomain(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Param('domain') domain: string,
    ) {
        const { isCreator, work } = await this.ownershipService.ensureCanEdit(id, auth.userId);

        if (!work.website) {
            throw new BadRequestException({
                status: 'error',
                message:
                    'No deployment exists for this work. Deploy first before managing domains.',
            });
        }

        try {
            const result = await this.deployFacade.verifyDomain(domain, {
                userId: isCreator ? auth.userId : work.user.id,
                workId: id,
            });
            return { status: 'success', domain: result };
        } catch (error) {
            throw new BadRequestException({
                status: 'error',
                message: error?.message || 'Failed to verify domain',
            });
        }
    }

    @Get('/works/:id/deployments')
    @ApiOperation({
        summary: 'List deployments',
        description: 'Deployment history for a work (production + previews)',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'List of deployments' })
    async listDeployments(@CurrentUser() auth: AuthenticatedUser, @Param('id') id: string) {
        await this.ownershipService.ensureCanView(id, auth.userId);
        const deployments = await this.deploymentRepository.findByWork(id, { limit: 50 });
        return { status: 'success', deployments };
    }

    @Post('/works/:id/rollback')
    @ApiOperation({
        summary: 'Roll back to a previous deployment',
        description: 'Redeploys the commit/branch of a previous production deployment',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 200, description: 'Rollback initiated' })
    async rollback(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
        @Body() dto: RollbackDto,
    ) {
        const { work, isCreator } = await this.ownershipService.ensureCanEdit(id, auth.userId);

        const target = await this.deploymentRepository.findById(dto.deploymentId);
        if (!target || target.workId !== id) {
            throw new BadRequestException({
                status: 'error',
                message: 'Deployment not found for this work.',
            });
        }
        if (target.environment !== DeploymentEnvironment.PRODUCTION) {
            throw new BadRequestException({
                status: 'error',
                message: 'Only production deployments can be rolled back to.',
            });
        }

        const { dispatched, deploymentId } = await this.deployService.deploy(
            id,
            isCreator ? auth.userId : work.user.id,
            {
                environment: DeploymentEnvironment.PRODUCTION,
                branch: target.branch,
                commitSha: target.commitSha,
                triggerSource: DeploymentTriggerSource.MANUAL,
            },
        );

        if (!dispatched) {
            throw new BadRequestException({
                status: 'error',
                message: 'Failed to dispatch rollback workflow.',
            });
        }

        this.deploymentVerifier.startVerification(
            work,
            isCreator ? auth.userId : work.user.id,
            undefined,
            deploymentId,
        );

        this.activityLogService
            .log({
                userId: auth.userId,
                workId: id,
                actionType: ActivityActionType.DEPLOYMENT,
                action: 'deployment.rollback',
                status: ActivityStatus.IN_PROGRESS,
                summary: `Rolled back ${work.name} to deployment ${target.id}`,
                details: { rolledBackFromDeploymentId: target.id },
            })
            .catch(() => {});

        return { status: 'pending', deploymentId, message: 'Rollback started' };
    }
}
