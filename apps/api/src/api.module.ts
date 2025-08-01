import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { throttlerConfig } from './config/throttler.config';

@Module({
    imports: [ThrottlerModule.forRoot(throttlerConfig), AuthModule],
    providers: [
        {
            provide: APP_GUARD,
            useClass: JwtAuthGuard,
        },
        {
            provide: APP_GUARD,
            useClass: ThrottlerGuard,
        },
    ],
})
export class ApiModule {}
