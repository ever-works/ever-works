import { Logger } from '@nestjs/common';
import { AppEnvPromptedValuesAdapter } from '../app-env-prompted-values.adapter';

/**
 * APW-01 FR-55 → APW-07 — the adapter behind `APP_PROMPTED_VALUES_PORT` (live e2e,
 * 2026-10-18: every `appEnv` answer given at create was dropped because nothing bound
 * the port).
 */
describe('AppEnvPromptedValuesAdapter', () => {
    const ENV = Symbol('AppEnvService');
    const WORKS = Symbol('WorkRepository');
    let warn: jest.SpyInstance;

    beforeEach(() => {
        warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => jest.restoreAllMocks());

    function adapter(graph: Map<unknown, unknown>) {
        return new AppEnvPromptedValuesAdapter({
            env: () => graph.get(ENV) as never,
            works: () => graph.get(WORKS) as never,
        });
    }

    const ok = (names: string[]) => ({
        workId: 'w-1',
        results: names.map((name) => ({ name, action: 'created', code: null })),
        warnings: [],
        changed: names,
        activityRecorded: false,
    });

    it('applies every answer through AppEnvService.apply as the creator, spec-less and prompted', async () => {
        const apply = jest.fn().mockResolvedValue(ok(['A', 'B']));
        const port = adapter(new Map<unknown, unknown>([[ENV, { apply }]]));

        await port.storePrompted('w-1', { A: 'one', B: 'two' }, { userId: 'u-1' });

        expect(apply).toHaveBeenCalledTimes(1);
        expect(apply).toHaveBeenCalledWith(
            'w-1',
            { userId: 'u-1', canEdit: true },
            {
                set: [
                    { name: 'A', value: 'one' },
                    { name: 'B', value: 'two' },
                ],
            },
            { allowWithoutSpec: true, origin: 'prompted' },
        );
    });

    it("falls back to the Work row's owner when the caller passed no actor", async () => {
        const apply = jest.fn().mockResolvedValue(ok(['A']));
        const findById = jest.fn().mockResolvedValue({ id: 'w-1', userId: 'owner-9' });
        const port = adapter(
            new Map<unknown, unknown>([
                [ENV, { apply }],
                [WORKS, { findById }],
            ]),
        );

        await port.storePrompted('w-1', { A: 'one' });

        expect(findById).toHaveBeenCalledWith('w-1');
        expect(apply.mock.calls[0][1]).toEqual({ userId: 'owner-9', canEdit: true });
    });

    it('drops the answers with a named line (never the values) when no env service is reachable', async () => {
        const port = adapter(new Map());

        await expect(
            port.storePrompted('w-1', { SECRET: 'hunter2' }, { userId: 'u-1' }),
        ).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain('dropped');
        expect(String(warn.mock.calls[0][0])).not.toContain('hunter2');
    });

    it('reports a refusal by name and code only', async () => {
        const apply = jest.fn().mockResolvedValue({
            workId: 'w-1',
            results: [{ name: 'BAD NAME', action: 'refused', code: 'invalidName' }],
            warnings: [],
            changed: [],
            activityRecorded: false,
        });
        const port = adapter(new Map<unknown, unknown>([[ENV, { apply }]]));

        await port.storePrompted('w-1', { 'BAD NAME': 'hunter2' }, { userId: 'u-1' });

        const line = String(warn.mock.calls[0][0]);
        expect(line).toContain('BAD NAME:invalidName');
        expect(line).not.toContain('hunter2');
    });

    it('does nothing for an empty answer set', async () => {
        const apply = jest.fn();
        const port = adapter(new Map<unknown, unknown>([[ENV, { apply }]]));

        await port.storePrompted('w-1', {}, { userId: 'u-1' });

        expect(apply).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });
});
