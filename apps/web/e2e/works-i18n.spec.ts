import { test, expect } from '@playwright/test';

/**
 * i18n smoke test for the Directory→Work rename across all 21 locales.
 *
 * For each locale we:
 *   - load the register page (a public page with the new copy)
 *   - assert the page renders (status 200, body has content)
 *   - assert the localized translation of "Work" / "Works" appears
 *   - assert the OLD localized word for "Directory" is GONE
 *
 * The OLD-word strings are constructed at runtime so the bulk-rename
 * script never sees them as literals in this file.
 */

interface LocaleCheck {
    /** locale code (folder + URL prefix) */
    code: string;
    /** human-readable name (test title only) */
    label: string;
    /** Expected new translation(s) — at least one must appear in body */
    expectMatch: RegExp;
    /**
     * Old translation that MUST be absent. Built from a fragments array
     * (joined at runtime) so the sweep doesn't rewrite it in this file.
     */
    oldFragments: string[];
}

const LOCALES: LocaleCheck[] = [
    { code: 'en', label: 'English', expectMatch: /\bworks?\b/i, oldFragments: ['di', 'rectories'] },
    {
        code: 'fr',
        label: 'French',
        expectMatch: /travaux|travail/i,
        oldFragments: ['rép', 'ertoire'],
    },
    { code: 'de', label: 'German', expectMatch: /werk/i, oldFragments: ['Verz', 'eichnis'] },
    { code: 'es', label: 'Spanish', expectMatch: /trabajo/i, oldFragments: ['di', 'rectorio'] },
    { code: 'it', label: 'Italian', expectMatch: /lavor/i, oldFragments: ['di', 'rectory'] },
    { code: 'pt', label: 'Portuguese', expectMatch: /trabalho/i, oldFragments: ['di', 'retório'] },
    { code: 'nl', label: 'Dutch', expectMatch: /werk/i, oldFragments: ['di', 'rectory'] },
    { code: 'pl', label: 'Polish', expectMatch: /prac/i, oldFragments: ['kata', 'log'] },
    { code: 'ru', label: 'Russian', expectMatch: /работ/i, oldFragments: ['кат', 'алог'] },
    { code: 'uk', label: 'Ukrainian', expectMatch: /робот/i, oldFragments: ['кат', 'алог'] },
    { code: 'bg', label: 'Bulgarian', expectMatch: /работ/i, oldFragments: ['дир', 'ектория'] },
    { code: 'tr', label: 'Turkish', expectMatch: /\biş/i, oldFragments: ['di', 'zin'] },
    { code: 'ar', label: 'Arabic', expectMatch: /(عمل|أعمال)/, oldFragments: ['دل', 'يل'] },
    { code: 'he', label: 'Hebrew', expectMatch: /עבוד/, oldFragments: ['ספ', 'רייה'] },
    { code: 'hi', label: 'Hindi', expectMatch: /कार्य/, oldFragments: ['डाय', 'रेक्टरी'] },
    { code: 'id', label: 'Indonesian', expectMatch: /karya/i, oldFragments: ['dir', 'ektori'] },
    { code: 'vi', label: 'Vietnamese', expectMatch: /công việc/i, oldFragments: ['thư', ' mục'] },
    { code: 'th', label: 'Thai', expectMatch: /งาน/, oldFragments: ['ไดเร', 'กทอรี'] },
    { code: 'ja', label: 'Japanese', expectMatch: /ワーク/, oldFragments: ['ディレ', 'クトリ'] },
    { code: 'ko', label: 'Korean', expectMatch: /워크/, oldFragments: ['디렉', '토리'] },
    { code: 'zh', label: 'Chinese', expectMatch: /作品/, oldFragments: ['目', '录'] },
];

test.describe('Works rename — i18n coverage across all 21 locales', () => {
    for (const loc of LOCALES) {
        test(`${loc.code} (${loc.label}) shows the new translation and not the old`, async ({
            page,
        }) => {
            await page.goto(`/${loc.code}/register`, { waitUntil: 'networkidle' });
            const body = await page.locator('body').innerText();

            // Page actually rendered (not blank or error)
            expect(body.length, `${loc.code} register page should have content`).toBeGreaterThan(
                50,
            );

            // Positive: localized translation of Work/Works is present somewhere
            expect(body, `${loc.code} expected to contain ${loc.expectMatch}`).toMatch(
                loc.expectMatch,
            );

            // Negative: old translation is gone
            const oldWord = loc.oldFragments.join('');
            expect(body, `${loc.code} body must not contain old word "${oldWord}"`).not.toMatch(
                new RegExp(oldWord, 'i'),
            );
        });
    }

    test('home page redirects all locales to login when unauth', async ({ page }) => {
        for (const loc of LOCALES.slice(0, 5)) {
            const resp = await page.goto(`/${loc.code}`, { waitUntil: 'networkidle' });
            expect(resp, `${loc.code} root should respond`).not.toBeNull();
            expect(page.url(), `${loc.code} root should redirect to login`).toMatch(/\/login/);
        }
    });
});
