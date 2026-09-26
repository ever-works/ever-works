import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import type { LicenseClass } from '@ever-works/contracts';
import {
    classifyLicenseExpression,
    detectedLicenseSpdx,
    SPDX_NOASSERTION,
} from '../license-classify';
import {
    LICENSE_REGISTRY_SNAPSHOT,
    LICENSE_REGISTRY_SNAPSHOT_SOURCE,
    type LicenseRegistryContent,
} from '../license-registry.snapshot';

/**
 * APW-03 — `classifyLicenseExpression`, the pure classifier the Apps-catalog
 * port's `classifyLicense(spdx)` answers with (`app-source-catalog.port.ts`:
 * "`null` … yields `'unknown'`; the adapter must never guess a class").
 *
 * The rules under test are `catalog.md` §4 "Expressions":
 *
 * > `A OR B` takes the best class of its operands; `A AND B` takes the worst;
 * > `A WITH E` takes `A`'s class unless `E` is listed with a different
 * > `effect`. The fixed rank is green < amber < unknown < red … an operand the
 * > registry does not list … counts as `unknown`, so `MIT OR LicenseRef-x` is
 * > green while `MIT AND LicenseRef-x` is `unknown`.
 *
 * and §4's `unknown` row: the registry's `unknown.class` is advisory display
 * metadata that never becomes a licence class.
 *
 * Every case below runs against the bundled seed snapshot
 * (`ever-works/templates@46d12bb licenses.yml`) unless it builds its own
 * registry to reach a rule the five-licence seed cannot.
 */

type Case = readonly [input: string | null | undefined, expected: LicenseClass];

describe('classifyLicenseExpression — one licence id against the bundled seed', () => {
    it.each<Case>([
        ['MIT', 'green'],
        ['mit', 'green'],
        ['Apache-2.0', 'green'],
        ['apache-2.0', 'green'],
        ['AGPL-3.0-only', 'green'],
        // What GitHub's licence API reports for ever-works/directory-web-template:
        // not an SPDX id the registry lists, but one of its aliases.
        ['AGPL-3.0', 'green'],
        ['BUSL-1.1', 'amber'],
        ['PolyForm-Noncommercial-1.0.0', 'red'],
        ['polyform-noncommercial-1.0.0', 'red'],
        ['  MIT  ', 'green'],
    ])('%j ⇒ %s', (input, expected) => {
        expect(classifyLicenseExpression(input)).toBe(expected);
    });

    it.each<Case>([
        [null, 'unknown'],
        [undefined, 'unknown'],
        ['', 'unknown'],
        ['  ', 'unknown'],
        // GitHub's "a licence file I cannot name" was pinned here as `unknown` until the
        // owner decision of 2026-09-25 made it red — see the NOASSERTION block below.
        // SPDX's NONE ("no licence at all") is still `unknown`: detection found nothing.
        ['NONE', 'unknown'],
        // A real SPDX id the seed does not list: unknown, never a guessed class.
        ['GPL-3.0-only', 'unknown'],
        ['ISC', 'unknown'],
        ['LicenseRef-x', 'unknown'],
        // The trailing `+` is part of the id, and `MIT+` is not a listed id.
        ['MIT+', 'unknown'],
    ])('%j ⇒ %s', (input, expected) => {
        expect(classifyLicenseExpression(input)).toBe(expected);
    });
});

