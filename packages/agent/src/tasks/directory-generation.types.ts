import { CreateItemsGeneratorDto } from '@src/items-generator/dto';

export const DIRECTORY_GENERATION_MODE = {
    CREATE: 'create',
    UPDATE: 'update',
} as const;

export type DirectoryGenerationMode =
    (typeof DIRECTORY_GENERATION_MODE)[keyof typeof DIRECTORY_GENERATION_MODE];

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
