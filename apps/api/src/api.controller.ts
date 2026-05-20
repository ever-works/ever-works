import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from './auth';
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
}
