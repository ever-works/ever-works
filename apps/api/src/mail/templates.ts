import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Handlebars email-template packaging + resolution.
 *
 * ## Why this file exists
 *
 * Both consumers of the `.hbs` templates used to resolve them from
 * `process.cwd()`:
 *
 *   - `mail.module.ts`   -> `path.join(process.cwd(), 'src/templates')`
 *     (the `@nestjs-modules/mailer` HandlebarsAdapter, i.e. the SMTP path)
 *   - `mailer.service.ts` -> `path.resolve(process.cwd(), 'src/templates')`
 *     (the Resend path)
 *
 * That only ever worked when the process happened to be started from
 * `apps/api` with the TypeScript sources on disk — i.e. local dev and Jest.
 * In the published container the process starts in `/app`, there is no
 * `/app/src`, and the compiled app lives in `/app/dist` — so every templated
 * email (signup confirmation, password reset, magic link, invitations,
 * budget alerts, ...) threw `ENOENT: /app/src/templates/<name>.hbs` in
 * every environment.
 *
 * Two independent faults had to line up, and both are fixed:
 *
 *  1. **Packaging.** `nest-cli.json` declared `assets: ["src/templates/**\/*"]`,
 *     but the Nest CLI resolves asset globs *relative to `sourceRoot`* — so
 *     it actually globbed `apps/api/src/src/templates/**\/*`, matched nothing,
 *     and copied nothing. The declaration looked right, which is why the
 *     omission survived review. It is now `templates/**\/*`.
 *  2. **Resolution.** The runtime path is now derived from **this module's
 *     own location** instead of the working directory. The layout is
 *     deliberately identical on both sides:
 *
 *        apps/api/src/mail/templates.ts  -> apps/api/src/templates/*.hbs
 *        apps/api/dist/mail/templates.js -> apps/api/dist/templates/*.hbs
 *
 *     so `<dirname>/../templates` is correct for the sources, for the
 *     compiled output and for the container, regardless of where `node`
 *     was invoked from.
 */
export const TEMPLATES_DIR = path.resolve(__dirname, '..', 'templates');

/**
 * Every Handlebars template that must ship with the API, i.e. every value
 * passed as `template:` to `MailerService.sendMail()` by `MailService`.
 *
 * Kept as an explicit list (rather than "whatever happens to be on disk")
 * so the packaging test and the boot-time check have a known-good control:
 * a template that is deleted, renamed or dropped by the build then breaks a
 * test instead of a customer's password reset. `templates.spec.ts` asserts
 * this list and the directory agree in *both* directions, so adding a
 * `.hbs` file without registering it here fails too.
 */
export const KNOWN_EMAIL_TEMPLATES = [
    'account-deletion',
    'budget-alert',
    'forgot-password',
    'magic-link',
    'member-invitation',
    'new-device-login',
    'password-changed',
    'signup-confirmation',
    'welcome',
    'work-invitation-claim',
] as const;

export type EmailTemplateName = (typeof KNOWN_EMAIL_TEMPLATES)[number];

export interface TemplatesDirStatus {
    /** True when the directory exists AND every known template is present. */
    ok: boolean;
    /** Absolute path the templates were looked for in. */
    dir: string;
    /** Template slugs actually found on disk. */
    available: string[];
    /** Known templates that are NOT on disk. */
    missing: string[];
}

/**
 * Security: template names reach this function from call sites that may
 * carry user-influenced data, so restrict to a safe charset (no `/`, `\`,
 * `.` or `..` segments) and then re-check that the resolved path is still
 * inside `TEMPLATES_DIR` (defence-in-depth against path traversal).
 */
export function resolveTemplatePath(templateName: string): string {
    if (!/^[a-z0-9-]+$/i.test(templateName)) {
        throw new Error(`Invalid template name: ${JSON.stringify(templateName)}`);
    }

    const templatePath = path.resolve(TEMPLATES_DIR, `${templateName}.hbs`);
    if (!templatePath.startsWith(TEMPLATES_DIR + path.sep)) {
        throw new Error(`Invalid template name: ${JSON.stringify(templateName)}`);
    }

    return templatePath;
}

/** Template slugs present in `TEMPLATES_DIR` right now. */
export function listAvailableTemplates(): string[] {
    try {
        return fs
            .readdirSync(TEMPLATES_DIR)
            .filter((file) => file.endsWith('.hbs'))
            .map((file) => path.basename(file, '.hbs'))
            .sort();
    } catch {
        // Directory missing (the shipped-image regression) — report empty
        // rather than throwing, so callers can log the full picture.
        return [];
    }
}

let cachedStatus: TemplatesDirStatus | null = null;

/**
 * Describe the state of the template directory. `ok` is false when the
 * directory is missing or any known template is not shipped — the exact
 * packaging regression that silently broke every templated email.
 *
 * The result is cached because the templates are baked into the image and
 * cannot change at runtime, and because the health endpoint calls this on
 * every readiness probe. Pass `{ refresh: true }` in tests.
 */
export function inspectTemplatesDir(options?: { refresh?: boolean }): TemplatesDirStatus {
    if (cachedStatus && !options?.refresh) {
        return cachedStatus;
    }

    const available = listAvailableTemplates();
    const missing = KNOWN_EMAIL_TEMPLATES.filter((name) => !available.includes(name));
    cachedStatus = {
        ok: available.length > 0 && missing.length === 0,
        dir: TEMPLATES_DIR,
        available,
        missing,
    };
    return cachedStatus;
}

/**
 * Human-readable one-liner used by the boot-time check and by the per-send
 * failure path, so an operator can tell a *packaging* fault ("no templates
 * shipped at all") from a *content* fault ("this one template is missing")
 * straight from the log line, without reading the source.
 */
export function describeTemplatesDir(options?: { refresh?: boolean }): string {
    const { dir, available, missing } = inspectTemplatesDir(options);
    return (
        `templatesDir=${dir} available=${available.length}` +
        `[${available.join(', ')}]` +
        (missing.length > 0 ? ` MISSING=[${missing.join(', ')}]` : '')
    );
}
