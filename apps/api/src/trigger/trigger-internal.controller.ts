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
    Delete,
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
import { CacheDto } from './dto/cache.dto';
import {
    DirectoryOwnershipService,
    DirectoryScheduleDispatcherService,
    DirectoryScheduleService,
} from '@ever-works/agent/services';
import { ScheduleRunCompleteDto, ScheduleRunFailureDto } from './dto/schedule-run.dto';
import { GenerateStatusType } from '@ever-works/agent/entities';
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

    @Post('schedules/dispatch')
    @Public()
    async dispatchSchedules(@Headers('x-trigger-secret') secret: string) {
        this.ensureSecret(secret);

        const dispatched = await this.scheduleDispatcher.dispatchDue();

        return {
            dispatched,
        };
    }

    @Post('schedules/:id/complete')
    @Public()
    async markScheduleRunCompleted(
        @Headers('x-trigger-secret') secret: string,
        @Param('id') scheduleId: string,
        @Body() body: ScheduleRunCompleteDto,
    ) {
        this.ensureSecret(secret);

        if (!scheduleId) {
            throw new BadRequestException('Missing schedule id');
        }

        await this.directoryScheduleService.markRunCompleted({
            scheduleId,
            historyId: body.historyId,
            status: body.status ?? GenerateStatusType.GENERATED,
        });

        return { status: 'ok' };
    }

    @Post('schedules/:id/fail')
    @Public()
    async markScheduleRunFailed(
        @Headers('x-trigger-secret') secret: string,
        @Param('id') scheduleId: string,
        @Body() body: ScheduleRunFailureDto,
    ) {
        this.ensureSecret(secret);

        if (!scheduleId) {
            throw new BadRequestException('Missing schedule id');
        }

        await this.directoryScheduleService.markRunFailed(scheduleId, body.reason);

        return { status: 'ok' };
    }

    @Post('cache')
    @Public()
    async setCache(@Headers('x-trigger-secret') secret: string, @Body() body: CacheDto) {
        this.ensureSecret(secret);

        const { key, value, ttl } = body;

        if (!key) {
            throw new BadRequestException('Missing cache key');
        }

        await this.cacheManager.set(key, value, ttl);

        return { status: 'ok' };
    }

    @Get('cache')
    @Public()
    async getCache(@Headers('x-trigger-secret') secret: string, @Query('key') key: string) {
        this.ensureSecret(secret);

        if (!key) {
            throw new BadRequestException('Missing cache key');
        }

        const value = await this.cacheManager.get(key);

        return { key, value };
    }

    @Delete('cache')
    @Public()
    async deleteCache(@Headers('x-trigger-secret') secret: string, @Query('key') key: string) {
        this.ensureSecret(secret);

        if (!key) {
            throw new BadRequestException('Missing cache key');
        }

        const value = await this.cacheManager.del(key);

        return { deleted: value };
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