describe('classifyLicenseExpression — OR best, AND worst, WITH keeps the base (catalog.md §4)', () => {
    it.each<Case>([
        // catalog.md §4's own two examples.
        ['MIT OR LicenseRef-x', 'green'],
        ['MIT AND LicenseRef-x', 'unknown'],
        ['BUSL-1.1 OR MIT', 'green'],
        ['MIT AND BUSL-1.1', 'amber'],
        ['MIT AND PolyForm-Noncommercial-1.0.0', 'red'],
        ['(MIT OR BUSL-1.1) AND Apache-2.0', 'green'],
        ['Apache-2.0 WITH Classpath-exception-2.0', 'green'],
        // An exception the registry does not list keeps the base class.
        ['Apache-2.0 WITH Foo-exception', 'green'],
        ['BUSL-1.1 WITH Foo-exception', 'amber'],
        // Operators in any letter case.
        ['BUSL-1.1 or MIT', 'green'],
        ['MIT and BUSL-1.1', 'amber'],
        ['Apache-2.0 with Classpath-exception-2.0', 'green'],
        // Aliases resolve per operand.
        ['AGPL-3.0 AND BUSL-1.1', 'amber'],
    ])('%j ⇒ %s', (input, expected) => {
        expect(classifyLicenseExpression(input)).toBe(expected);
    });

    it('ranks unknown between amber and red — better than red for OR, worse than amber for AND', () => {
        expect(classifyLicenseExpression('LicenseRef-x OR PolyForm-Noncommercial-1.0.0')).toBe(
            'unknown',
        );
        expect(classifyLicenseExpression('LicenseRef-x AND PolyForm-Noncommercial-1.0.0')).toBe(
            'red',
        );
        expect(classifyLicenseExpression('BUSL-1.1 OR LicenseRef-x')).toBe('amber');
        expect(classifyLicenseExpression('BUSL-1.1 AND LicenseRef-x')).toBe('unknown');
    });

    it('binds AND tighter than OR', () => {
        // (red AND green) OR amber = amber; were OR tighter it would be red AND (green OR amber) = red.
        expect(classifyLicenseExpression('PolyForm-Noncommercial-1.0.0 AND MIT OR BUSL-1.1')).toBe(
            'amber',
        );
        // green OR (amber AND red) = green.
        expect(classifyLicenseExpression('MIT OR BUSL-1.1 AND PolyForm-Noncommercial-1.0.0')).toBe(
            'green',
        );
        // Parentheses override it: (green OR amber) AND red = red.
        expect(
            classifyLicenseExpression('(MIT OR BUSL-1.1) AND PolyForm-Noncommercial-1.0.0'),
        ).toBe('red');
    });

    it.each<Case>([
        ['(MIT', 'unknown'],
        ['MIT OR', 'unknown'],
        ['MIT)', 'unknown'],
        ['OR MIT', 'unknown'],
        ['MIT BUSL-1.1', 'unknown'],
        ['MIT WITH', 'unknown'],
        ['MIT/Apache-2.0', 'unknown'],
        ['MIT, Apache-2.0', 'unknown'],
        ['()', 'unknown'],
        // SPDX binds WITH to one licence id, never to a group.
        ['(MIT OR Apache-2.0) WITH Classpath-exception-2.0', 'unknown'],
        // Over 1 KiB is refused before it is read, even when every operand is green.
        [Array.from({ length: 200 }, () => 'MIT').join(' OR '), 'unknown'],
    ])('malformed or oversized %j ⇒ %s, never a partial answer', (input, expected) => {
        expect(classifyLicenseExpression(input)).toBe(expected);
    });

    it('reads an expression right at the size limit', () => {
        const expression = 'MIT OR ' + 'x'.repeat(1024 - 'MIT OR '.length);
        expect(expression).toHaveLength(1024);
        // The long operand is unlisted, and OR takes the best: green.
        expect(classifyLicenseExpression(expression)).toBe('green');
    });
});

describe('classifyLicenseExpression — exception effects (a registry the seed cannot express)', () => {
    const registry: LicenseRegistryContent = {
        ...LICENSE_REGISTRY_SNAPSHOT,
        exceptions: [
            { spdx: 'Classpath-exception-2.0', effect: 'none' },
            { spdx: 'Relax-exception', effect: 'class:green' },
            { spdx: 'Harden-exception', effect: 'class:red' },
        ],
    };

    it.each<Case>([
        ['BUSL-1.1 WITH Classpath-exception-2.0', 'amber'],
        ['BUSL-1.1 WITH Relax-exception', 'green'],
        ['BUSL-1.1 WITH relax-EXCEPTION', 'green'],
        ['MIT WITH Harden-exception', 'red'],
        ['MIT WITH Harden-exception OR BUSL-1.1', 'amber'],
    ])('%j ⇒ %s', (input, expected) => {
        expect(classifyLicenseExpression(input, registry)).toBe(expected);
    });

    it('never lifts an unlisted licence out of unknown, but lets an exception make it worse', () => {
        // The registry cannot vouch for a licence it does not list, whatever the
        // exception says; a harsher exception is still a harsher answer.
        expect(classifyLicenseExpression('LicenseRef-x WITH Relax-exception', registry)).toBe(
            'unknown',
        );
        expect(classifyLicenseExpression('LicenseRef-x WITH Harden-exception', registry)).toBe(
            'red',
        );
        expect(
            classifyLicenseExpression('LicenseRef-x WITH Classpath-exception-2.0', registry),
        ).toBe('unknown');
    });
});

