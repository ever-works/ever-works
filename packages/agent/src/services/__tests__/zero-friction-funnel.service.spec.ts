import { ZeroFrictionFunnelService } from '../zero-friction-funnel.service';
import { ZERO_FRICTION_FUNNEL_EVENTS } from '@ever-works/contracts/telemetry';

describe('ZeroFrictionFunnelService (EW-617 G8)', () => {
    let svc: ZeroFrictionFunnelService;
    let logCalls: string[];

    beforeEach(() => {
        svc = new ZeroFrictionFunnelService();
        logCalls = [];
        jest.spyOn((svc as any).logger, 'log').mockImplementation((msg: string) => {
            logCalls.push(msg);
        });
    });

    it('emits a single-line JSON log tagged [zero-friction]', () => {
        svc.emit({
            funnelStep: 2,
            event: ZERO_FRICTION_FUNNEL_EVENTS.ANON_USER_CREATED,
            correlationId: 'corr-1',
            timestamp: '2026-05-14T19:00:00.000Z',
            anonUserId: 'u-1',
            anonymousExpiresAt: '2026-05-21T19:00:00.000Z',
            ipPrefix: '1.2.3.0/24',
        });

        expect(logCalls).toHaveLength(1);
        expect(logCalls[0]).toContain('[zero-friction]');
        const json = logCalls[0].replace(/^\[zero-friction\]\s*/, '');
        const parsed = JSON.parse(json);
        expect(parsed.event).toBe('zero_friction.anon_user_created');
        expect(parsed.funnelStep).toBe(2);
        expect(parsed.correlationId).toBe('corr-1');
        expect(parsed.anonUserId).toBe('u-1');
        expect(parsed.timestamp).toBe('2026-05-14T19:00:00.000Z');
    });

    it('back-fills timestamp when the caller omits it', () => {
        const before = Date.now();
        svc.emit({
            funnelStep: 4,
            event: ZERO_FRICTION_FUNNEL_EVENTS.WORK_CREATED,
            correlationId: 'corr-9',
            timestamp: '' as any,
            userId: 'u-1',
            workId: 'w-1',
            workSlug: 'foo',
            viaQuickCreate: true,
        });
        const after = Date.now();

        const parsed = JSON.parse(logCalls[0].replace(/^\[zero-friction\]\s*/, ''));
        const ts = new Date(parsed.timestamp).getTime();
        expect(ts).toBeGreaterThanOrEqual(before - 100);
        expect(ts).toBeLessThanOrEqual(after + 100);
    });

    it('falls back to a key=value line if JSON.stringify throws', () => {
        const circular: any = { funnelStep: 1, event: 'x', correlationId: 'corr-2' };
        circular.self = circular;
        svc.emit(circular as any);
        expect(logCalls[0]).toMatch(/event=x correlationId=corr-2/);
    });
});
