import { ThrottlerModuleOptions } from '@nestjs/throttler';

export const throttlerConfig: ThrottlerModuleOptions = {
    throttlers: [
        {
            name: 'short',
            ttl: 1000,
            limit: 50,
        },
        {
            name: 'medium',
            ttl: 10000,
            limit: 300,
        },
        {
            name: 'long',
            ttl: 60000,
            limit: 1000,
        },
    ],
};
