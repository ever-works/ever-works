/**
 * Regression proof for the production defect where EVERY templated email
 * failed to send, in EVERY environment, because the Handlebars templates
 * were not present in the built container image.
 *
 * ## Why the pre-existing tests did not catch it
 *
 * `mailer.service.spec.ts` mocks `fs/promises` wholesale and then asserts on
 * the *shape* of the path handed to `readFile`
 * (`expect(filePath).toMatch(/src[\\/]templates[\\/]welcome\.hbs$/)`). A
 * mocked filesystem always resolves, so the suite stayed green while the
 * real one threw `ENOENT: /app/src/templates/<name>.hbs` on every send.
 *
 * Two independent faults had to line up:
 *
 *   1. **Packaging.** `nest-cli.json` declared `assets: ["src/templates/**\/*"]`,
 *      but the Nest CLI resolves asset globs relative to `sourceRoot`
 *      (`@nestjs/cli/lib/compiler/assets-manager.js`), so it globbed
 *      `apps/api/src/src/templates/**\/*`, matched nothing, and copied
 *      nothing into `dist`.
 *   2. **Resolution.** The runtime path came from `process.cwd()`. Under Jest
 *      that is `apps/api`, where `src/templates` genuinely exists — which is
 *      precisely why no unit test could see the bug. In the container the
 *      process starts in `/app` and there is no `/app/src`.
 *
 * ## How these tests avoid repeating that mistake
 *
 * Nothing here is mocked. The templates are read from the real filesystem,
 * rendered by the real Handlebars, and — the key move — the send is
 * performed with the process working directory moved somewhere unrelated,
 * which reproduces the container's condition inside a unit test.
 *
 * This file imports only `MailerService`, so it runs verbatim against the
 * pre-fix tree, where it fails.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MailerService } from './mailer.service';
import type { FakerMailerService } from './faker-mailer.service';
import type { MailerService as SmtpMailerService } from '@nestjs-modules/mailer';
import type { Resend } from 'resend';

const API_ROOT = path.resolve(__dirname, '..', '..', '..');
const SOURCE_TEMPLATES_DIR = path.join(API_ROOT, 'src', 'templates');

/** Every template `MailService` asks `MailerService` to render. */
const TEMPLATES_USED_BY_MAIL_SERVICE = [
    'account-deletion',
    'budget-alert',
    'forgot-password',
    'magic-link',
    'member-invitation',
    'new-device-login',
    'organization-invitation',
    'password-changed',
    'signup-confirmation',
    'welcome',
    'work-invitation-claim',
];

