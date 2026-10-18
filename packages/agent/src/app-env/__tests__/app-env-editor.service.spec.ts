import type { AppEnvEntryView, AppSpec } from '@ever-works/contracts';
import {
    AppEnvEditorRefusal,
    AppEnvEditorService,
    declaredNames,
    readValues,
    toVariableView,
} from '../app-env-editor.service';
import type { AppEnvService, AppEnvSpecSource } from '../app-env.service';

/**
 * Lane aw-env-smtp (2026-10-18) — `AppEnvEditorService`, what `GET` / `PUT /api/works/:id/app-env` do.
 *
 * The write itself is `AppEnvService.apply`'s (its own spec covers validation, ceilings, Activity and
 * the event); this spec pins the HTTP-shaped decisions: the merge patch's set/unset split, the whole-
 * request refusal of an undeclared name BEFORE anything is written, and a read that carries `set` /
 * `masked` / `dependency` / `editable` and never a secret value.
 */

const WORK = '5a07fa3f-367a-444e-9d1e-311d03cc1327';
const ACTOR = { userId: 'u-1', canEdit: true };
const SECRET = 'never-on-the-wire-3141';

const SPEC: AppSpec = {
    kind: 'app',
    appSpecVersion: 1,
    dependencies: { postgres: {}, smtp: { required: true } },
    env: [
        { name: 'DATABASE_URL', secret: true, from: 'deps.postgres.url' },
        { name: 'SMTP_HOST', from: 'deps.smtp.host' },
        { name: 'SMTP_PASSWORD', secret: true, from: 'deps.smtp.password' },
        { name: 'FIXTURE_MARKER', prompt: { description: 'Any text', required: true } },
        { name: 'FIXTURE_MAIL_TO', prompt: { description: 'Address', required: true } },
        { name: 'SESSION', secret: true, generate: { kind: 'chars', length: 32, rotate: 'never' } },
        { name: 'SIGNING_KEY', secret: true, generate: { kind: 'keypair', rotate: 'never' } },
    ] as AppSpec['env'],
};

function view(overrides: Partial<AppEnvEntryView>): AppEnvEntryView {
    return {
        name: 'X',
        declared: true,
        source: 'prompt',
        origin: null,
        overrides: null,
        secret: false,
        phase: 'runtime',
        required: false,
        set: false,
        description: null,
        group: null,
        reference: null,
        specValue: null,
        validation: null,
        generator: null,
        generatorChanged: false,
        publicPrefixWarning: false,
        publicValue: null,
        changedSinceBuild: false,
        changedSinceDeploy: false,
        updatedAt: null,
        updatedBy: null,
        ...overrides,
    };
}

const TABLE: AppEnvEntryView[] = [
    view({ name: 'FIXTURE_MARKER', source: 'prompt', required: true }),
    view({ name: 'DATABASE_URL', source: 'from', secret: true, reference: 'deps.postgres.url' }),
    view({ name: 'SMTP_HOST', source: 'from', reference: 'deps.smtp.host' }),
    view({ name: 'SESSION', source: 'generate', secret: true, set: true, origin: 'generated' }),
    view({ name: 'SIGNING_KEY_PUBLIC', source: 'generate', origin: 'derived', publicValue: 'PUB' }),
];

function harness(options: { spec?: AppSpec | null; apply?: jest.Mock } = {}) {
    const apply =
        options.apply ??
        jest.fn(
            async (
                _work: string,
                _actor: unknown,
                input: { set?: { name: string }[]; unset?: string[] },
            ) => ({
                workId: WORK,
                results: [
                    ...(input.set ?? []).map((item) => ({
                        name: item.name,
                        line: null,
                        action: 'set',
                        code: null,
                        message: null,
                        version: 1,
                    })),
                    ...(input.unset ?? []).map((name) => ({
                        name,
                        line: null,
                        action: 'unset',
                        code: null,
                        message: null,
                        version: null,
                    })),
                ],
                warnings: [],
                changed: [...(input.set ?? []).map((item) => item.name), ...(input.unset ?? [])],
                activityRecorded: true,
            }),
        );
    const env = {
        list: jest.fn(async () => TABLE),
        apply,
        isSecureStorageAvailable: jest.fn(() => true),
    } as unknown as AppEnvService & { list: jest.Mock; apply: jest.Mock };
    const spec: AppEnvSpecSource = {
        read: jest.fn(async () =>
            options.spec === null
                ? null
                : { spec: options.spec ?? SPEC, specHash: 'h', commitSha: 'c' },
        ),
    };
    return { env, spec, editor: new AppEnvEditorService(env, spec) };
}