describe('classifyLicenseExpression — NOASSERTION is red (owner decision, 2026-09-25)', () => {
    // GitHub reports `spdx_id: NOASSERTION` for a licence FILE it cannot name. ACC-NEG-01's
    // fixture classifies that red, and the owner decided the platform does too: a licence
    // the provider saw and could not identify is not "no licence", and the gate must not
    // treat it as the milder `unknown`. It is a fixed platform rule, like the classes of
    // R-3: no registry row (the seed lists none) can make it anything but red.
    it.each<Case>([
        ['NOASSERTION', 'red'],
        ['noassertion', 'red'],
        ['  NOASSERTION  ', 'red'],
        // An operand like any other: AND takes the worst, OR the best.
        ['MIT AND NOASSERTION', 'red'],
        ['MIT OR NOASSERTION', 'green'],
        ['NOASSERTION OR LicenseRef-x', 'unknown'],
        // An exception never lifts it.
        ['NOASSERTION WITH Classpath-exception-2.0', 'red'],
    ])('%j ⇒ %s', (input, expected) => {
        expect(classifyLicenseExpression(input)).toBe(expected);
    });

    it('stays red whatever a registry says about it', () => {
        const registry: LicenseRegistryContent = {
            ...LICENSE_REGISTRY_SNAPSHOT,
            licenses: [
                { spdx: 'NOASSERTION', name: 'No assertion', class: 'green', obligations: [] },
                ...LICENSE_REGISTRY_SNAPSHOT.licenses,
            ],
            exceptions: [{ spdx: 'Relax-exception', effect: 'class:green' }],
            aliases: [{ match: 'NOASSERTION', spdx: 'MIT' }],
        };

        expect(classifyLicenseExpression('NOASSERTION', registry)).toBe('red');
        expect(classifyLicenseExpression('NOASSERTION WITH Relax-exception', registry)).toBe('red');
    });

    it('maps the plugin contract’s licenseSpdx onto what is classified', () => {
        // `GitRepository.licenseSpdx`: `null` = "reported, and not a licence we can name"
        // (GitHub's NOASSERTION); `undefined` = "not reported" (no licence file at all).
        expect(detectedLicenseSpdx(null)).toBe(SPDX_NOASSERTION);
        expect(detectedLicenseSpdx(undefined)).toBeNull();
        expect(detectedLicenseSpdx('MIT')).toBe('MIT');
        expect(SPDX_NOASSERTION).toBe('NOASSERTION');
    });
});

describe('classifyLicenseExpression — the registry it is given', () => {
    it('reads the passed registry, not a hard-coded list', () => {
        const registry: LicenseRegistryContent = {
            ...LICENSE_REGISTRY_SNAPSHOT,
            licenses: [
                ...LICENSE_REGISTRY_SNAPSHOT.licenses,
                {
                    spdx: 'GPL-3.0-only',
                    name: 'GNU General Public License v3.0 only',
                    class: 'green',
                    obligations: [],
                },
            ],
        };

        expect(classifyLicenseExpression('GPL-3.0-only')).toBe('unknown');
        expect(classifyLicenseExpression('GPL-3.0-only', registry)).toBe('green');
    });

    it('resolves a whole-input licence title through the aliases', () => {
        // Aliases map licence TITLES (catalog.md §4 `aliases[]`), which carry spaces.
        expect(classifyLicenseExpression('The MIT License')).toBe('green');
        expect(classifyLicenseExpression('the mit license')).toBe('green');
        expect(classifyLicenseExpression('Apache License, Version 2.0')).toBe('green');
        expect(classifyLicenseExpression('Business Source License 1.1')).toBe('amber');
        expect(classifyLicenseExpression('Some Other License')).toBe('unknown');
    });

    it('answers unknown for a listed row whose class is outside green/amber/red', () => {
        const registry = {
            ...LICENSE_REGISTRY_SNAPSHOT,
            licenses: [{ spdx: 'Odd-1.0', name: 'Odd', class: 'purple', obligations: [] }],
        } as unknown as LicenseRegistryContent;

        expect(classifyLicenseExpression('Odd-1.0', registry)).toBe('unknown');
    });

    it('never answers the registry `unknown` block class — it is advisory display metadata', () => {
        const registry: LicenseRegistryContent = {
            ...LICENSE_REGISTRY_SNAPSHOT,
            unknown: { class: 'amber' },
        };

        expect(classifyLicenseExpression(null, registry)).toBe('unknown');
        expect(classifyLicenseExpression('', registry)).toBe('unknown');
        expect(classifyLicenseExpression('GPL-3.0-only', registry)).toBe('unknown');
        expect(classifyLicenseExpression('MIT AND LicenseRef-x', registry)).toBe('unknown');
    });

    it('does not even read the `unknown` block', () => {
        const registry = { ...LICENSE_REGISTRY_SNAPSHOT } as LicenseRegistryContent;
        Object.defineProperty(registry, 'unknown', {
            enumerable: true,
            get() {
                throw new Error('the registry unknown block was read');
            },
        });

        for (const input of [null, '', 'GPL-3.0-only', 'MIT', 'MIT AND LicenseRef-x', '(MIT']) {
            expect(() => classifyLicenseExpression(input, registry)).not.toThrow();
        }
    });
});