describe('MailerService template packaging (no mocks)', () => {
    const originalCwd = process.cwd();
    let scratchDir: string;
    let smtp: { sendMail: jest.Mock };
    let faker: { sendMail: jest.Mock };
    let resend: { emails: { send: jest.Mock } };

    const buildService = () => {
        const service = new MailerService(
            smtp as unknown as SmtpMailerService,
            faker as unknown as FakerMailerService,
            resend as unknown as Resend,
        );
        jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
        return service;
    };

    beforeAll(() => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-mailer-cwd-'));
    });

    beforeEach(() => {
        process.env.MAILER_PROVIDER = 'resend';
        process.env.RESEND_EMAIL_FROM = 'from@resend.test';
        smtp = { sendMail: jest.fn().mockResolvedValue(undefined) };
        faker = { sendMail: jest.fn().mockResolvedValue(undefined) };
        resend = { emails: { send: jest.fn().mockResolvedValue({ data: { id: 'r-1' } }) } };
    });

    afterEach(() => {
        process.chdir(originalCwd);
        delete process.env.MAILER_PROVIDER;
        delete process.env.RESEND_EMAIL_FROM;
        jest.restoreAllMocks();
    });

    afterAll(() => {
        process.chdir(originalCwd);
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    it('CONTROL: the templates exist in the source tree', () => {
        // Without this control an empty/failing result below could be read as
        // "there are no templates" rather than "the templates cannot be
        // found". Three false "all clear" verdicts have come from exactly
        // that ambiguity.
        expect(fs.existsSync(SOURCE_TEMPLATES_DIR)).toBe(true);
        const onDisk = fs
            .readdirSync(SOURCE_TEMPLATES_DIR)
            .filter((f) => f.endsWith('.hbs'))
            .map((f) => path.basename(f, '.hbs'))
            .sort();
        expect(onDisk).toEqual([...TEMPLATES_USED_BY_MAIL_SERVICE].sort());
    });

    describe('sending from a container-like working directory', () => {
        /**
         * The production condition: `cwd` is not `apps/api`, and there is no
         * `<cwd>/src/templates`. Pre-fix this throws
         * `ENOENT ... /src/templates/<name>.hbs` for every template.
         */
        beforeEach(() => {
            process.chdir(scratchDir);
            expect(fs.existsSync(path.join(process.cwd(), 'src', 'templates'))).toBe(false);
        });

        it.each(TEMPLATES_USED_BY_MAIL_SERVICE)(
            'renders %s to non-empty HTML and hands it to the provider',
            async (template) => {
                const service = buildService();

                await service.sendMail({
                    to: 'user@test.example',
                    subject: `subject for ${template}`,
                    template,
                    context: {
                        appName: 'Ever Works',
                        companyOwner: 'Ever Co. LTD',
                        platformWebsite: 'https://ever.works',
                        currentYear: 2026,
                        firstName: 'Ada',
                    },
                });

                expect(resend.emails.send).toHaveBeenCalledTimes(1);
                const sent = resend.emails.send.mock.calls[0][0];
                expect(typeof sent.html).toBe('string');
                expect(sent.html.trim().length).toBeGreaterThan(0);
                expect(sent.html.toLowerCase()).toContain('<html');
            },
        );

        it('substitutes the verification URL into the signup-confirmation email', async () => {
            // The template whose absence locked new production accounts out:
            // without it `users.emailVerified` can never flip, so the account
            // can never authenticate against the API.
            const service = buildService();

            await service.sendMail({
                to: 'newuser@test.example',
                subject: 'Confirm your Ever Works account',
                template: 'signup-confirmation',
                context: {
                    appName: 'Ever Works',
                    companyOwner: 'Ever Co. LTD',
                    platformWebsite: 'https://ever.works',
                    currentYear: 2026,
                    firstName: 'Ada',
                    confirmationUrl: 'https://app.ever.works/verify?token=abc123',
                    confirmationToken: 'abc123',
                },
            });

            const sent = resend.emails.send.mock.calls[0][0];
            // `{{confirmationUrl}}` is a double-brace expression, so Handlebars
            // HTML-escapes it and `?token=abc123` renders as
            // `?token&#x3D;abc123`. Assert on the parts that escaping leaves
            // untouched rather than pinning the escaped form.
            expect(sent.html).toContain('https://app.ever.works/verify?token');
            expect(sent.html).toContain('abc123');
            expect(sent.html).toContain('Ada');
        });

        it('renders the organization invitation with a working accept link', async () => {
            // A Handlebars variable that no context key satisfies renders as
            // an EMPTY STRING rather than throwing, so a typo in the template
            // ships an email with a dead "Accept invitation" button and
            // nothing anywhere reports a problem. This asserts each
            // substitution actually landed.
            const service = buildService();

            await service.sendMail({
                to: 'newcomer@test.example',
                subject: 'You have been invited to Acme',
                template: 'organization-invitation',
                context: {
                    appName: 'Ever Works',
                    companyOwner: 'Ever Co. LTD',
                    platformWebsite: 'https://ever.works',
                    currentYear: 2026,
                    organizationName: 'Acme Inc',
                    inviterName: 'ada',
                    acceptUrl: 'https://app.ever.works/org-invite/tok123',
                    recipientEmail: 'newcomer@test.example',
                    expiresAtFormatted: 'Aug 25, 2026',
                },
            });

            const sent = resend.emails.send.mock.calls[0][0];
            expect(sent.html).toContain('Acme Inc');
            expect(sent.html).toContain('ada');
            expect(sent.html).toContain('Aug 25, 2026');
            // Double-brace expressions are HTML-escaped, so assert on the
            // parts escaping leaves alone rather than pinning the escaped form.
            expect(sent.html).toContain('https://app.ever.works/org-invite/tok123');
            // The recipient address is stated on purpose: the token is
            // email-bound, so redeeming it as another account 403s, and the
            // email is the only place that can explain that in advance.
            expect(sent.html).toContain('newcomer@test.example');

            // And nothing was left unsubstituted.
            expect(sent.html).not.toContain('{{');
        });
    });

    describe('degraded case: a template that genuinely does not exist', () => {
        it('throws, never calls the provider, and never reports a send', async () => {
            const service = buildService();
            const logSpy = (service as any).logger.log as jest.Mock;

            await expect(
                service.sendMail({
                    to: 'user@test.example',
                    subject: 'nope',
                    template: 'definitely-not-a-template',
                }),
            ).rejects.toThrow();

            // No message was queued anywhere...
            expect(resend.emails.send).not.toHaveBeenCalled();
            expect(smtp.sendMail).not.toHaveBeenCalled();
            expect(faker.sendMail).not.toHaveBeenCalled();
            // ...and nothing in the log claims one was.
            const logged = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
            expect(logged.some((line) => /Email sent/.test(line))).toBe(false);
        });
    });
});

describe('nest-cli.json asset globs', () => {
    /**
     * The Nest CLI joins each asset glob onto `sourceRoot`:
     *   sourceRoot  = join(process.cwd(), configuration.sourceRoot)
     *   includePath = join(sourceRoot, include)
     * (see `@nestjs/cli/lib/compiler/assets-manager.js`).
     *
     * So `"src/templates/**\/*"` globbed `apps/api/src/src/templates/**\/*`,
     * matched zero files and copied nothing — while reading as obviously
     * correct in review. This asserts the declared globs actually land on
     * the templates that exist.
     */
    const nestCli = JSON.parse(fs.readFileSync(path.join(API_ROOT, 'nest-cli.json'), 'utf8'));

    it('point at the real .hbs templates once resolved relative to sourceRoot', () => {
        expect(nestCli.sourceRoot).toBeTruthy();
        const assets: Array<string | { include: string }> = nestCli.compilerOptions?.assets ?? [];
        expect(assets.length).toBeGreaterThan(0);

        const sourceRoot = path.join(API_ROOT, nestCli.sourceRoot);
        const matched = new Set<string>();

        for (const entry of assets) {
            const include = typeof entry === 'string' ? entry : entry.include;
            const globRoot = path.join(sourceRoot, include.replace(/[\\/]?\*\*[\\/]\*$/, ''));
            if (!fs.existsSync(globRoot) || !fs.statSync(globRoot).isDirectory()) {
                continue;
            }
            for (const file of fs.readdirSync(globRoot)) {
                if (file.endsWith('.hbs')) {
                    matched.add(path.basename(file, '.hbs'));
                }
            }
        }

        expect([...matched].sort()).toEqual([...TEMPLATES_USED_BY_MAIL_SERVICE].sort());
    });
});

describe('build output packaging', () => {
    /**
     * Source-level correctness was never the problem — packaging was. When
     * `dist/` has been built, assert the templates landed beside the
     * compiled code, which is what the container image copies
     * (`COPY --from=installer /app/deploy/dist ./dist`).
     *
     * Skipped rather than failed when `dist/` is absent so `pnpm test` on a
     * clean checkout stays green; CI builds before it tests, and the API
     * Dockerfile carries a hard gate for the image itself.
     */
    const distDir = path.join(API_ROOT, 'dist');
    const hasBuild = fs.existsSync(path.join(distDir, 'main.js'));
    const maybe = hasBuild ? it : it.skip;

    maybe('emits every .hbs into dist/templates', () => {
        const distTemplates = path.join(distDir, 'templates');
        expect(fs.existsSync(distTemplates)).toBe(true);

        const shipped = fs
            .readdirSync(distTemplates)
            .filter((f) => f.endsWith('.hbs'))
            .map((f) => path.basename(f, '.hbs'))
            .sort();

        expect(shipped).toEqual([...TEMPLATES_USED_BY_MAIL_SERVICE].sort());
    });

    maybe('the COMPILED resolver finds them with a container-like cwd', () => {
        // End-to-end proof against the actual build output: run
        // dist/mail/templates.js from an unrelated directory, exactly as the
        // image does (`cwd=/app`).
        const compiled = path.join(distDir, 'mail', 'templates.js');
        expect(fs.existsSync(compiled)).toBe(true);

        const script = `
            const fs = require('fs');
            const t = require(${JSON.stringify(compiled)});
            const status = t.inspectTemplatesDir({ refresh: true });
            const sample = fs.readFileSync(t.resolveTemplatePath('signup-confirmation'), 'utf8');
            process.stdout.write(JSON.stringify({
                cwd: process.cwd(),
                ok: status.ok,
                dir: status.dir,
                missing: status.missing,
                available: status.available.length,
                sampleLength: sample.length,
            }));
        `;

        const result = JSON.parse(
            execFileSync(process.execPath, ['-e', script], {
                cwd: os.tmpdir(),
                encoding: 'utf8',
            }),
        );

        expect(fs.realpathSync(result.cwd)).not.toBe(fs.realpathSync(API_ROOT));
        expect(result.dir).toBe(path.join(distDir, 'templates'));
        expect(result.missing).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.available).toBe(TEMPLATES_USED_BY_MAIL_SERVICE.length);
        expect(result.sampleLength).toBeGreaterThan(0);
    });
});
