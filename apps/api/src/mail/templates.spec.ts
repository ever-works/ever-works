/**
 * Unit tests for the email-template resolver.
 *
 * The end-to-end regression proof for the "no templated email was ever
 * sent" defect lives in `providers/mailer.service.templates.spec.ts` — it is
 * deliberately written so it can also run against the pre-fix tree. This
 * file covers the helper's own contract.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    KNOWN_EMAIL_TEMPLATES,
    TEMPLATES_DIR,
    describeTemplatesDir,
    inspectTemplatesDir,
    listAvailableTemplates,
    resolveTemplatePath,
} from './templates';

const API_ROOT = path.resolve(__dirname, '..', '..');

describe('email templates resolver', () => {
    const originalCwd = process.cwd();

    afterEach(() => {
        process.chdir(originalCwd);
    });

    it('anchors TEMPLATES_DIR to this module, not to the process working directory', () => {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-tpl-'));
        try {
            process.chdir(scratch);
            // Control: prove the chdir actually took effect, so a pass here
            // cannot be an artefact of chdir silently doing nothing.
            expect(fs.realpathSync(process.cwd())).not.toBe(fs.realpathSync(API_ROOT));

            // `templates.ts` lives in `src/mail/`, the templates in
            // `src/templates/` — and after compilation, `dist/mail/` and
            // `dist/templates/`. The `..` hop is what makes the same
            // expression correct in both trees and in the container.
            expect(TEMPLATES_DIR).toBe(path.resolve(__dirname, '..', 'templates'));
            expect(fs.existsSync(TEMPLATES_DIR)).toBe(true);
            expect(TEMPLATES_DIR.startsWith(fs.realpathSync(process.cwd()))).toBe(false);
        } finally {
            process.chdir(originalCwd);
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });

    it('agrees with the directory contents in both directions', () => {
        // Forward: every registered template is on disk. Reverse: every
        // `.hbs` on disk is registered — otherwise the boot check and the
        // Docker packaging gate would not notice the build dropping it.
        expect(listAvailableTemplates()).toEqual([...KNOWN_EMAIL_TEMPLATES].sort());
    });

    it('reports a healthy directory with nothing missing', () => {
        const status = inspectTemplatesDir({ refresh: true });
        expect(status.dir).toBe(TEMPLATES_DIR);
        expect(status.missing).toEqual([]);
        expect(status.ok).toBe(true);
        expect(status.available.length).toBe(KNOWN_EMAIL_TEMPLATES.length);
    });

    it('describes the directory without a MISSING marker when healthy', () => {
        const description = describeTemplatesDir({ refresh: true });
        expect(description).toContain(TEMPLATES_DIR);
        expect(description).toContain('signup-confirmation');
        expect(description).not.toContain('MISSING=');
    });

    it('resolves a known template to an existing absolute path', () => {
        const resolved = resolveTemplatePath('forgot-password');
        expect(path.isAbsolute(resolved)).toBe(true);
        expect(resolved).toBe(path.join(TEMPLATES_DIR, 'forgot-password.hbs'));
        expect(fs.existsSync(resolved)).toBe(true);
    });

    it.each([
        '../../config/constants',
        '..\\..\\config\\constants',
        'nested/template',
        '',
        'welcome.hbs',
    ])('rejects the traversal-shaped template name %j', (name) => {
        expect(() => resolveTemplatePath(name)).toThrow(/Invalid template name/);
    });
});
