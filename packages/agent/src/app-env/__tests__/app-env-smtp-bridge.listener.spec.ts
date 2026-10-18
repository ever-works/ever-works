import { Logger } from '@nestjs/common';
import type { AppSpec } from '@ever-works/contracts';
import { AppEnvChangedEvent } from '../../events/app-env.events';
import { AppEnvSmtpBridgeListener, smtpBoundNames } from '../app-env-smtp-bridge.listener';

/**
 * Lane aw-env-smtp (GAP-22) — an owner's own `SMTP_*` App env values become the `smtp` dependency's
 * configuration, so `k8s-inline-mailpit` answers them as the outputs without provisioning anything.
 */
describe('AppEnvSmtpBridgeListener', () => {
    const WORK = '5a07fa3f-367a-444e-9d1e-311d03cc1327';

    const SPEC: AppSpec = {
        kind: 'app',
        appSpecVersion: 1,
        dependencies: { postgres: {}, smtp: { required: true } },
        env: [
            { name: 'DATABASE_URL', secret: true, from: 'deps.postgres.url' },
            { name: 'SMTP_HOST', from: 'deps.smtp.host' },
            { name: 'SMTP_PORT', from: 'deps.smtp.port' },
            { name: 'SMTP_USER', secret: true, from: 'deps.smtp.user' },
            { name: 'SMTP_PASSWORD', secret: true, from: 'deps.smtp.password' },
            { name: 'SMTP_FROM', from: 'deps.smtp.from' },
            { name: 'MAIL_HOST_COPY', from: 'deps.smtp.host' },
            { name: 'FIXTURE_MARKER', prompt: { required: true } },
        ] as AppSpec['env'],
    };

    beforeEach(() => {
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    function harness(stored: Record<string, string>, spec: AppSpec | null = SPEC) {
        const configure = jest.fn().mockResolvedValue(null);
        const readStoredValuesOf = jest.fn(async (_work: string, names: readonly string[]) =>
            Object.fromEntries(
                names.filter((name) => name in stored).map((name) => [name, stored[name]]),
            ),
        );
        const listener = new AppEnvSmtpBridgeListener(
            { configure } as never,
            { readStoredValuesOf } as never,
            { read: async () => (spec ? { spec, specHash: 'h', commitSha: 'c' } : null) },
        );
        return { listener, configure, readStoredValuesOf };
    }

    function changed(names: string[]): AppEnvChangedEvent {
        return new AppEnvChangedEvent({
            workId: WORK,
            names,
            buildPhaseNames: [],
            runtimePhaseNames: names,
        });
    }

    it('maps the owner’s deps.smtp.*-bound values onto the dependency configuration', async () => {
        const { listener, configure, readStoredValuesOf } = harness({
            SMTP_HOST: 'smtp.example.com',
            SMTP_PORT: '465',
            SMTP_USER: 'mailer@example.com',
            SMTP_PASSWORD: 'byo-secret',
            SMTP_FROM: 'App <app@example.com>',
        });

        await listener.onEnvChanged(changed(['SMTP_HOST', 'SMTP_PASSWORD']));

        expect(readStoredValuesOf).toHaveBeenCalledWith(WORK, [
            'SMTP_HOST',
            'SMTP_PORT',
            'SMTP_USER',
            'SMTP_PASSWORD',
            'SMTP_FROM',
        ]);
        expect(configure).toHaveBeenCalledWith(WORK, 'smtp', {
            config: {
                host: 'smtp.example.com',
                port: '465',
                user: 'mailer@example.com',
                password: 'byo-secret',
                from: 'App <app@example.com>',
            },
        });
    });

    it('sends an empty configuration (back to the mail sink) when no host of the owner’s own remains', async () => {
        const { listener, configure } = harness({ SMTP_FROM: 'App <app@example.com>' });
        await listener.onEnvChanged(changed(['SMTP_HOST']));
        expect(configure).toHaveBeenCalledWith(WORK, 'smtp', { config: {} });
    });

    it('does nothing for a change that touches no deps.smtp.*-bound name', async () => {
        const { listener, configure, readStoredValuesOf } = harness({
            SMTP_HOST: 'smtp.example.com',
        });
        await listener.onEnvChanged(changed(['FIXTURE_MARKER', 'DATABASE_URL']));
        expect(readStoredValuesOf).not.toHaveBeenCalled();
        expect(configure).not.toHaveBeenCalled();
    });

    it('does nothing for an App spec without an smtp dependency, or without a spec', async () => {
        const noSmtp = { ...SPEC, dependencies: { postgres: {} } } as AppSpec;
        const first = harness({ SMTP_HOST: 'h' }, noSmtp);
        await first.listener.onEnvChanged(changed(['SMTP_HOST']));
        expect(first.configure).not.toHaveBeenCalled();

        const second = harness({ SMTP_HOST: 'h' }, null);
        await second.listener.onEnvChanged(changed(['SMTP_HOST']));
        expect(second.configure).not.toHaveBeenCalled();
    });

    it('never throws into the env write that emitted the event, and logs no value', async () => {
        const { listener, configure } = harness({
            SMTP_HOST: 'smtp.example.com',
            SMTP_PASSWORD: 'p4ss',
        });
        configure.mockRejectedValue(
            Object.assign(new Error('p4ss'), { name: 'AppDependencyRefusalError' }),
        );
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        await expect(listener.onEnvChanged(changed(['SMTP_HOST']))).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).not.toContain('p4ss');
        expect(String(warn.mock.calls[0][0])).toContain('AppDependencyRefusalError');
    });

    it('binds the first name of each output, and only the six smtp outputs', () => {
        expect(
            smtpBoundNames([
                { name: 'A', from: 'deps.smtp.host' },
                { name: 'B', from: 'deps.smtp.host' },
                { name: 'C', from: 'deps.smtp.nonsense' },
                { name: 'D', from: 'deps.postgres.host' },
                { name: 'E', from: 'platform.smtp.host' },
                { name: 'F', from: 'deps.smtp.secure' },
            ]),
        ).toEqual({ host: 'A', secure: 'F' });
    });
});
