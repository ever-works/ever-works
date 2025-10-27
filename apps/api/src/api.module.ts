import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { throttlerConfig } from './config/throttler.config';
import { DirectoriesModule } from './directories/directories.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MailModule } from './mail/mail.module';
import { LoggingInterceptor } from './logging.interceptor';
import { MonitoringModule, SentryInterceptor, PostHogInterceptor } from '@packages/monitoring';
import { APIController } from './api.controller';
import { AiConversationModule } from './ai-conversation/ai-conversation.module';

@Module({
    imports: [
        ThrottlerModule.forRoot(throttlerConfig),
        EventEmitterModule.forRoot(),
        MonitoringModule.forRoot({
            sentry: {
                dsn: process.env.SENTRY_DSN,
                environment: process.env.NODE_ENV || 'development',
            },
            posthog: {
                apiKey: process.env.POSTHOG_API_KEY,
                host: process.env.POSTHOG_HOST || 'https://app.posthog.com',
            },
        }),
        AuthModule,
        AiConversationModule,
        DirectoriesModule,
        MailModule,
    ],
    providers: [
        {
            provide: APP_GUARD,
            useClass: JwtAuthGuard,
        },
        {
            provide: APP_GUARD,
            useClass: ThrottlerGuard,
        },
        {
            provide: APP_INTERCEPTOR,
            useClass: LoggingInterceptor,
        },
        {
            provide: APP_INTERCEPTOR,
            useClass: SentryInterceptor,
        },
        {
            provide: APP_INTERCEPTOR,
            useClass: PostHogInterceptor,
        },
    ],
    controllers: [APIController],
})
export class ApiModule {}