describe('AppEnvEditorService — GET (describe)', () => {
    it('answers the table with set / masked / dependency / editable, and the summary', async () => {
        const { editor } = harness();
        const answer = await editor.describe(WORK, ACTOR);

        expect(answer.workId).toBe(WORK);
        expect(answer.secureStorage).toBe(true);
        expect(answer.canEdit).toBe(true);
        expect(answer.summary).toEqual({
            total: 5,
            set: 1,
            missingRequired: 1,
            missingRequiredBuild: 0,
        });

        const byName = Object.fromEntries(answer.entries.map((entry) => [entry.name, entry]));
        expect(byName.DATABASE_URL).toMatchObject({
            masked: true,
            dependency: { kind: 'postgres', output: 'url' },
            editable: true,
        });
        expect(byName.SMTP_HOST.dependency).toEqual({ kind: 'smtp', output: 'host' });
        expect(byName.FIXTURE_MARKER).toMatchObject({
            masked: false,
            dependency: null,
            editable: true,
        });
        // A generated value and a keypair's public half are never typed in.
        expect(byName.SESSION.editable).toBe(false);
        expect(byName.SIGNING_KEY_PUBLIC.editable).toBe(false);
    });

    it('marks nothing editable for a viewer', async () => {
        const { editor } = harness();
        const answer = await editor.describe(WORK, { userId: 'u-2', canEdit: false });
        expect(answer.canEdit).toBe(false);
        expect(answer.entries.every((entry) => entry.editable === false)).toBe(true);
    });
});

