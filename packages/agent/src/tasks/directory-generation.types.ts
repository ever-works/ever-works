import { CreateItemsGeneratorDto } from '@src/items-generator/dto';
import type { Directory } from '@src/entities/directory.entity';
import type { User } from '@src/entities/user.entity';

export const DIRECTORY_GENERATION_MODE = {
    CREATE: 'create',
    UPDATE: 'update',
} as const;

export type DirectoryGenerationMode =
    (typeof DIRECTORY_GENERATION_MODE)[keyof typeof DIRECTORY_GENERATION_MODE];

export type DirectoryContextUserDto = Omit<User, 'password'>;

export type DirectoryContextResponse = {
    directory: Directory;
    user: DirectoryContextUserDto;
    gitToken?: string;
};

export type DirectoryGenerationPayload = {
    directoryId: string;
    userId: string;
    mode: DirectoryGenerationMode;
    dto: CreateItemsGeneratorDto;
    historyId: string;
    historyStartedAt?: string;
    triggerSource?: 'user' | 'schedule' | 'api';
    scheduleId?: string;
};