describe('classifyLicenseExpression — pure: no process.env, no I/O', () => {
    it('touches process.env for no classification', () => {
        const reads: PropertyKey[] = [];
        const realEnv = process.env;
        const spy = new Proxy(
            {},
            {
                get: (_target, key) => (reads.push(key), undefined),
                has: (_target, key) => (reads.push(key), false),
                ownKeys: () => (reads.push('ownKeys'), []),
            },
        );
        const answers: LicenseClass[] = [];
        process.env = spy as NodeJS.ProcessEnv;
        try {
            for (const input of [
                null,
                'MIT',
                'AGPL-3.0',
                'The MIT License',
                'MIT AND LicenseRef-x',
                'Apache-2.0 WITH Classpath-exception-2.0',
                '(MIT',
            ]) {
                answers.push(classifyLicenseExpression(input));
            }
        } finally {
            process.env = realEnv;
        }

        expect(reads).toEqual([]);
        expect(answers).toEqual([
            'unknown',
            'green',
            'green',
            'green',
            'unknown',
            'green',
            'unknown',
        ]);
    });

    it.each(['license-classify.ts', 'license-registry.snapshot.ts', 'spdx-expression.ts'])(
        '%s references no `process`, no require/dynamic import, and imports only its siblings and contracts',
        (file) => {
            const path = join(__dirname, '..', file);
            const source = ts.createSourceFile(
                path,
                readFileSync(path, 'utf8'),
                ts.ScriptTarget.Latest,
                true,
            );
            const specifiers: string[] = [];
            const findings: string[] = [];

            const visit = (node: ts.Node): void => {
                if (
                    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
                    node.moduleSpecifier &&
                    ts.isStringLiteral(node.moduleSpecifier)
                ) {
                    specifiers.push(node.moduleSpecifier.text);
                }
                if (ts.isIdentifier(node) && node.text === 'process') {
                    findings.push(`process at ${node.getStart()}`);
                }
                if (
                    ts.isCallExpression(node) &&
                    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
                ) {
                    findings.push(`dynamic load at ${node.getStart()}`);
                }
                ts.forEachChild(node, visit);
            };
            visit(source);

            expect(findings).toEqual([]);
            for (const specifier of specifiers) {
                expect(specifier === '@ever-works/contracts' || specifier.startsWith('./')).toBe(
                    true,
                );
            }
        },
    );
});

describe('LICENSE_REGISTRY_SNAPSHOT — the bundled seed, verbatim', () => {
    it('names where it was copied from, and that it is not legal-reviewed', () => {
        expect(LICENSE_REGISTRY_SNAPSHOT_SOURCE).toEqual({
            repository: 'ever-works/templates',
            path: 'licenses.yml',
            commitSha: '46d12bbfef59bc5358c85e5a997b52988327554c',
            legalReviewed: false,
        });
        expect(LICENSE_REGISTRY_SNAPSHOT.schemaVersion).toBe(1);
        expect(LICENSE_REGISTRY_SNAPSHOT.updatedAt).toBe('2026-09-17');
    });

    it('lists the seed licences with the seed classes, and nothing else', () => {
        expect(LICENSE_REGISTRY_SNAPSHOT.licenses.map((row) => [row.spdx, row.class])).toEqual([
            ['AGPL-3.0-only', 'green'],
            ['MIT', 'green'],
            ['Apache-2.0', 'green'],
            ['BUSL-1.1', 'amber'],
            ['PolyForm-Noncommercial-1.0.0', 'red'],
        ]);
        expect(LICENSE_REGISTRY_SNAPSHOT.exceptions).toEqual([
            { spdx: 'Classpath-exception-2.0', effect: 'none' },
        ]);
        expect(LICENSE_REGISTRY_SNAPSHOT.aliases).toHaveLength(7);
        expect(LICENSE_REGISTRY_SNAPSHOT.aliases).toContainEqual({
            match: 'AGPL-3.0',
            spdx: 'AGPL-3.0-only',
        });
    });

    it('points every alias at a listed licence, and requires an attestation on every non-green row', () => {
        const listed = new Set(LICENSE_REGISTRY_SNAPSHOT.licenses.map((row) => row.spdx));
        for (const alias of LICENSE_REGISTRY_SNAPSHOT.aliases) {
            expect(listed.has(alias.spdx)).toBe(true);
        }
        for (const row of LICENSE_REGISTRY_SNAPSHOT.licenses) {
            expect(row.attestation === undefined).toBe(row.class === 'green');
        }
    });

    it('keeps the advisory unknown block, which classification never reads', () => {
        expect(LICENSE_REGISTRY_SNAPSHOT.unknown?.class).toBe('amber');
        expect(LICENSE_REGISTRY_SNAPSHOT.unknown?.attestation?.textId).toBe('unknown-license-v1');
    });
});
