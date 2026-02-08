import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    Get,
    Headers,
    OnModuleInit,
    Param,
    Post,
    Query,
    Inject,
} from '@nestjs/common';
import superjson from 'superjson';
import { Public } from '../auth/decorators/public.decorator';
import { config } from '@ever-works/agent/config';
import { DirectoryRepository, OAuthTokenRepository } from '@ever-works/agent/database';
import { Directory, User } from '@ever-works/agent/entities';
import { CACHE_MANAGER, Cache } from '@ever-works/agent/cache';
import { DirectoryOperationsService } from '@ever-works/agent/directory-operations';
import { DirectoryContextResponse } from '@ever-works/agent/tasks';
import { SkipThrottle } from '@nestjs/throttler';
import {
    DirectoryOwnershipService,
    DirectoryScheduleDispatcherService,
    DirectoryScheduleService,
} from '@ever-works/agent/services';
import { NotificationService } from '@ever-works/agent/notifications';
import { GitFacadeService } from '@ever-works/agent/facades';
import { RemoteCallDto } from './dto/remote-call.dto';
import {
    PluginRepository,
    UserPluginRepository,
    DirectoryPluginRepository,
} from '@ever-works/agent/plugins';

@SkipThrottle({ short: true, medium: true, long: true })
@Controller('internal/trigger')
export class TriggerInternalController implements OnModuleInit {
    private remoteMap: Record<string, object> = {};

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly ownershipService: DirectoryOwnershipService,
        private readonly directoryOperationsService: DirectoryOperationsService,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
        private readonly scheduleDispatcher: DirectoryScheduleDispatcherService,
        private readonly directoryScheduleService: DirectoryScheduleService,
        private readonly notificationService: NotificationService,
        private readonly gitFacade: GitFacadeService,
        private readonly pluginRepository: PluginRepository,
        private readonly userPluginRepository: UserPluginRepository,
        private readonly directoryPluginRepository: DirectoryPluginRepository,
        private readonly oauthTokenRepository: OAuthTokenRepository,
    ) {}

    onModuleInit() {
        this.remoteMap = {
            OAuthTokenRepository: this.oauthTokenRepository,
            PluginRepository: this.pluginRepository,
            UserPluginRepository: this.userPluginRepository,
            DirectoryPluginRepository: this.directoryPluginRepository,
            DirectoryOperationsService: this.directoryOperationsService,
            NotificationService: this.notificationService,
            DirectoryRepository: this.directoryRepository,
            CacheManager: this.cacheManager,
            DirectoryScheduleDispatcherService: this.scheduleDispatcher,
            DirectoryScheduleService: this.directoryScheduleService,
        };
    }

    @Get('directories/:id/context')
    @Public()
    async getDirectoryContext(
        @Headers('x-trigger-secret') secret: string,
        @Param('id') directoryId: string,
        @Query('userId') userId: string,
    ): Promise<DirectoryContextResponse> {
        this.ensureSecret(secret);

        if (!userId) {
            throw new BadRequestException('Missing userId');
        }

        const { directory } = await this.ownershipService.ensureAccess(directoryId, userId);

        const gitToken = await this.gitFacade.getAccessToken({
            userId,
            providerId: directory.gitProvider,
        });

        return {
            directory: this.stripRelations(directory),
            user: this.stripSensitiveUserData(directory.user),
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

    private stripSensitiveUserData(user: User): DirectoryContextResponse['user'] {
        const { password, ...rest } = user;
        return JSON.parse(JSON.stringify(rest));
    }

    private stripRelations(directory: Directory) {
        const { user, ...rest } = directory;
        return JSON.parse(JSON.stringify(rest));
    }
}
