import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from './auth';
import { config } from './config/constants';
import { AnalyticsService } from '@ever-works/monitoring';

// Tight CSP for JSON-only API endpoints. Even though JSON responses
// can't execute script, the csp-strict e2e contract pins that EVERY
// API surface declares a CSP — defence-in-depth against an attacker
// who finds a way to coerce the API into returning HTML (mis-set
// Content-Type, error template leak, etc.). `default-src 'none'`
// blocks every fetch class; `frame-ancestors 'none'` blocks
// clickjacking. The wildcard helmet middleware in main.ts SHOULD
// also set a CSP, but on some Node 22 + Express paths the header
// gets dropped before NestJS serialises the JSON response — so the
// per-handler `@Header` is the belt-and-braces guarantee.
const API_JSON_CSP =
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

@ApiTags('Health')
@Controller()
export class APIController {
    constructor(private readonly analyticsService: AnalyticsService) {}

    @Public()
    @Get()
    @Header('Content-Security-Policy', API_JSON_CSP)
    @ApiOperation({ summary: 'API home', description: 'Check if the API is running' })
    @ApiResponse({ status: 200, description: 'API is running' })
    home() {
        // Track API usage for analytics
        this.analyticsService.track('anonymous', 'api_home_visit', {
            endpoint: '/',
            timestamp: new Date().toISOString(),
        });

        return { status: 'success', message: 'API is up and running' };
    }

    @Public()
    @Get('api/health')
    @Header('Content-Security-Policy', API_JSON_CSP)
    @ApiOperation({ summary: 'Health check', description: 'Check API health status' })
    @ApiResponse({ status: 200, description: 'API is healthy' })
    healthCheck() {
        // Health check endpoints are filtered from Sentry and PostHog
        // to avoid noise in monitoring
        return this.home();
    }

    /**
     * Public runtime configuration.
     *
     * Exposes a STRICT ALLOW-LIST of build-time flags + branding + feature
     * gates that the unauthenticated web client (or any third-party
     * embedder) needs at boot. We hand-pick the keys — every entry below
     * is reviewed for "is this safe to publish to anyone in the world?".
     * Server secrets (DATABASE_URL, AUTH_SECRET, OAuth secrets, Stripe
     * keys) are NEVER read into this shape; the e2e contract pins that.
     *
     * The shape is stable across calls (same keys, possibly different
     * values for time-windowed flags). Authenticated users get the
     * same keys — this endpoint is identical for everyone. If we ever
     * need per-user feature flags they will move to a separate
     * `/api/me/flags` endpoint so the public surface stays cache-friendly.
     */
    @Public()
    @Get('api/config')
    @Header('Content-Security-Policy', API_JSON_CSP)
    @Header('Cache-Control', 'public, max-age=60')
    @ApiOperation({
        summary: 'Public runtime configuration',
        description:
            'Hand-picked allow-list of public flags + branding. Safe to call without auth; intentionally cache-friendly.',
    })
    @ApiResponse({ status: 200, description: 'Public config' })
    getConfig() {
        // Strict allow-list. Every field MUST be safe to publish to an
        // anonymous attacker. Coerce env booleans here so the response
        // shape stays typed even when the value is missing.
        const truthy = (v: string | undefined) => v === 'true' || v === '1' || v === 'yes';
        return {
            app: {
                name: config.branding.appName(),
                description:
                    process.env.NEXT_PUBLIC_SITE_DESCRIPTION ||
                    process.env.APP_DESCRIPTION ||
                    'Ever Works platform',
            },
            features: {
                subscriptionsEnabled: truthy(process.env.SUBSCRIPTIONS_ENABLED),
                magicLinkEnabled: truthy(process.env.MAGIC_LINK_ENABLED),
                anonymousAuthEnabled: truthy(process.env.ANONYMOUS_AUTH_ENABLED),
                emailVerificationRequired: process.env.REQUIRE_EMAIL_VERIFICATION !== 'false',
            },
            auth: {
                providers: {
                    github: !!process.env.GH_CLIENT_ID,
                    google: !!process.env.GOOGLE_CLIENT_ID,
                    facebook: !!process.env.FB_CLIENT_ID,
                },
            },
            limits: {
                bodyLimit: process.env.BODY_LIMIT || '1mb',
            },
        };
    }
}
