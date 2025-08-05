import { NestFactory } from '@nestjs/core';
import { configDotenv } from 'dotenv';
import { ValidationPipe } from '@nestjs/common';
import { ApiModule } from './api.module';
import helmet from 'helmet';
import { LoggingInterceptor } from './logging.interceptor';

async function bootstrap() {
    configDotenv();

    const app = await NestFactory.create(ApiModule);

    // Apply logging interceptor
    app.useGlobalInterceptors(new LoggingInterceptor());

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