describe('AppEnvEditorService — PUT (patch)', () => {
    it('splits the merge patch into set (string) and unset (null), as the actor', async () => {
        const { editor, env } = harness();
        const answer = await editor.patch(WORK, ACTOR, {
            values: {
                FIXTURE_MARKER: 'run-42',
                FIXTURE_MAIL_TO: 'lane@example.test',
                SMTP_HOST: null,
            },
        });

        expect(env.apply).toHaveBeenCalledTimes(1);
        expect(env.apply).toHaveBeenCalledWith(WORK, ACTOR, {
            set: [
                { name: 'FIXTURE_MARKER', value: 'run-42' },
                { name: 'FIXTURE_MAIL_TO', value: 'lane@example.test' },
            ],
            unset: ['SMTP_HOST'],
        });
        expect(answer.changed).toEqual(['FIXTURE_MARKER', 'FIXTURE_MAIL_TO', 'SMTP_HOST']);
        expect(answer.activityRecorded).toBe(true);
        expect(answer.entries.length).toBe(TABLE.length);
    });

    it('never echoes a value, even a secret one it just stored', async () => {
        const { editor } = harness();
        const answer = await editor.patch(WORK, ACTOR, { values: { SMTP_PASSWORD: SECRET } });
        expect(JSON.stringify(answer)).not.toContain(SECRET);
    });

    it('refuses an undeclared name with 400 before anything is written', async () => {
        const { editor, env } = harness();
        const refusal = await editor
            .patch(WORK, ACTOR, {
                values: { FIXTURE_MARKER: 'x', NOT_DECLARED: 'y', ALSO_NOT: null },
            })
            .catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(AppEnvEditorRefusal);
        expect(refusal).toMatchObject({
            code: 'undeclaredName',
            status: 400,
            names: ['NOT_DECLARED', 'ALSO_NOT'],
        });
        expect(env.apply).not.toHaveBeenCalled();
    });

    it('accepts a keypair’s implicit public-half name as declared (apply refuses it per item)', () => {
        expect(declaredNames(SPEC).has('SIGNING_KEY_PUBLIC')).toBe(true);
        expect(declaredNames(SPEC).has('SESSION_PUBLIC')).toBe(false);
    });

    it('refuses a body that is not { values: { NAME: string | null } }', async () => {
        const { editor, env } = harness();
        for (const body of [null, {}, { values: [] }, { values: 'x' }, { values: { A: 1 } }]) {
            await expect(editor.patch(WORK, ACTOR, body)).rejects.toMatchObject({
                code: 'invalidBody',
                status: 400,
            });
        }
        expect(env.apply).not.toHaveBeenCalled();
    });

    it('refuses more than the per-request ceiling', async () => {
        const { editor } = harness();
        const values = Object.fromEntries(
            Array.from({ length: 101 }, (_, index) => [`N_${index}`, 'v']),
        );
        await expect(editor.patch(WORK, ACTOR, { values })).rejects.toMatchObject({
            code: 'tooManyNames',
            status: 400,
        });
    });

    it('answers 409 specUnavailable when the App Work has no usable App spec yet', async () => {
        const { editor, env } = harness({ spec: null });
        await expect(
            editor.patch(WORK, ACTOR, { values: { FIXTURE_MARKER: 'x' } }),
        ).rejects.toMatchObject({
            code: 'specUnavailable',
            status: 409,
        });
        expect(env.apply).not.toHaveBeenCalled();
    });

    it('passes a per-name refusal through as a result, and a whole storage failure as 503', async () => {
        const refused = jest.fn(async () => ({
            workId: WORK,
            results: [
                {
                    name: 'SESSION',
                    line: null,
                    action: 'refused',
                    code: 'generatedValueUseRotate',
                    message: 'This value is generated. Rotate it to replace it.',
                    version: null,
                },
            ],
            warnings: [],
            changed: [],
            activityRecorded: false,
        }));
        const { editor } = harness({ apply: refused });
        const answer = await editor.patch(WORK, ACTOR, { values: { SESSION: 'typed' } });
        expect(answer.results).toEqual([
            {
                name: 'SESSION',
                action: 'refused',
                code: 'generatedValueUseRotate',
                message: 'This value is generated. Rotate it to replace it.',
                version: null,
            },
        ]);

        const down = jest.fn(async () => ({
            workId: WORK,
            results: [],
            warnings: [],
            changed: [],
            activityRecorded: false,
            reason: 'storeUnavailable',
        }));
        await expect(
            harness({ apply: down }).editor.patch(WORK, ACTOR, { values: { FIXTURE_MARKER: 'x' } }),
        ).rejects.toMatchObject({ code: 'storeUnavailable', status: 503 });
    });

    it('lets the 503 secureStorageUnavailable refusal of apply through untouched', async () => {
        const error = Object.assign(new Error('no key'), {
            name: 'AppEnvRefusalError',
            code: 'secureStorageUnavailable',
            status: 503,
        });
        const { editor } = harness({ apply: jest.fn().mockRejectedValue(error) });
        await expect(editor.patch(WORK, ACTOR, { values: { FIXTURE_MARKER: 'x' } })).rejects.toBe(
            error,
        );
    });
});

describe('the pure helpers', () => {
    it('readValues keeps strings and nulls, nothing else', () => {
        expect(readValues({ values: { A: 'a', B: null } })).toEqual({ A: 'a', B: null });
        expect(() => readValues({ values: { A: true } })).toThrow(AppEnvEditorRefusal);
    });

    it('toVariableView reads a dependency only off a `from:` reference', () => {
        expect(
            toVariableView(view({ source: 'template', reference: 'deps.smtp.host' }), true)
                .dependency,
        ).toBeNull();
        expect(
            toVariableView(view({ source: 'from', reference: 'domains.primary.url' }), true)
                .dependency,
        ).toBeNull();
        expect(
            toVariableView(
                view({ source: 'from', reference: 'deps.objectStorage.bucket.uploads' }),
                true,
            ).dependency,
        ).toEqual({
            kind: 'objectStorage',
            output: 'bucket.uploads',
        });
    });
});
