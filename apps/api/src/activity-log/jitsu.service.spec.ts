import { JitsuService } from './jitsu.service';

const trackMock = jest.fn();
const jitsuAnalyticsMock = jest.fn((_config: unknown) => ({ track: trackMock }));

jest.mock('@jitsu/js', () => ({
    jitsuAnalytics: (config: unknown) => jitsuAnalyticsMock(config),
}));

describe('JitsuService', () => {
    const ORIGINAL_ENV = { ...process.env };

    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.JITSU_HOST;
        delete process.env.JITSU_WRITE_KEY;
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    describe('constructor', () => {
        it('logs and disables itself when JITSU_HOST is missing', () => {
            process.env.JITSU_WRITE_KEY = 'wk';
            const service = new JitsuService();
            expect(jitsuAnalyticsMock).not.toHaveBeenCalled();
            // Internal client is null — verified through track() being a no-op.
            expect((service as any).client).toBeNull();
        });

        it('logs and disables itself when JITSU_WRITE_KEY is missing', () => {
            process.env.JITSU_HOST = 'jitsu.example.com';
            const service = new JitsuService();
            expect(jitsuAnalyticsMock).not.toHaveBeenCalled();
            expect((service as any).client).toBeNull();
        });

        it('initializes the client when both env vars are set', () => {
            process.env.JITSU_HOST = 'jitsu.example.com';
            process.env.JITSU_WRITE_KEY = 'wk-123';
            const service = new JitsuService();
            expect(jitsuAnalyticsMock).toHaveBeenCalledWith({
                host: 'jitsu.example.com',
                writeKey: 'wk-123',
            });
            expect((service as any).client).toBeDefined();
        });
    });

    describe('track', () => {
        function buildActivity(overrides: Record<string, unknown> = {}) {
            return {
                id: 'a1',
                userId: 'u1',
                workId: 'w1',
                actionType: 'GENERATION',
                action: 'generation.completed',
                status: 'completed',
                summary: 'Done',
                details: { foo: 'bar' },
                metadata: { source: 'web' },
                createdAt: new Date('2026-05-07T12:34:56.000Z'),
                ...overrides,
            } as any;
        }

        it('is a no-op when the client is disabled', async () => {
            const service = new JitsuService();
            await service.track(buildActivity());
            expect(trackMock).not.toHaveBeenCalled();
        });

        it('forwards activity fields with object metadata merged in', async () => {
            process.env.JITSU_HOST = 'jitsu.example.com';
            process.env.JITSU_WRITE_KEY = 'wk';
            const service = new JitsuService();

            await service.track(buildActivity());

            expect(trackMock).toHaveBeenCalledWith(
                'generation.completed',
                expect.objectContaining({
                    source: 'web',
                    activityId: 'a1',
                    userId: 'u1',
                    workId: 'w1',
                    actionType: 'GENERATION',
                    action: 'generation.completed',
                    status: 'completed',
                    summary: 'Done',
                    details: { foo: 'bar' },
                    createdAt: '2026-05-07T12:34:56.000Z',
                }),
            );
        });

        it('treats array metadata as an empty object (no spread of indices)', async () => {
            process.env.JITSU_HOST = 'jitsu.example.com';
            process.env.JITSU_WRITE_KEY = 'wk';
            const service = new JitsuService();

            await service.track(buildActivity({ metadata: ['a', 'b'] }));

            const payload = trackMock.mock.calls[0][1];
            expect(payload['0']).toBeUndefined();
            expect(payload['1']).toBeUndefined();
            expect(payload.activityId).toBe('a1');
        });

        it('treats null metadata as empty object', async () => {
            process.env.JITSU_HOST = 'jitsu.example.com';
            process.env.JITSU_WRITE_KEY = 'wk';
            const service = new JitsuService();

            await service.track(buildActivity({ metadata: null }));

            expect(trackMock).toHaveBeenCalledWith(
                'generation.completed',
                expect.objectContaining({ activityId: 'a1' }),
            );
        });

        it('passes workId=undefined when activity has no work', async () => {
            process.env.JITSU_HOST = 'jitsu.example.com';
            process.env.JITSU_WRITE_KEY = 'wk';
            const service = new JitsuService();

            await service.track(buildActivity({ workId: null }));

            expect(trackMock).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ workId: undefined }),
            );
        });

        it('passes details=undefined when activity has none', async () => {
            process.env.JITSU_HOST = 'jitsu.example.com';
            process.env.JITSU_WRITE_KEY = 'wk';
            const service = new JitsuService();

            await service.track(buildActivity({ details: null }));

            expect(trackMock).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ details: undefined }),
            );
        });
    });
});
