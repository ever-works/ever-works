import { Module, Global } from '@nestjs/common';
import { PostHogConfig } from '../types';
import { initPostHog } from './posthog.config';

@Global()
@Module({})
export class PostHogModule {
    static forRoot(config?: PostHogConfig) {
        const isInitialized = initPostHog(config);

        return {
            module: PostHogModule,
            global: true,
            providers: [
                {
                    provide: 'POSTHOG_INITIALIZED',
                    useValue: isInitialized,
                },
            ],
            exports: ['POSTHOG_INITIALIZED'],
        };
    }
}
