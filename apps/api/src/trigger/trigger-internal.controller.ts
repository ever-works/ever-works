import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    forwardRef,
    Get,
    Headers,
    OnModuleInit,
    Optional,
    Param,
    Post,
    Query,
    Inject,
} from '@nestjs/common';
import { WorkProposalsApiService } from '../work-proposals/work-proposals.service';
import superjson from 'superjson';
import { Public } from '../auth/decorators/public.decorator';
import { config } from '@ever-works/agent/config';
import {
    WorkRepository,
    AuthAccountRepository,
    TemplateRepository,
    TemplateCustomizationRepository,
    UserTemplatePreferenceRepository,
    UserRepository,
} from '@ever-works/agent/database';
import { Work, User } from '@ever-works/agent/entities';
import { CACHE_MANAGER, Cache } from '@ever-works/agent/cache';
import { WorkOperationsService } from '@ever-works/agent/work-operations';
import { WorkContextResponse } from '@ever-works/agent/tasks';
import { SkipThrottle } from '@nestjs/throttler';
import {
    WorkOwnershipService,
    WorkScheduleDispatcherService,
    WorkScheduleService,
} from '@ever-works/agent/services';
import { DataSyncDispatcherService } from '../data-sync/data-sync-dispatcher.service';
import { NotificationService } from '@ever-works/agent/notifications';
import { GitFacadeService } from '@ever-works/agent/facades';
import { RemoteCallDto } from './dto/remote-call.dto';
import {
    PluginRepository,
    UserPluginRepository,
    WorkPluginRepository,
} from '@ever-works/agent/plugins';

@SkipThrottle({ short: true, medium: true, long: true })
@Controller('internal/trigger')
export class TriggerInternalController implements OnModuleInit {
    private remoteMap: Record<string, object> = {};

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly ownershipService: WorkOwnershipService,
        private readonly workOperationsService: WorkOperationsService,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
        private readonly scheduleDispatcher: WorkScheduleDispatcherService,
        private readonly workScheduleService: WorkScheduleService,
        private readonly notificationService: NotificationService,
        private readonly gitFacade: GitFacadeService,
        private readonly pluginRepository: PluginRepository,
        private readonly userPluginRepository: UserPluginRepository,
        private readonly workPluginRepository: WorkPluginRepository,
        private readonly authAccountRepository: AuthAccountRepository,
        private readonly templateRepository: TemplateRepository,
        private readonly templateCustomizationRepository: TemplateCustomizationRepository,
        private readonly userTemplatePreferenceRepository: UserTemplatePreferenceRepository,
        private readonly userRepository: UserRepository,
        // EW-628 G7 — dispatcher fanned out from the data-repo-sync cron.
        private readonly dataSyncDispatcher: DataSyncDispatcherService,
        @Optional()
        @Inject(forwardRef(() => WorkProposalsApiService))
        private readonly workProposalsApiService?: WorkProposalsApiService,
    ) {}

    onModuleInit() {
        this.remoteMap = {
            AuthAccountRepository: this.authAccountRepository,
            PluginRepository: this.pluginRepository,
            UserPluginRepository: this.userPluginRepository,
            WorkPluginRepository: this.workPluginRepository,
            WorkOperationsService: this.workOperationsService,
            NotificationService: this.notificationService,
            WorkRepository: this.workRepository,
            TemplateRepository: this.templateRepository,
            TemplateCustomizationRepository: this.templateCustomizationRepository,
            UserTemplatePreferenceRepository: this.userTemplatePreferenceRepository,
            UserRepository: this.userRepository,
            CacheManager: this.cacheManager,
            WorkScheduleDispatcherService: this.scheduleDispatcher,
            WorkScheduleService: this.workScheduleService,
            // EW-628 G7 — exposed for the data-repo-sync dispatcher cron.
            DataSyncDispatcherService: this.dataSyncDispatcher,
            ...(this.workProposalsApiService
                ? { WorkProposalsApiService: this.workProposalsApiService }
                : {}),
        };
    }

    @Get('works/:id/context')
    @Public()
    async getWorkContext(
        @Headers('x-trigger-secret') secret: string,
        @Param('id') workId: string,
        @Query('userId') userId: string,
    ): Promise<WorkContextResponse> {
        this.ensureSecret(secret);

        if (!userId) {
            throw new BadRequestException('Missing userId');
        }

        const { work } = await this.ownershipService.ensureAccess(workId, userId);

        const gitToken = await this.gitFacade.getAccessToken({
            userId,
            providerId: work.gitProvider,
            workId: work.id,
        });

        return {
            work: this.stripRelations(work),
            user: this.stripSensitiveUserData(work.user),
            gitToken: gitToken ?? undefined,
        };
    }

    @Post('remote/call')
    @Public()
    async callRemote(@Headers('x-trigger-secret') secret: string, @Body() body: RemoteCallDto) {
        this.ensureSecret(secret);

        const instance = this.remoteMap[body.name];

        if (!instance) {
            throw new BadRequestException(`Unknown remote target: ${body.name}`);
        }

        const fn = (instance as any)[body.method];

        if (typeof fn !== 'function') {
            throw new BadRequestException(`Unknown method: ${body.method}`);
        }

        // Deserialize args with SuperJSON (supports Date, Map, Set, etc.)
        const args = superjson.deserialize(body.args as any) as unknown[];

        const result = await fn.call(instance, ...args);

        // Serialize result with SuperJSON so the caller can restore rich types
        return { result: superjson.serialize(result) };
    }

    private ensureSecret(secret?: string) {
        const expectedSecret = config.trigger.getInternalSecret();

        if (!expectedSecret) {
            throw new ForbiddenException('Trigger internal secret is not configured');
        }

        if (!secret || secret !== expectedSecret) {
            throw new ForbiddenException('Invalid trigger secret');
        }
    }

    private stripSensitiveUserData(user: User): WorkContextResponse['user'] {
        const { password, ...rest } = user;
        return JSON.parse(JSON.stringify(rest));
    }

    private stripRelations(work: Work) {
        const { user, ...rest } = work;
        return JSON.parse(JSON.stringify(rest));
    }
}
