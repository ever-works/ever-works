jest.mock('@ever-works/agent/services', () => ({ ZeroFrictionFunnelService: class {} }));

import { BadRequestException } from '@nestjs/common';
import { TelemetryController } from './telemetry.controller';
import { FunnelEventDto } from './dto/funnel-event.dto';
import { ZERO_FRICTION_FUNNEL_EVENTS } from '@ever-works/contracts/telemetry';

/**
 * EW-617 G8 — controller-level tests for `POST /api/telemetry/funnel`.
 *
 * These tests cover only the in-controller logic (size guard, allow-list
 * guard, sink fan-out). DTO validation is exercised by NestJS's global
 * ValidationPipe in the e2e layer and isn't re-tested here.
 */
describe('TelemetryController', () => {
    const validDto = (overrides: Partial<FunnelEventDto> = {}): FunnelEventDto => ({
        event: ZERO_FRICTION_FUNNEL_EVENTS.LANDING_PROMPT_SUBMIT,
        funnelStep: 1,
        timestamp: '2026-05-15T10:00:00.000Z',
        correlationId: 'abcd1234-uuid-like-1234',
        extra: { promptLength: 42, clientKind: 'browser' },
        ...overrides,
    });

    const buildController = () => {
        const funnel = { emit: jest.fn() };
        const controller = new TelemetryController(funnel as never);
        return { controller, funnel };
    };

    it('accepts a valid event and returns 204 (no return value)', async () => {
        const { controller, funnel } = buildController();
        const result = await controller.ingestFunnelEvent(validDto(), { rawBody: '{}' });
        expect(result).toBeUndefined();
        expect(funnel.emit).toHaveBeenCalledTimes(1);
    });

    it('forwards the payload to the funnel sink with envelope + extras merged', async () => {
        const { controller, funnel } = buildController();
        await controller.ingestFunnelEvent(
            validDto({ workId: 'w-123', extra: { repos: ['o/r'] } }),
            { rawBody: '{}' },
        );
        const arg = funnel.emit.mock.calls[0][0];
        expect(arg.event).toBe(ZERO_FRICTION_FUNNEL_EVENTS.LANDING_PROMPT_SUBMIT);
        expect(arg.funnelStep).toBe(1);
        expect(arg.correlationId).toBe('abcd1234-uuid-like-1234');
        expect(arg.workId).toBe('w-123');
        expect(arg.repos).toEqual(['o/r']);
    });

    it('rejects an unknown event name with 400', async () => {
        const { controller, funnel } = buildController();
        await expect(
            controller.ingestFunnelEvent(
                validDto({ event: 'zero_friction.totally_fake' as never }),
                { rawBody: '{}' },
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(funnel.emit).not.toHaveBeenCalled();
    });

    it('rejects an oversized payload (>4KB rawBody) with 400', async () => {
        const { controller, funnel } = buildController();
        const huge = 'x'.repeat(5 * 1024);
        await expect(
            controller.ingestFunnelEvent(validDto(), { rawBody: huge }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(funnel.emit).not.toHaveBeenCalled();
    });

    it('calls funnel.emit exactly once per accepted request', async () => {
        const { controller, funnel } = buildController();
        await controller.ingestFunnelEvent(validDto(), { rawBody: '{}' });
        await controller.ingestFunnelEvent(
            validDto({
                event: ZERO_FRICTION_FUNNEL_EVENTS.CLAIM_ACCOUNT,
                funnelStep: 8,
                correlationId: 'aaaaaaaa-bbbb-cccc-dddd',
            }),
            { rawBody: '{}' },
        );
        expect(funnel.emit).toHaveBeenCalledTimes(2);
    });
});
