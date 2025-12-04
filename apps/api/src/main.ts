import { NestFactory } from '@nestjs/core';
import { configDotenv } from 'dotenv';
import { ValidationPipe } from '@nestjs/common';
import { ApiModule } from './api.module';
import helmet from 'helmet';
import { initSentry, initPostHog } from '@packages/monitoring';
import * as path from 'path';
import { json, urlencoded } from 'express';

async function bootstrap() {
    // Load environment variables from .env file
    configDotenv({ path: path.resolve(process.cwd(), '.env') });

    // Initialize Sentry and PostHog
    initSentry();
    initPostHog();

    const app = await NestFactory.create(ApiModule);

    // Increase body-parser limit for large payloads
    app.use(json({ limit: '10mb' }));
    app.use(urlencoded({ limit: '10mb', extended: true }));

    // Security configurations
    app.use(helmet());

    // CORS configuration
    app.enableCors({
        origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    });

    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            transform: true,
            forbidNonWhitelisted: true,
        }),
    );

    await app.listen(process.env.PORT ?? 3100);
}
bootstrap();
