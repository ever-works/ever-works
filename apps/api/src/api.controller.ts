import { Controller, Get } from '@nestjs/common';
import { Public } from './auth';
import { AnalyticsService } from '@packages/monitoring';

@Controller()
export class APIController {
    constructor(private readonly analyticsService: AnalyticsService) {}

    @Public()
    @Get()
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
    healthCheck() {
        // Health check endpoints are filtered from Sentry and PostHog
        // to avoid noise in monitoring
        return this.home();
    }
}
