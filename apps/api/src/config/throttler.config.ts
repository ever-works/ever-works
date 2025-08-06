import { ThrottlerModuleOptions } from '@nestjs/throttler';

export const throttlerConfig: ThrottlerModuleOptions = {
    throttlers: [
        {
            name: 'short',
            ttl: 1000,
            limit: 3,
        },
        {
            name: 'medium',
            ttl: 10000,
            limit: 20,
        },
        {
            name: 'long',
            ttl: 60000,
            limit: 100,
        },
    ],
};