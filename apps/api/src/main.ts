import { NestFactory } from '@nestjs/core';
import { configDotenv } from 'dotenv';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { apiReference } from '@scalar/nestjs-api-reference';
import { ApiModule } from './api.module';
import { buildOpenApiConfig } from './openapi/openapi-document.config';
import helmet from 'helmet';
import { initSentry, initPostHog, PostHogLoggerService } from '@ever-works/monitoring';
import { IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import { json, urlencoded } from 'express';
import { assertProductionCorsConfig } from './cors-validation';
import { config as appConfig } from './config/constants';
import { resolveTrustProxyHops } from './config/trust-proxy';

async function bootstrap() {
    // Load environment variables from .env file
    configDotenv({ path: path.resolve(process.cwd(), '.env') });

    // H-14: fail fast on a misconfigured AUTH_SECRET (missing or shorter
    // than 32 chars). The web tier's `setAuthAccessCookie` will refuse to
    // seal cookies with a short secret, so without this check the API
    // boots clean and the misconfiguration only surfaces mid-OAuth-callback
    // as an opaque "Authentication Error" (see 2026-05-18 incident).
    // Aliased to `appConfig` because `bootstrap()` also declares a local
    // `const config` for Swagger.
    appConfig.auth.secret();

    // #21: fail fast on a missing PLATFORM_ENCRYPTION_KEY in non-local
    // environments. It is the master key used to encrypt operator-supplied
    // secrets at rest; without this check a misconfigured prod/staging deploy
    // boots clean and the gap only surfaces deep inside a request (plaintext
    // secrets or an opaque encrypt/decrypt failure). Local dev/test runs are
    // exempt (see the validator in config/constants.ts).
    appConfig.platformEncryptionKey();

    // Initialize Sentry and PostHog
    initSentry();
    initPostHog();

    const app = await NestFactory.create<NestExpressApplication>(ApiModule);

    // Forward every NestJS Logger emit (log/warn/error/debug/verbose) to
    // PostHog Logs as a `$log` event while still writing to stdout. The
    // PostHogLoggerService fails open — without POSTHOG_API_KEY it degrades
    // to the default NestJS console logger (no PostHog traffic, no errors).
    app.useLogger(new PostHogLoggerService());

    // EW-719: the API sits behind an nginx ingress. Without an explicit
    // `trust proxy`, Express treats the ingress socket address as `req.ip` for
    // every request, which collapses the per-IP rate limiter
    // (UserAwareThrottlerGuard.getTracker) into a single pod-wide bucket.
    // Trust the configured number of proxy hops (TRUST_PROXY_HOPS, default 1 for
    // the standard nginx → pod topology) so Express resolves the real client IP
    // from X-Forwarded-For. The hop count is sanitised (garbage → default,
    // negatives → 0) so an operator typo can't widen trust to a spoofable header.
    app.set('trust proxy', resolveTrustProxyHops(process.env));

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
    //
    // Security (M-19 follow-up): BODY_LIMIT is operator-supplied, so it must not
    // be passed verbatim to the parser. A typo like `BODY_LIMIT=512mb` would
    // silently re-arm the memory-amplification vector this limit exists to close
    // (an anonymous attacker could then make the parser buffer hundreds of MB per
    // connection). Parse the value and reject anything above a hard cap, falling
    // back to the safe default. Legitimate values (`1mb`, `2mb`, `5mb`, …) are
    // well under the cap and pass through unchanged.
    const DEFAULT_BODY_LIMIT = '1mb';
    const MAX_BODY_LIMIT_BYTES = 10 * 1024 * 1024; // 10mb hard ceiling
    const parseByteSize = (value: string): number | null => {
        const trimmed = value.trim().toLowerCase();
        // Accept an optional unit suffix (b/kb/mb/gb) or a bare byte count.
        const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/.exec(trimmed);
        if (!match) return null;
        const amount = Number(match[1]);
        if (!Number.isFinite(amount)) return null;
        const unit = match[2] ?? 'b';
        const multiplier =
            unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1;
        return amount * multiplier;
    };
    const requestedBodyLimit = process.env.BODY_LIMIT;
    let bodyLimit = DEFAULT_BODY_LIMIT;
    if (requestedBodyLimit) {
        const parsed = parseByteSize(requestedBodyLimit);
        if (parsed === null || parsed > MAX_BODY_LIMIT_BYTES) {
            // eslint-disable-next-line no-console
            console.warn(
                `[bootstrap] BODY_LIMIT="${requestedBodyLimit}" is invalid or exceeds the ${MAX_BODY_LIMIT_BYTES}-byte cap; falling back to ${DEFAULT_BODY_LIMIT}.`,
            );
        } else {
            bodyLimit = requestedBodyLimit;
        }
    }
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
    const effectiveOrigins =
        allowedOrigins && allowedOrigins.length > 0 ? allowedOrigins : ['http://localhost:3000'];
    // H-19 follow-up: use a callback so we only echo `Access-Control-Allow-
    // Origin` (and let cors set `Access-Control-Allow-Credentials`) when the
    // request origin is on the allowlist. Passing `origin` as a static array
    // makes the cors package still emit `ACAC: true` for evil origins (with
    // an empty ACAO) — that's the exact cache-poisoning shape the
    // cors-origin-allowlist e2e contract is meant to catch.
    app.enableCors({
        origin: (
            origin: string | undefined,
            callback: (err: Error | null, allow?: boolean) => void,
        ) => {
            if (!origin || effectiveOrigins.includes(origin)) {
                callback(null, true);
            } else {
                callback(null, false);
            }
        },
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

    // OpenAPI/Swagger configuration (shared with the build-time
    // `generate-openapi` script that bundles the spec into the MCP image).
    const config = buildOpenApiConfig();

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
