import { CreateItemsGeneratorDto } from '@src/items-generator/dto';
import type { Work } from '@src/entities/work.entity';
import type { User } from '@src/entities/user.entity';

export const WORK_GENERATION_MODE = {
    CREATE: 'create',
    UPDATE: 'update',
} as const;

export type WorkGenerationMode = (typeof WORK_GENERATION_MODE)[keyof typeof WORK_GENERATION_MODE];

export type WorkContextUserDto = Omit<User, 'password'>;

export type WorkContextResponse = {
    work: Work;
    user: WorkContextUserDto;
    gitToken?: string;
};

export type WorkGenerationPayload = {
    workId: string;
    userId: string;
    mode: WorkGenerationMode;
    dto: CreateItemsGeneratorDto;
    historyId: string;
    historyStartedAt?: string;
    triggerSource?: 'user' | 'schedule' | 'api';
    scheduleId?: string;
};
