import { parseSpdxExpression, SPDX_EXPRESSION_MAX_LENGTH } from '../spdx-expression';

/**
 * APW-03 — the SPDX expression parser behind `classifyLicenseExpression`
 * (`plan.md` §2.6 `spdx-expression.ts`; `catalog.md` §4 "Expressions").
 *
 * The tree shape is what makes `OR`-best / `AND`-worst correct, so precedence
 * and associativity are asserted on the tree itself, not only through a class.
 * Every syntax error is `null`: a partial parse would be a guessed licence.
 */
describe('parseSpdxExpression', () => {
    it('parses a single licence id, keeping its case', () => {
        expect(parseSpdxExpression('MIT')).toEqual({ type: 'license', id: 'MIT' });
        expect(parseSpdxExpression('  apache-2.0\n')).toEqual({
            type: 'license',
            id: 'apache-2.0',
        });
    });

    it('keeps a trailing `+` as part of the id', () => {
        expect(parseSpdxExpression('GPL-2.0+')).toEqual({ type: 'license', id: 'GPL-2.0+' });
    });

    it('reads LicenseRef ids, document-qualified or not', () => {
        expect(parseSpdxExpression('LicenseRef-acme.internal-1')).toEqual({
            type: 'license',
            id: 'LicenseRef-acme.internal-1',
        });
        expect(parseSpdxExpression('DocumentRef-spdx-tool-1.2:LicenseRef-MIT-Style-2')).toEqual({
            type: 'license',
            id: 'DocumentRef-spdx-tool-1.2:LicenseRef-MIT-Style-2',
        });
    });

    it('binds WITH to the licence id before it', () => {
        expect(parseSpdxExpression('GPL-2.0-or-later WITH Classpath-exception-2.0')).toEqual({
            type: 'license',
            id: 'GPL-2.0-or-later',
            exception: 'Classpath-exception-2.0',
        });
    });

    it('gives WITH > AND > OR precedence', () => {
        expect(parseSpdxExpression('A OR B AND C WITH E')).toEqual({
            type: 'or',
            left: { type: 'license', id: 'A' },
            right: {
                type: 'and',
                left: { type: 'license', id: 'B' },
                right: { type: 'license', id: 'C', exception: 'E' },
            },
        });
    });

    it('associates AND and OR to the left', () => {
        expect(parseSpdxExpression('A OR B OR C')).toEqual({
            type: 'or',
            left: {
                type: 'or',
                left: { type: 'license', id: 'A' },
                right: { type: 'license', id: 'B' },
            },
            right: { type: 'license', id: 'C' },
        });
        expect(parseSpdxExpression('A AND B AND C')).toEqual({
            type: 'and',
            left: {
                type: 'and',
                left: { type: 'license', id: 'A' },
                right: { type: 'license', id: 'B' },
            },
            right: { type: 'license', id: 'C' },
        });
    });

    it('lets parentheses override precedence, nested and without spaces', () => {
        expect(parseSpdxExpression('((A OR B))AND(C)')).toEqual({
            type: 'and',
            left: {
                type: 'or',
                left: { type: 'license', id: 'A' },
                right: { type: 'license', id: 'B' },
            },
            right: { type: 'license', id: 'C' },
        });
    });

    it('matches operators in any letter case', () => {
        expect(parseSpdxExpression('a or b And c wItH e')).toEqual(
            parseSpdxExpression('a OR b AND c WITH e'),
        );
    });

    it.each([
        null,
        undefined,
        '',
        '   ',
        '(',
        ')',
        '()',
        '(MIT',
        'MIT)',
        'MIT OR',
        'OR MIT',
        'AND',
        'MIT AND AND Apache-2.0',
        'MIT Apache-2.0',
        'MIT WITH',
        'MIT WITH (E)',
        'MIT WITH E+',
        'WITH E',
        '(MIT OR Apache-2.0) WITH E',
        'MIT WITH E WITH F',
        'MIT/Apache-2.0',
        'MIT, Apache-2.0',
        '"MIT"',
        'GPL-2.0++',
        'MIT+OR',
        'Lizénz-1.0',
    ])('refuses %j', (input) => {
        expect(parseSpdxExpression(input)).toBeNull();
    });

    it('refuses input over 1 KiB without reading it, and reads input at exactly 1 KiB', () => {
        expect(SPDX_EXPRESSION_MAX_LENGTH).toBe(1024);
        const atLimit = 'A'.repeat(SPDX_EXPRESSION_MAX_LENGTH);
        expect(parseSpdxExpression(atLimit)).toEqual({ type: 'license', id: atLimit });
        expect(parseSpdxExpression(atLimit + 'A')).toBeNull();
        expect(parseSpdxExpression(' '.repeat(SPDX_EXPRESSION_MAX_LENGTH) + 'MIT')).toBeNull();
    });

    it('survives the deepest nesting the size limit allows', () => {
        const depth = (SPDX_EXPRESSION_MAX_LENGTH - 1) / 2;
        const nested = '('.repeat(Math.floor(depth)) + 'A' + ')'.repeat(Math.floor(depth));
        expect(nested.length).toBeLessThanOrEqual(SPDX_EXPRESSION_MAX_LENGTH);
        expect(parseSpdxExpression(nested)).toEqual({ type: 'license', id: 'A' });
    });
});
