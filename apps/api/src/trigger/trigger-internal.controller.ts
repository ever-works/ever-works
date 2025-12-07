import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    Get,
    Headers,
    Param,
    Post,
    Query,
    Inject,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { config } from '@packages/agent/config';
import { DirectoryRepository } from '@packages/agent/database';
import { Directory } from '@packages/agent/entities';
import { DirectoryCommandDto } from './dto/directory-command.dto';
import { CACHE_MANAGER, Cache } from '@packages/agent/cache';
import {
    DIRECTORY_OPERATIONS,
    DirectoryOperations,
    GenerationHistoryUpdateInput,
} from '@packages/agent/directory-operations';
import { DirectoryCommandAction, DirectoryCommandPayloads } from '@packages/agent/tasks';
import { SkipThrottle } from '@nestjs/throttler';
import { CacheDto } from './dto/cache.dto';

type DirectoryContextResponse = {
    directory: Directory;
    user: any;
};

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

@SkipThrottle()
@Controller('internal/trigger')
export class TriggerInternalController {
    constructor(
        private readonly directoryRepository: DirectoryRepository,
        @Inject(DIRECTORY_OPERATIONS)
        private readonly directoryOperations: DirectoryOperations,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
    ) {}

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

        const directory = await this.directoryRepository.findById(directoryId);

        if (!directory) {
            throw new BadRequestException('Directory not found');
        }

        if (directory.userId !== userId) {
            throw new BadRequestException('Directory does not belong to provided user');
        }

        return {
            directory: this.stripRelations(directory),
            user: this.stripSensitiveUserData(directory.user),
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

    private ensureSecret(secret?: string) {
        const expectedSecret = config.trigger.getInternalSecret();

        if (!expectedSecret) {
            throw new ForbiddenException('Trigger internal secret is not configured');
        }

        if (!secret || secret !== expectedSecret) {
            throw new ForbiddenException('Invalid trigger secret');
        }
    }

    private stripSensitiveUserData(user: any) {
        if (!user) {
            return null;
        }

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
