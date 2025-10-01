import { Module, Global } from '@nestjs/common';
import { SentryConfig } from '../types';
import { initSentry } from './sentry.config';

@Global()
@Module({})
export class SentryModule {
    static forRoot(config?: SentryConfig) {
        const isInitialized = initSentry(config);
        
        return {
            module: SentryModule,
            global: true,
            providers: [
                {
                    provide: 'SENTRY_INITIALIZED',
                    useValue: isInitialized,
                },
            ],
            exports: ['SENTRY_INITIALIZED'],
        };
    }
}
