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
import { Public } from '../auth/decorators/public.decorator';
import { config } from '@ever-works/agent/config';
import { DirectoryRepository, OAuthTokenRepository } from '@ever-works/agent/database';
import { Directory, User } from '@ever-works/agent/entities';
import { DirectoryCommandDto } from './dto/directory-command.dto';
import { CACHE_MANAGER, Cache } from '@ever-works/agent/cache';
import {
    DIRECTORY_OPERATIONS,
    DirectoryOperations,
    GenerationHistoryUpdateInput,
} from '@ever-works/agent/directory-operations';
import {
    DirectoryCommandAction,
    DirectoryCommandPayloads,
    DirectoryContextResponse,
} from '@ever-works/agent/tasks';
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
import { CreateNotificationDto } from './dto/create-notification.dto';
import { RemoteCallDto } from './dto/remote-call.dto';
import {
    PluginRepository,
    UserPluginRepository,
    DirectoryPluginRepository,
} from '@ever-works/agent/plugins';

type CommandHandlerContext = {
    directoryId: string;
    directory: Directory;
    operations: DirectoryOperations;
};

type CommandDefinitions = {
    [K in DirectoryCommandAction]: DirectoryCommandDefinition<K>;
};

type DirectoryCommandDefinition<K extends DirectoryCommandAction> = {
    requiredKeys: readonly (keyof DirectoryCommandPayloads[K])[];
    handler: (payload: DirectoryCommandPayloads[K], ctx: CommandHandlerContext) => Promise<void>;
};

@SkipThrottle({ short: true, medium: true, long: true })
@Controller('internal/trigger')
export class TriggerInternalController implements OnModuleInit {
    private remoteMap: Record<string, object> = {};

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly ownershipService: DirectoryOwnershipService,
        @Inject(DIRECTORY_OPERATIONS)
        private readonly directoryOperations: DirectoryOperations,
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

    @Post('directories/:id/commands')
    @Public()
    async handleDirectoryCommand(
        @Headers('x-trigger-secret') secret: string,
        @Param('id') directoryId: string,
        @Body() command: DirectoryCommandDto,
    ) {
        this.ensureSecret(secret);

        const directory = await this.directoryRepository.findById(directoryId);

        if (!directory) {
            throw new BadRequestException('Directory not found');
        }

        const definition = getCommandDefinition(command.action);
        const payload = ensurePayload(command.payload, definition, command.action);

        await definition.handler(payload, {
            directoryId,
            directory,
            operations: this.directoryOperations,
        });

        return { status: 'ok' };
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

    @Post('notifications')
    @Public()
    async createNotification(
        @Headers('x-trigger-secret') secret: string,
        @Body() dto: CreateNotificationDto,
    ) {
        this.ensureSecret(secret);

        const notification = await this.notificationService.create({
            ...dto,
            expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
        });

        return {
            success: true,
            notificationId: notification.id,
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

        const result = await fn.call(instance, ...body.args);

        return { result };
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

const directoryCommandDefinitions: CommandDefinitions = {
    [DirectoryCommandAction.UPDATE]: {
        requiredKeys: ['data'],
        handler: async (payload, ctx) => {
            await ctx.operations.updateDirectory(ctx.directoryId, payload.data);
        },
    },
    [DirectoryCommandAction.UPDATE_GENERATE_STATUS]: {
        requiredKeys: ['status'],
        handler: async (payload, ctx) => {
            await ctx.operations.updateGenerateStatus(ctx.directoryId, payload.status);
        },
    },
    [DirectoryCommandAction.UPDATE_LAST_PULL_REQUEST]: {
        requiredKeys: ['lastPullRequest'],
        handler: async (payload, ctx) => {
            await ctx.operations.updateLastPullRequest(ctx.directoryId, payload.lastPullRequest);
        },
    },
    [DirectoryCommandAction.RECORD_GENERATION_START]: {
        requiredKeys: ['startedAt'],
        handler: async (payload, ctx) => {
            const date = payload.startedAt ? new Date(payload.startedAt) : new Date();

            if (Number.isNaN(date.getTime())) {
                throw new BadRequestException('Invalid generation start timestamp');
            }

            await ctx.operations.recordGenerationStartTime(ctx.directoryId, date);
        },
    },
    [DirectoryCommandAction.RECORD_GENERATION_FINISH]: {
        requiredKeys: ['finishedAt'],
        handler: async (payload, ctx) => {
            const date = payload.finishedAt ? new Date(payload.finishedAt) : new Date();

            if (Number.isNaN(date.getTime())) {
                throw new BadRequestException('Invalid generation finish timestamp');
            }

            await ctx.operations.recordGenerationFinishTime(ctx.directoryId, date);
        },
    },
    [DirectoryCommandAction.EMIT_GENERATION_COMPLETED]: {
        requiredKeys: [],
        handler: async (_payload, ctx) => {
            await ctx.operations.emitGenerationCompleted(ctx.directory);
        },
    },
    [DirectoryCommandAction.UPDATE_GENERATION_HISTORY]: {
        requiredKeys: ['historyId', 'updates'],
        handler: async (payload, ctx) => {
            if (!payload.historyId) {
                throw new BadRequestException('Missing historyId for generation history update');
            }

            const updates = { ...payload.updates } as GenerationHistoryUpdateInput;

            if (updates.startedAt && typeof updates.startedAt === 'string') {
                updates.startedAt = new Date(updates.startedAt);
            }

            if (updates.finishedAt && typeof updates.finishedAt === 'string') {
                updates.finishedAt = new Date(updates.finishedAt);
            }

            await ctx.operations.updateGenerationHistory(
                ctx.directoryId,
                payload.historyId,
                updates,
            );
        },
    },
};

function getCommandDefinition<K extends DirectoryCommandAction>(
    action: K,
): DirectoryCommandDefinition<K> {
    return directoryCommandDefinitions[action];
}

function ensurePayload<K extends DirectoryCommandAction>(
    payload: DirectoryCommandDto['payload'],
    definition: DirectoryCommandDefinition<K>,
    action: K,
): DirectoryCommandPayloads[K] {
    if (!payload || typeof payload !== 'object') {
        throw new BadRequestException(`Invalid payload for command ${action}`);
    }

    for (const key of definition.requiredKeys) {
        if (!(key in payload)) {
            throw new BadRequestException(`Missing '${String(key)}' for command ${action}`);
        }
    }

    return payload as DirectoryCommandPayloads[K];
}
