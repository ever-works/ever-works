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
import { DIRECTORY_OPERATIONS, DirectoryOperations } from '@packages/agent/directory';
import { DirectoryCommandAction } from '@packages/agent/trigger';

type DirectoryContextResponse = {
    directory: Directory;
    user: any;
};

@Controller('internal/trigger')
export class TriggerInternalController {
    constructor(
        private readonly directoryRepository: DirectoryRepository,
        @Inject(DIRECTORY_OPERATIONS)
        private readonly directoryOperations: DirectoryOperations,
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

        switch (command.action) {
            case DirectoryCommandAction.UPDATE:
                await this.directoryOperations.updateDirectory(
                    directoryId,
                    (command.payload as any)?.data ?? {},
                );
                break;
            case DirectoryCommandAction.UPDATE_GENERATE_STATUS:
                await this.directoryOperations.updateGenerateStatus(
                    directoryId,
                    (command.payload as any)?.status,
                );
                break;
            case DirectoryCommandAction.UPDATE_LAST_PULL_REQUEST:
                await this.directoryOperations.updateLastPullRequest(
                    directoryId,
                    (command.payload as any)?.lastPullRequest,
                );
                break;
            case DirectoryCommandAction.RECORD_GENERATION_START:
                await this.directoryOperations.recordGenerationStartTime(
                    directoryId,
                    new Date((command.payload as any)?.startedAt ?? new Date().toISOString()),
                );
                break;
            case DirectoryCommandAction.RECORD_GENERATION_FINISH:
                await this.directoryOperations.recordGenerationFinishTime(
                    directoryId,
                    new Date((command.payload as any)?.finishedAt ?? new Date().toISOString()),
                );
                break;
            case DirectoryCommandAction.EMIT_GENERATION_COMPLETED: {
                await this.directoryOperations.emitGenerationCompleted(directory);
                break;
            }
            default:
                throw new BadRequestException('Unknown directory command');
        }

        return { status: 'ok' };
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
