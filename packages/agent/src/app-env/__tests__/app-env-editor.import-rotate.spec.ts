import {
    APP_ENV_DOTENV_MAX_LINES,
    type AppEnvEntryView,
    type AppSpec,
} from '@ever-works/contracts';
import {
    AppEnvEditorRefusal,
    AppEnvEditorService,
    isImportBody,
    previewDotenv,
    readDotenvText,
    toVariableView,
} from '../app-env-editor.service';
import type { AppEnvService, AppEnvSpecSource } from '../app-env.service';

/**
 * Lane aw-ops (APW-07 T24/T28, 2026-10-27) — the Environment card's `.env` import (preview and
 * apply) and Rotate.
 *
 * Pinned hardest: **no value ever comes back** — not in the preview, not in a refusal; a paste
 * naming something the App spec does not declare is refused whole BEFORE anything is written; a
 * generated value is never overwritten by an import (Rotate is its door); and Rotate needs the
 * typed name and answers a version, not the value.
 */

const WORK = '5a07fa3f-367a-444e-9d1e-311d03cc1327';
const ACTOR = { userId: 'u-1', canEdit: true };
const SECRET = 'never-on-the-wire-2718';

const SPEC: AppSpec = {
    kind: 'app',
    appSpecVersion: 1,
    env: [
        { name: 'FIXTURE_MARKER', prompt: { description: 'Any text', required: true } },
        { name: 'MAIL_TO', prompt: { description: 'Address' } },
        { name: 'API_TOKEN', secret: true, prompt: { description: 'Token' } },
        { name: 'SESSION', secret: true, generate: { kind: 'chars', length: 32 } },
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
    view({ name: 'FIXTURE_MARKER', required: true }),
    view({ name: 'MAIL_TO', set: true, origin: 'user' }),
    view({ name: 'API_TOKEN', secret: true, set: true, origin: 'user' }),
    view({ name: 'SESSION', source: 'generate', secret: true, set: true, origin: 'generated' }),
];

function harness(options: { spec?: AppSpec | null } = {}) {
    const apply = jest.fn(async () => ({
        workId: WORK,
        results: [
            {
                name: 'FIXTURE_MARKER',
                line: 1,
                action: 'created',
                code: null,
                message: null,
                version: 1,
            },
        ],
        warnings: [],
        changed: ['FIXTURE_MARKER'],
        activityRecorded: true,
    }));
    const rotate = jest.fn(async () => ({ entry: TABLE[3], version: 4 }));
    const env = {
        list: jest.fn(async () => TABLE),
        apply,
        rotate,
        isSecureStorageAvailable: jest.fn(() => true),
    } as unknown as AppEnvService & { apply: jest.Mock; rotate: jest.Mock };
    const spec: AppEnvSpecSource = {
        read: jest.fn(async () =>
            options.spec === null
                ? null
                : { spec: options.spec ?? SPEC, specHash: 'h', commitSha: 'c' },
        ),
    };
    return { env, editor: new AppEnvEditorService(env, spec) };
}

const DECLARED = new Set(['FIXTURE_MARKER', 'MAIL_TO', 'API_TOKEN', 'SESSION']);
const VIEWS = TABLE.map((entry) => toVariableView(entry, true));

describe('previewDotenv — what a paste would change', () => {
    it('answers add / replace / remove / skipped / refused per line, in paste order, with no value', () => {
        const text = [
            '# a comment',
            `FIXTURE_MARKER=${SECRET}`,
            `API_TOKEN="${SECRET}"`,
            'MAIL_TO=',
            `SESSION=${SECRET}`,
            '9BAD=x',
            `FIXTURE_MARKER=${SECRET}-again`,
        ].join('\n');

        const preview = previewDotenv(WORK, text, DECLARED, VIEWS);

        expect(preview.lines.map((line) => [line.line, line.name, line.action, line.code])).toEqual(
            [
                [2, 'FIXTURE_MARKER', 'skipped', null],
                [3, 'API_TOKEN', 'replace', null],
                [4, 'MAIL_TO', 'remove', null],
                [5, 'SESSION', 'refused', 'generatedValueUseRotate'],
                [6, null, 'refused', 'invalidName'],
                [7, 'FIXTURE_MARKER', 'add', null],
            ],
        );
        expect(preview.changes).toEqual({
            add: ['FIXTURE_MARKER'],
            replace: ['API_TOKEN'],
            remove: ['MAIL_TO'],
        });
        expect(preview.refused).toBe(2);
        expect(preview.undeclared).toEqual([]);
        expect(JSON.stringify(preview)).not.toContain(SECRET);
    });

    it('lists undeclared names so the import can refuse them', () => {
        const preview = previewDotenv(WORK, `TYPO_NAME=${SECRET}\nMAIL_TO=a@b.c`, DECLARED, VIEWS);
        expect(preview.undeclared).toEqual(['TYPO_NAME']);
        expect(preview.lines[0]).toMatchObject({
            name: 'TYPO_NAME',
            action: 'refused',
            code: 'undeclaredName',
        });
        expect(JSON.stringify(preview)).not.toContain(SECRET);
    });

    it('answers the ceiling, unparsed, for a paste over the limits', () => {
        const huge = Array.from(
            { length: APP_ENV_DOTENV_MAX_LINES + 1 },
            (_, index) => `NAME_${index}=v`,
        ).join('\n');
        const preview = previewDotenv(WORK, huge, DECLARED, VIEWS);
        expect(preview.limits).toMatchObject({ code: 'tooManyValues' });
        expect(preview.lines).toEqual([]);
    });
});

describe('AppEnvEditorService — the import', () => {
    it('reads the body as plan §5’s { import: { dotenv } } and routes a PUT import there', () => {
        expect(readDotenvText({ import: { dotenv: 'A=b' } })).toBe('A=b');
        expect(readDotenvText({ dotenv: 'A=b' })).toBe('A=b');
        expect(readDotenvText({ import: {} })).toBeNull();
        expect(isImportBody({ import: { dotenv: '' } })).toBe(true);
        expect(isImportBody({ values: {}, import: { dotenv: '' } })).toBe(false);
        expect(isImportBody({ values: {} })).toBe(false);
    });

    it('previews without writing anything', async () => {
        const { editor, env } = harness();
        const preview = await editor.previewImport(WORK, ACTOR, {
            import: { dotenv: `FIXTURE_MARKER=${SECRET}` },
        });
        expect(preview.changes.add).toEqual(['FIXTURE_MARKER']);
        expect(env.apply).not.toHaveBeenCalled();
        expect(JSON.stringify(preview)).not.toContain(SECRET);
    });

    it('applies a clean paste through AppEnvService.apply({ import }) and answers no value', async () => {
        const { editor, env } = harness();
        const answer = await editor.patch(WORK, ACTOR, {
            import: { dotenv: `FIXTURE_MARKER=${SECRET}` },
        });
        expect(env.apply).toHaveBeenCalledWith(WORK, ACTOR, {
            import: { text: `FIXTURE_MARKER=${SECRET}` },
        });
        expect(answer.changed).toEqual(['FIXTURE_MARKER']);
        expect(JSON.stringify(answer)).not.toContain(SECRET);
    });

    it('refuses a paste with an undeclared name whole, before anything is written', async () => {
        const { editor, env } = harness();
        await expect(
            editor.patch(WORK, ACTOR, { import: { dotenv: `FIXTURE_MARKER=a\nTYPO=${SECRET}` } }),
        ).rejects.toMatchObject({ code: 'undeclaredName', status: 400, names: ['TYPO'] });
        expect(env.apply).not.toHaveBeenCalled();
    });

    it('refuses a body without text, and a Work without an App spec', async () => {
        await expect(
            harness().editor.previewImport(WORK, ACTOR, { import: {} }),
        ).rejects.toBeInstanceOf(AppEnvEditorRefusal);
        await expect(
            harness({ spec: null }).editor.previewImport(WORK, ACTOR, {
                import: { dotenv: 'A=b' },
            }),
        ).rejects.toMatchObject({ code: 'specUnavailable', status: 409 });
    });
});

describe('AppEnvEditorService — Rotate', () => {
    it('needs the typed name in the body and answers the version and the table, never the value', async () => {
        const { editor, env } = harness();
        await expect(editor.rotate(WORK, ACTOR, 'SESSION', {})).rejects.toMatchObject({
            code: 'invalidBody',
            status: 400,
        });
        expect(env.rotate).not.toHaveBeenCalled();

        const answer = await editor.rotate(WORK, ACTOR, 'SESSION', { confirmName: 'SESSION' });
        expect(env.rotate).toHaveBeenCalledWith(WORK, ACTOR, 'SESSION', { confirmName: 'SESSION' });
        expect(answer).toMatchObject({ workId: WORK, name: 'SESSION', version: 4 });
        expect(answer.entries.find((entry) => entry.name === 'SESSION')).toMatchObject({
            masked: true,
            editable: false,
        });
    });

    it('lets the service’s own refusal (a mismatched name) through untouched', async () => {
        const { editor, env } = harness();
        const refusal = Object.assign(new Error('mismatch'), {
            name: 'AppEnvRefusalError',
            code: 'rotateConfirmationMismatch',
            status: 422,
        });
        env.rotate.mockRejectedValueOnce(refusal);
        await expect(editor.rotate(WORK, ACTOR, 'SESSION', { confirmName: 'SESION' })).rejects.toBe(
            refusal,
        );
    });
});
