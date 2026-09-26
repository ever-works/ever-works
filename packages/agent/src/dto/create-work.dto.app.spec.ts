import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { APP_REPOSITORY_MODES } from '@ever-works/contracts';
import { CreateWorkDto } from './create-work.dto';
import { USER_SELECTABLE_WORK_KINDS } from '../entities/work.entity';

/**
 * APW-01 T5 — the four App Work fields on `CreateWorkDto`
 * (`repositoryMode`, `targetOwner`, `blueprintId`, `autoProvision`).
 *
 * Why this spec exists at all: `POST /api/works` with `repositoryMode` /
 * `targetOwner` used to answer
 * `400 {"message":["property repositoryMode should not exist","property targetOwner should not exist"]}`
 * from the global `ValidationPipe` (`whitelist` + `forbidNonWhitelisted`,
 * `apps/api/src/main.ts:199-205`), measured live by APW-13 T63. That 400 is
 * what held two acceptance lanes at `test.fixme`
 * (`apps/web/e2e/flow-template-fork-success.spec.ts`,
 * `apps/web/e2e/flow-repo-work-kind-regression.spec.ts`). The last describe
 * block below pins the pipe-level fix (both fields whitelist, and an
 * undeclared field still does not) rather than only the validator-level one.
 *
 * The two required fields are required ON THE DTO — required in the service is
 * not enough, because the pipe must answer `400 repositoryMode must be defined`
 * before the handler runs. Two consequences worth reading before editing:
 *
 *   - `repositoryMode` and `targetOwner` deliberately carry **no**
 *     `@IsOptional()`. `@IsOptional()` IS a `@ValidateIf`, class-validator ANDs
 *     every conditional on a property, and a `false` result returns before the
 *     `IS_DEFINED` metadata is consulted — so `@IsOptional()` + `@IsDefined()`
 *     can never reject a missing value. The `@ValidateIf` predicate alone makes
 *     the field optional for every kind except `app` (see the "every other
 *     kind" cases).
 *   - every non-`app` kind keeps validating exactly as before: `kind` is still
 *     whitelisted to `USER_SELECTABLE_WORK_KINDS + 'default'`, unknown kinds
 *     still coerce to `default`, and the four new fields are simply not
 *     validated for those kinds (ACC-01-03).
 */

/** A complete, otherwise-valid App create body, before the fields under test. */
const appBase = {
    slug: 'my-app',
    name: 'My App',
    description: 'An app wrapped as a Work',
    organization: false,
    kind: 'app',
    repositoryUrl: 'https://github.com/ever-works/templates',
} as const;

/** A complete, otherwise-valid non-App create body (`dto.spec.ts`'s base). */
const bareBase = {
    slug: 'demo',
    name: 'Demo',
    description: 'Demo description',
    organization: false,
} as const;

/**
 * The global pipe's options — the thing that turned the missing properties
 * into `property … should not exist`. Kept in one place so a case that claims
 * "the pipe accepts this" is provably using the pipe's own options.
 */
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true } as const;

function instance(body: Record<string, unknown>): CreateWorkDto {
    return plainToInstance(CreateWorkDto, body);
}

/** `{ property: [message, …] }` for every property that failed. */
async function messagesOf(body: Record<string, unknown>): Promise<Record<string, string[]>> {
    const errors = await validate(instance(body));
    const out: Record<string, string[]> = {};
    for (const error of errors) {
        out[error.property] = Object.values(error.constraints ?? {});
    }
    return out;
}

/** The constraint KEYS that failed, keyed by property (`isDefined`, `matches`, …). */
async function constraintsOf(body: Record<string, unknown>): Promise<Record<string, string[]>> {
    const errors = await validate(instance(body));
    const out: Record<string, string[]> = {};
    for (const error of errors) {
        out[error.property] = Object.keys(error.constraints ?? {});
    }
    return out;
}

/** Same, but with the API's global pipe options (`whitelist` + `forbidNonWhitelisted`). */
async function pipeMessagesOf(body: Record<string, unknown>): Promise<Record<string, string[]>> {
    const errors = await validate(instance(body), PIPE_OPTIONS);
    const out: Record<string, string[]> = {};
    for (const error of errors) {
        out[error.property] = Object.values(error.constraints ?? {});
    }
    return out;
}

