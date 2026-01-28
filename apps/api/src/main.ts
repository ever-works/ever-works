import { NestFactory } from '@nestjs/core';
import { configDotenv } from 'dotenv';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
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
    // Skip helmet for API docs to allow Scalar's inline scripts
    app.use((req, res, next) => {
        if (req.path.startsWith('/api/docs')) {
            return next();
        }
        return helmet()(req, res, next);
    });

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

    // OpenAPI/Swagger configuration
    const config = new DocumentBuilder()
        .setTitle('Ever Works API')
        .setDescription(
            'The Ever Works Platform API - Build and manage AI-powered directories with automated content generation, deployment, and integrations.',
        )
        .setVersion('1.0')
        .addBearerAuth(
            {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'JWT',
                name: 'Authorization',
                description: 'Enter your JWT token',
                in: 'header',
            },
            'JWT-auth',
        )
        .addTag('Health', 'API health check endpoints')
        .addTag('Auth', 'Authentication and authorization endpoints')
        .addTag('Directories', 'Directory management endpoints')
        .addTag('Deploy', 'Deployment endpoints for Vercel and other providers')
        .addTag('AI Conversation', 'AI-powered conversation and content generation')
        .addTag('Screenshot', 'Screenshot capture and smart image preview')
        .addTag('Subscriptions', 'Subscription and billing management')
        .addTag('Notifications', 'User notifications')
        .addTag('Members', 'Directory member management')
        .build();

    const document = SwaggerModule.createDocument(app, config);

    // Serve OpenAPI JSON spec at /api/openapi.json
    SwaggerModule.setup('api/swagger', app, document, {
        jsonDocumentUrl: '/api/openapi.json',
    });

    // Serve Scalar API Reference at /api/docs
    app.use(
        '/api/docs',
        apiReference({
            url: '/api/openapi.json',
            theme: 'kepler',
        }),
    );

    await app.listen(process.env.PORT ?? 3100);
}
bootstrap();
