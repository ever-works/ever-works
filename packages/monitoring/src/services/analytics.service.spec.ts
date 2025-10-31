import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsService', () => {
    let service: AnalyticsService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [AnalyticsService],
        }).compile();

        service = module.get<AnalyticsService>(AnalyticsService);
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    it('should track events', () => {
        const spy = jest.spyOn(service, 'track');
        service.track('user123', 'test_event', { test: 'data' });
        expect(spy).toHaveBeenCalledWith('user123', 'test_event', { test: 'data' });
    });

    it('should track API usage', () => {
        const spy = jest.spyOn(service, 'track');
        service.trackApiUsage('user123', '/api/test', 'GET', 200, 100);
        expect(spy).toHaveBeenCalledWith(
            'user123',
            'api_usage',
            expect.objectContaining({
                endpoint: '/api/test',
                method: 'GET',
                statusCode: 200,
                duration: 100,
            }),
        );
    });

    it('should track auth events', () => {
        const spy = jest.spyOn(service, 'track');
        service.trackAuth('user123', 'login', { provider: 'google' });
        expect(spy).toHaveBeenCalledWith(
            'user123',
            'auth_login',
            expect.objectContaining({
                provider: 'google',
            }),
        );
    });

    it('should track business events', () => {
        const spy = jest.spyOn(service, 'track');
        service.trackBusinessEvent('user123', 'purchase', { amount: 100 });
        expect(spy).toHaveBeenCalledWith(
            'user123',
            'business_purchase',
            expect.objectContaining({
                amount: 100,
            }),
        );
    });
});
