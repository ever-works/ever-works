import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from './auth';
import { AnalyticsService } from '@ever-works/monitoring';

@ApiTags('Health')
@Controller()
export class APIController {
    constructor(private readonly analyticsService: AnalyticsService) {}

    @Public()
    @Get()
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
    @ApiOperation({ summary: 'Health check', description: 'Check API health status' })
    @ApiResponse({ status: 200, description: 'API is healthy' })
    healthCheck() {
        // Health check endpoints are filtered from Sentry and PostHog
        // to avoid noise in monitoring
        return this.home();
    }
}
