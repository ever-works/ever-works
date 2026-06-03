import { CreateItemsGeneratorDto } from '@src/items-generator/dto';
import type { Work } from '@src/entities/work.entity';
import type { User } from '@src/entities/user.entity';

export const WORK_GENERATION_MODE = {
    CREATE: 'create',
    UPDATE: 'update',
} as const;

export type WorkGenerationMode = (typeof WORK_GENERATION_MODE)[keyof typeof WORK_GENERATION_MODE];

// Security (info-leak): pin this DTO to an explicit allow-list instead of
// `Omit<User, 'password'>`. The old type still structurally exposed token
// fields (passwordResetToken, magicLinkToken, emailVerificationToken),
// lastLoginIp, isPlatformAdmin, inferredInterests, etc. on the object sent to
// the Trigger.dev worker. The runtime producer (`stripSensitiveUserData` in
// trigger-internal.controller.ts) already projects exactly these fields; this
// keeps the type and the runtime serializer in agreement so any future call
// site that reads a sensitive field is a compile error.
export type WorkContextUserDto = Pick<
    User,
    | 'id'
    | 'email'
    | 'username'
    | 'avatar'
    | 'emailVerified'
    | 'isActive'
    | 'registrationProvider'
    | 'isAnonymous'
    | 'committerName'
    | 'committerEmail'
>;

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
