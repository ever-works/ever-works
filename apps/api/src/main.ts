import { NestFactory } from '@nestjs/core';
import { configDotenv } from 'dotenv';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import { ApiModule } from './api.module';
import helmet from 'helmet';
import { initSentry, initPostHog } from '@ever-works/monitoring';
import { IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import { json, urlencoded } from 'express';
import { assertProductionCorsConfig } from './cors-validation';

async function bootstrap() {
    // Load environment variables from .env file
    configDotenv({ path: path.resolve(process.cwd(), '.env') });

    // Initialize Sentry and PostHog
    initSentry();
    initPostHog();

    const app = await NestFactory.create(ApiModule);

    const captureRawBody = (
        req: IncomingMessage & { rawBody?: string },
        _res: ServerResponse,
        buffer: Buffer,
    ) => {
        if (buffer.length > 0) {
            req.rawBody = buffer.toString('utf8');
        }
    };

    // M-19: keep the JSON / urlencoded body-parser limit tight (1mb default,
    // overridable via BODY_LIMIT) so a small public endpoint can't be used as
    // a memory-amplification vector — a 4 KB endpoint like `/api/telemetry/funnel`
    // used to let the parser buffer 10 MB before the controller's size check ran.
    // File uploads go through multer (which has its own limits, set in the
    // route's `FileInterceptor` options) and don't share this parser, so we
    // don't have to leave headroom for CSV/XLSX imports here.
    const bodyLimit = process.env.BODY_LIMIT || '1mb';
    app.use(json({ limit: bodyLimit, verify: captureRawBody }));
    app.use(urlencoded({ limit: bodyLimit, extended: true, verify: captureRawBody }));

    // Security configurations
    // The relaxed CSP only applies when /api/docs is actually mounted (non-production —
    // see C-09 gating below). In production the docs endpoint 404s and the default
    // helmet() CSP applies to every request.
    const docsEnabled = process.env.NODE_ENV !== 'production';
    app.use((req, res, next) => {
        if (docsEnabled && req.path.startsWith('/api/docs')) {
            return helmet({
                contentSecurityPolicy: {
                    directives: {
                        defaultSrc: ["'self'"],
                        scriptSrc: ["'self'", "'unsafe-inline'"],
                        styleSrc: ["'self'", "'unsafe-inline'"],
                        imgSrc: ["'self'", 'data:', 'https:'],
                    },
                },
            })(req, res, next);
        }
        return helmet()(req, res, next);
    });

    // CORS configuration
    // H-19: fail-fast in production if ALLOWED_ORIGINS is unset. Without this,
    // a misconfigured preview/prod deploy would silently fall back to a
    // localhost-only allow-list while still serving `credentials: true`, which
    // is both useless to real callers and a foot-gun for any future change
    // that drops the credentials flag.
    const allowedOrigins = assertProductionCorsConfig(process.env);
    app.enableCors({
        origin:
            allowedOrigins && allowedOrigins.length > 0
                ? allowedOrigins
                : ['http://localhost:3000'],
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
            'The Ever Works Platform API - Build and manage AI-powered works with automated content generation, deployment, and integrations.',
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
        .addTag('Works', 'Work management endpoints')
        .addTag('Deploy', 'Deployment endpoints')
        .addTag('AI Conversation', 'AI-powered conversation and content generation')
        .addTag('Screenshot', 'Screenshot capture and smart image preview')
        .addTag('Subscriptions', 'Subscription and billing management')
        .addTag('Notifications', 'User notifications')
        .addTag('Members', 'Work member management')
        .build();

    // C-09: never expose Swagger UI, the Scalar reference, or the OpenAPI JSON spec
    // in production. The OpenAPI document hands attackers a full inventory of public,
    // internal, and @Public()-but-secret-guarded endpoints (plus DTO shapes), which
    // materially reduces the cost of finding other bugs. Gate behind NODE_ENV.
    if (docsEnabled) {
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
    }

    await app.listen(process.env.PORT ?? 3100);
}
bootstrap();