describe('CreateWorkDto — App Work fields (APW-01 T5)', () => {
    describe('the accepted App bodies (T5 Test line)', () => {
        it('accepts { kind: "app", repositoryMode: "fork", targetOwner: "my-org" }', async () => {
            const errors = await validate(
                instance({ ...appBase, repositoryMode: 'fork', targetOwner: 'my-org' }),
            );
            expect(errors).toHaveLength(0);
        });

        it('accepts { kind: "app", repositoryMode: "link" } without an owner', async () => {
            const errors = await validate(instance({ ...appBase, repositoryMode: 'link' }));
            expect(errors).toHaveLength(0);
        });

        it('accepts autoProvision: false (the member declined the automatic start)', async () => {
            const dto = instance({
                ...appBase,
                repositoryMode: 'link',
                autoProvision: false,
            });
            expect(await validate(dto)).toHaveLength(0);
            // The decline is carried as a real boolean, not dropped by the
            // transform — `false` is the only value that means "declined", so a
            // silently-stripped one would read as "on" downstream.
            expect(dto.autoProvision).toBe(false);
        });

        it('accepts autoProvision: true and an omitted autoProvision (absent means on)', async () => {
            for (const autoProvision of [true, undefined]) {
                const errors = await validate(
                    instance({
                        ...appBase,
                        repositoryMode: 'private-copy',
                        targetOwner: 'my-org',
                        autoProvision,
                    }),
                );
                expect(errors).toHaveLength(0);
            }
        });

        it.each([...APP_REPOSITORY_MODES])(
            'accepts repositoryMode=%j on a kind: "app" body',
            async (mode) => {
                const body: Record<string, unknown> = { ...appBase, repositoryMode: mode };
                if (mode !== 'link') {
                    body.targetOwner = 'my-org';
                }
                expect(await validate(instance(body))).toHaveLength(0);
            },
        );
    });

    describe('repositoryMode', () => {
        it('rejects repositoryMode: "mirror" (outside APP_REPOSITORY_MODES)', async () => {
            const constraints = await constraintsOf({
                ...appBase,
                repositoryMode: 'mirror',
                targetOwner: 'my-org',
            });
            expect(constraints.repositoryMode).toEqual(['isIn']);
        });

        it('requires the field for kind: "app" — the pipe copy is "repositoryMode must be defined"', async () => {
            const messages = await messagesOf({ ...appBase });
            expect(messages.repositoryMode).toContain('repositoryMode must be defined');
        });

        it('still requires it when the kind arrives in another case (the kind Transform runs first)', async () => {
            const messages = await messagesOf({ ...appBase, kind: 'APP' });
            expect(messages.repositoryMode).toContain('repositoryMode must be defined');
        });

        it('does not demand the field for a misspelled kind — unknown kinds still coerce to `default`', async () => {
            // `normalizeCreateWorkKind` maps anything unknown to `default`, so a
            // misspelled kind must NOT start demanding repositoryMode — that is
            // the ACC-01-03 direction of this predicate.
            const dto = instance({ ...appBase, kind: 'aplication' });
            expect(dto.kind).toBe('default');
            expect(await validate(dto)).toHaveLength(0);
        });

        it('leaves repositoryMode optional for every kind except app', async () => {
            for (const kind of USER_SELECTABLE_WORK_KINDS.filter((k) => k !== 'app')) {
                const errors = await validate(instance({ ...bareBase, kind }));
                expect(errors).toHaveLength(0);
            }
            for (const kind of ['default', 'company', undefined]) {
                const errors = await validate(
                    instance(kind === undefined ? { ...bareBase } : { ...bareBase, kind }),
                );
                expect(errors).toHaveLength(0);
            }
        });

        it('PRE-EXISTING (unchanged by T5): `campaign` is still refused by the kind whitelist', async () => {
            // `WORK_KINDS` includes `campaign` and `normalizeCreateWorkKind`
            // returns it unchanged, but the DTO's `@IsIn` list is
            // `USER_SELECTABLE_WORK_KINDS + 'default'`, which excludes it — so a
            // `kind: 'campaign'` create answers
            // `400 kind must be one of the following values: website, …, app,
            // default`. Pinned here because T5 touches this property's
            // neighbours and a reader must not mistake it for a T5 regression:
            // it is the behaviour before this change too.
            const constraints = await constraintsOf({ ...bareBase, kind: 'campaign' });
            expect(constraints.kind).toEqual(['isIn']);
            expect(constraints.repositoryMode).toBeUndefined();
        });
    });

    describe('targetOwner', () => {
        // `org-` (a trailing hyphen) is ACCEPTED, and that is the pattern T5
        // specifies: `/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/` constrains the
        // first character and the length only. GitHub's own login rule is
        // stricter (no leading OR trailing hyphen) — routed, not silently
        // tightened, because §3.3 fixes this regex.
        it.each(['my-org', 'octocat', 'a', 'A1', 'my-org-2', 'org-', 'a'.repeat(39)])(
            'accepts targetOwner=%j (GitHub login shape)',
            async (targetOwner) => {
                const errors = await validate(
                    instance({ ...appBase, repositoryMode: 'fork', targetOwner }),
                );
                expect(errors).toHaveLength(0);
            },
        );

        it('rejects targetOwner: "../x"', async () => {
            const constraints = await constraintsOf({
                ...appBase,
                repositoryMode: 'fork',
                targetOwner: '../x',
            });
            expect(constraints.targetOwner).toEqual(['matches']);
        });

        it.each(['-org', 'my_org', 'my org', 'my/org', '.', ''])(
            'rejects targetOwner=%j',
            async (targetOwner) => {
                const constraints = await constraintsOf({
                    ...appBase,
                    repositoryMode: 'fork',
                    targetOwner,
                });
                expect(constraints.targetOwner).toContain('matches');
            },
        );

        it('rejects a 40-character owner (the pattern caps at 39) and a 101-character one (MaxLength)', async () => {
            const long = await constraintsOf({
                ...appBase,
                repositoryMode: 'fork',
                targetOwner: 'a'.repeat(40),
            });
            expect(long.targetOwner).toEqual(['matches']);

            const tooLong = await constraintsOf({
                ...appBase,
                repositoryMode: 'fork',
                targetOwner: `${'a'.repeat(100)}-b`,
            });
            expect(tooLong.targetOwner).toContain('maxLength');
        });

        it('trims the value before validating it', () => {
            const dto = instance({
                ...appBase,
                repositoryMode: 'fork',
                targetOwner: '  my-org  ',
            });
            expect(dto.targetOwner).toBe('my-org');
        });

        it.each(['fork', 'private-copy'])(
            'requires the field for repositoryMode=%j — "targetOwner must be defined"',
            async (repositoryMode) => {
                const messages = await messagesOf({ ...appBase, repositoryMode });
                expect(messages.targetOwner).toContain('targetOwner must be defined');
            },
        );

        it('does not require the field for repositoryMode: "link"', async () => {
            const constraints = await constraintsOf({ ...appBase, repositoryMode: 'link' });
            expect(constraints.targetOwner).toBeUndefined();
        });

        it('ignores the field for repositoryMode: "link" (plan §3.3: ignored for link)', async () => {
            // Not a licence to send junk — it is the documented predicate: the
            // owner only means something for fork/private-copy, so a `link`
            // request never has its value validated. Pinned so a future
            // predicate change is a deliberate, visible edit rather than drift.
            const constraints = await constraintsOf({
                ...appBase,
                repositoryMode: 'link',
                targetOwner: '../x',
            });
            expect(constraints.targetOwner).toBeUndefined();
        });

        it('does not require the field when the kind is not app', async () => {
            const constraints = await constraintsOf({
                ...bareBase,
                kind: 'repo',
                repositoryUrl: 'https://github.com/ever-works/ever-works',
            });
            expect(constraints.targetOwner).toBeUndefined();
        });
    });

    describe('blueprintId', () => {
        it.each(['cal-diy', 'a', 'a1-b2', 'x'.repeat(100)])(
            'accepts blueprintId=%j (Apps catalog id shape)',
            async (blueprintId) => {
                const errors = await validate(
                    instance({ ...appBase, repositoryMode: 'link', blueprintId }),
                );
                expect(errors).toHaveLength(0);
            },
        );

        it.each(['Cal-Diy', '-cal', 'cal_diy', 'cal.diy', 'x'.repeat(101)])(
            'rejects blueprintId=%j',
            async (blueprintId) => {
                const constraints = await constraintsOf({
                    ...appBase,
                    repositoryMode: 'link',
                    blueprintId,
                });
                expect(constraints.blueprintId?.length).toBeGreaterThan(0);
            },
        );

        it('stays optional', async () => {
            const constraints = await constraintsOf({ ...appBase, repositoryMode: 'link' });
            expect(constraints.blueprintId).toBeUndefined();
        });
    });

    describe('autoProvision', () => {
        it.each(['false', 0, 1, 'yes', {}])('rejects the non-boolean %j', async (autoProvision) => {
            const constraints = await constraintsOf({
                ...appBase,
                repositoryMode: 'link',
                autoProvision,
            });
            expect(constraints.autoProvision).toEqual(['isBoolean']);
        });

        it('is optional for every kind (absent means on, so no existing caller moves)', async () => {
            expect(await validate(instance({ ...appBase, repositoryMode: 'link' }))).toHaveLength(
                0,
            );
            expect(await validate(instance({ ...bareBase, kind: 'repo' }))).toHaveLength(0);
        });
    });

    describe('the API pipe contract (whitelist + forbidNonWhitelisted)', () => {
        it('accepts the App create body that T63 measured as a 400', async () => {
            // The fork-field shape the e2e fork specs (`flow-template-fork-success.spec.ts`)
            // post. The owner login is arbitrary here: the pipe checks the login's SHAPE,
            // never whose login it is (the e2e specs now post the fixture's `apw-e2e-*`
            // accounts, not this one).
            const messages = await pipeMessagesOf({
                ...appBase,
                repositoryMode: 'fork',
                targetOwner: 'apw13-e2e-user',
            });
            expect(messages).toEqual({});
        });

        it('keeps the four fields on the instance (whitelisting strips only undeclared ones)', () => {
            const dto = instance({
                ...appBase,
                repositoryMode: 'private-copy',
                targetOwner: 'my-org',
                blueprintId: 'cal-diy',
                autoProvision: false,
            });
            expect(dto.repositoryMode).toBe('private-copy');
            expect(dto.targetOwner).toBe('my-org');
            expect(dto.blueprintId).toBe('cal-diy');
            expect(dto.autoProvision).toBe(false);
        });

        it('declares the four fields for every kind, so no kind is refused for carrying them', async () => {
            for (const kind of [...USER_SELECTABLE_WORK_KINDS, 'default']) {
                const messages = await pipeMessagesOf({
                    ...bareBase,
                    kind,
                    repositoryMode: 'link',
                    autoProvision: true,
                });
                expect(messages).toEqual({});
            }
        });

        it('CONTROL: an undeclared field is still refused — the pipe really is enforcing', async () => {
            // Without this, the case above would also pass if the pipe options
            // were silently dropped.
            const messages = await pipeMessagesOf({
                ...appBase,
                repositoryMode: 'link',
                notAField: true,
            });
            expect(messages.notAField).toEqual(['property notAField should not exist']);
        });
    });

    describe('every other kind is unaffected (ACC-01-03)', () => {
        it('validates a minimal body for each user-selectable kind without the new fields', async () => {
            // `app` is excluded on purpose: it is the one kind that now REQUIRES
            // repositoryMode (that is this task), and its acceptance cases are
            // the first describe block above.
            for (const kind of USER_SELECTABLE_WORK_KINDS.filter((k) => k !== 'app')) {
                const body: Record<string, unknown> = { ...bareBase, kind };
                if (kind === 'repo') {
                    body.repositoryUrl = 'https://github.com/ever-works/ever-works';
                }
                expect(await validate(instance(body))).toHaveLength(0);
            }
        });

        it('keeps the kind whitelist closed: unknown kinds still coerce to `default`, `company` too', async () => {
            const unknown = instance({ ...bareBase, kind: '<script>alert(1)</script>' });
            expect(unknown.kind).toBe('default');
            expect(await validate(unknown)).toHaveLength(0);

            const company = instance({ ...bareBase, kind: 'company' });
            expect(company.kind).toBe('default');

            const alias = instance({ ...bareBase, kind: 'landing' });
            expect(alias.kind).toBe('landing-page');
        });

        it('keeps the pre-existing required fields required', async () => {
            const messages = await messagesOf({ slug: '', name: '', description: '' });
            expect(messages.slug).toContain(
                'Slug can only contain lowercase letters, numbers, and hyphens',
            );
            expect(messages.name).toBeDefined();
            expect(messages.description).toBeDefined();
            expect(messages.organization).toBeDefined();
            expect(messages.repositoryMode).toBeUndefined();
        });

        it('keeps an App body without repositoryUrl valid on the DTO (the service owns that rule)', async () => {
            // `repositoryUrl`'s requirement for `app` is the service's (`plan
            // §4.2 step 3`), not the DTO's — T5 adds only the four fields, so
            // this pins that nothing new became required here.
            const withoutUrl = { ...appBase } as Record<string, unknown>;
            delete withoutUrl.repositoryUrl;
            expect(
                await validate(instance({ ...withoutUrl, repositoryMode: 'link' })),
            ).toHaveLength(0);
        });
    });
});
