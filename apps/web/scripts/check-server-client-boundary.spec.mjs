#!/usr/bin/env node
/**
 * Tests for `check-server-client-boundary.mjs` — the server→client value-import
 * guard (`node --test apps/web/scripts/check-server-client-boundary.spec.mjs`).
 *
 * Every case builds its own fixture tree under `os.tmpdir()` (never inside the
 * repo) and drives the analyzer **through its CLI**, so the exit code, the
 * `--json` payload and the plain-text report are all covered — not just an
 * internal function.
 *
 * ## What is pinned here
 *
 *   (a) server file importing a VALUE from a client module          → violation
 *   (b) server file importing a VALUE from a server module          → clean
 *   (c) `import type …` from a client module (named + default)      → clean
 *   (d) mixed import, every named binding `type`-prefixed           → clean
 *   (e) a client module that RE-EXPORTS the value from a server-safe
 *       module does not excuse the import (the `30f2e00ba` fix shape,
 *       and the shape of the `/works/[id]` crash)                   → violation
 *   (f) client file importing from a client file                    → clean
 *   (g) `@/…` alias resolution via the fixture `tsconfig.json` `paths`
 *   (h) multi-line imports, `index.<ext>` resolution, `.js`→`.ts`
 *   (i) `--skip-component-renders` narrows the report but never hides a
 *       called/read value
 *   (j) the report contract: exit codes, the exact JSON keys, the line format
 *
 * ## Blind spots this suite does NOT cover (they are real)
 *
 *   - **Barrels.** A *server* module that re-exports from a client module
 *     (`export { X } from './XClient'`) is not followed: the import of `X`
 *     lands on the server barrel and is reported clean. Following it would
 *     flag every `components/**\/index.ts` that re-exports Client Components —
 *     which is legal and ubiquitous — so the check deliberately stops at the
 *     importing module. `KNOWN BLIND SPOT` below pins that behaviour.
 *   - **Dynamic imports.** `await import('./client')` and `next/dynamic(() =>
 *     import('./client'))` are not analyzed (only counted, in `--stats`).
 *   - **`require()`** outside the TS `import x = require('./y')` form.
 *   - **Alias forms other than `compilerOptions.paths`** — `extends` chains are
 *     not resolved, and neither are bundler-only aliases.
 *   - **`.mjs`/`.mts`/`.cjs` modules** are not walked (`.ts`/`.tsx` only), so a
 *     client directive in one of those is never seen. There are none in
 *     `apps/web/src` today.
 *   - **"Server" is a per-file classification.** A module without the directive
 *     that is only ever imported *by* client modules is part of the client
 *     bundle and cannot crash a server render — React's boundary is transitive
 *     downwards. The analyzer reports it anyway (that is the rule), so a
 *     violation here means "this file is not marked", not necessarily "this
 *     crashes".
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ANALYZER = fileURLToPath(new URL('./check-server-client-boundary.mjs', import.meta.url));
const TSCONFIG = `${JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }, null, 4)}\n`;

const toPosix = (p) => p.split(sep).join('/');

/** Build a throwaway tree: `<tmp>/tsconfig.json` + `<tmp>/src/**`. */
function makeFixture(t, files) {
    const dir = mkdtempSync(join(tmpdir(), 'ewb-boundary-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG, 'utf8');
    for (const [relative, content] of Object.entries(files)) {
        const full = join(dir, 'src', relative);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content, 'utf8');
    }
    return {
        dir,
        src: join(dir, 'src'),
        /** The absolute, forward-slashed path the analyzer prints for `src/<rel>`. */
        path: (relative) => toPosix(join(dir, 'src', relative)),
    };
}

/** Run the analyzer CLI. Returns the exit code plus parsed JSON / raw stdout / stderr. */
function runAnalyzer(srcDir, args = []) {
    const argv = [ANALYZER, ...args, '--root', srcDir];
    try {
        const stdout = execFileSync(process.execPath, argv, { encoding: 'utf8' });
        return { status: 0, stdout, stderr: '', json: parse(stdout) };
    } catch (error) {
        if (typeof error.status !== 'number' || error.stdout === undefined) throw error;
        return {
            status: error.status,
            stdout: error.stdout,
            stderr: error.stderr ?? '',
            json: parse(error.stdout),
        };
    }
}

function parse(stdout) {
    const text = stdout.trim();
    return text.startsWith('[') ? JSON.parse(text) : null;
}

const json = (srcDir, args = []) => runAnalyzer(srcDir, ['--json', ...args]);

// ---------------------------------------------------------------------------
// Fixture sources
// ---------------------------------------------------------------------------

const CLIENT_MODULE = `'use client';

export const LABEL = 'label';
export function formatLabel(value: string): string {
    return \`[\${value}]\`;
}
export function ClientWidget() {
    return null;
}
`;

const SERVER_MODULE = `export const LABEL = 'label';
export function formatLabel(value: string): string {
    return value;
}
`;

/** A client module that re-exports a value declared in a server-safe module. */
const CLIENT_REEXPORT_MODULE = `'use client';

import { formatLabel } from './server-safe';

export { formatLabel };
export function ClientWidget() {
    return null;
}
`;

const SERVER_SAFE_MODULE = `export function formatLabel(value: string): string {
    return \`[\${value}]\`;
}
`;

// ---------------------------------------------------------------------------
// (a) server → value from a client module
// ---------------------------------------------------------------------------

test('(a) a server module importing a value from a client module is a violation', (t) => {
    const fixture = makeFixture(t, {
        'lib/labels.tsx': CLIENT_MODULE,
        'app/page.tsx': `import { formatLabel } from '../lib/labels';

export default function Page() {
    const label = formatLabel('x');
    return label;
}
`,
    });

    const result = json(fixture.src);
    assert.equal(result.status, 1, 'exit code must be 1 when a violation is found');
    assert.equal(result.json.length, 1, 'exactly one violation');
    assert.deepEqual(result.json[0], {
        file: fixture.path('app/page.tsx'),
        line: 1,
        bindings: 'formatLabel',
        target: fixture.path('lib/labels.tsx'),
    });
});

// ---------------------------------------------------------------------------
// (b) server → value from a server module
// ---------------------------------------------------------------------------

test('(b) a server module importing a value from a server module is clean', (t) => {
    const fixture = makeFixture(t, {
        'lib/labels.ts': SERVER_MODULE,
        'app/page.tsx': `import { formatLabel } from '../lib/labels';

export default function Page() {
    return formatLabel('x');
}
`,
    });

    const result = json(fixture.src);
    assert.equal(result.status, 0, 'clean tree must exit 0');
    assert.deepEqual(result.json, []);
});

// ---------------------------------------------------------------------------
// (c) import type from a client module
// ---------------------------------------------------------------------------

test('(c) `import type` from a client module is clean (named, default, aliased)', (t) => {
    const fixture = makeFixture(t, {
        'lib/labels.tsx': `'use client';

export type Label = string;
export default interface DefaultShape {
    value: string;
}
`,
        'app/one.ts': `import type { Label } from '../lib/labels';

export const one: Label = 'x';
`,
        'app/two.ts': `import type DefaultShape from '../lib/labels';

export const two: DefaultShape = { value: 'x' };
`,
        'app/three.ts': `import type DefaultShape, { Label } from '../lib/labels';

export const three: [DefaultShape, Label] | null = null;
`,
    });

    const result = json(fixture.src);
    assert.equal(
        result.status,
        0,
        'a type-only import is erased, so it can never be a client reference',
    );
    assert.deepEqual(result.json, []);
});

// ---------------------------------------------------------------------------
// (d) mixed import, every named binding type-prefixed
// ---------------------------------------------------------------------------

test('(d) a mixed import whose named bindings are all `type`-prefixed is clean', (t) => {
    const fixture = makeFixture(t, {
        'lib/labels.tsx': `'use client';

export type Alpha = string;
export type Beta = number;
export type Gamma = boolean;
export function formatLabel(value: string): string {
    return value;
}
`,
        'app/clean.ts': `import { type Alpha, type Beta } from '../lib/labels';

export const clean: [Alpha, Beta] | null = null;
`,
        'app/clean-alias.ts': `import { type Alpha, type Beta as B } from '../lib/labels';

export const clean: [Alpha, B] | null = null;
`,
    });

    const result = json(fixture.src);
    assert.equal(result.status, 0, 'every binding of both imports is a type');
    assert.deepEqual(result.json, []);
});

test('(d2) but ONE non-type binding in the same clause is still a violation', (t) => {
    const fixture = makeFixture(t, {
        'lib/labels.tsx': `'use client';

export type Alpha = string;
export function formatLabel(value: string): string {
    return value;
}
`,
        'app/mixed.ts': `import { type Alpha, formatLabel } from '../lib/labels';

export function use(label: Alpha) {
    return formatLabel(label);
}
`,
    });

    const result = json(fixture.src);
    assert.equal(result.status, 1);
    assert.equal(result.json.length, 1);
    assert.equal(
        result.json[0].bindings,
        'formatLabel',
        'the type-prefixed binding must not be listed',
    );
});

// ---------------------------------------------------------------------------
// (e) re-export from a client module does not excuse the import
// ---------------------------------------------------------------------------

test('(e) a value a client module RE-EXPORTS from a server-safe module is still a violation', (t) => {
    const fixture = makeFixture(t, {
        'lib/server-safe.ts': SERVER_SAFE_MODULE,
        'lib/client-card.tsx': CLIENT_REEXPORT_MODULE,
        'app/page.tsx': `import { formatLabel } from '../lib/client-card';

export default function Page() {
    return formatLabel('x');
}
`,
    });

    const result = json(fixture.src);
    assert.equal(
        result.status,
        1,
        'the boundary is the module carrying `use client`, not the module that declares the value',
    );
    assert.equal(result.json.length, 1);
    assert.deepEqual(result.json[0], {
        file: fixture.path('app/page.tsx'),
        line: 1,
        bindings: 'formatLabel',
        target: fixture.path('lib/client-card.tsx'),
    });

    // …and the same import pointed at the server-safe module is clean: that IS
    // the fix, so the check must not punish it.
    const fixed = makeFixture(t, {
        'lib/server-safe.ts': SERVER_SAFE_MODULE,
        'lib/client-card.tsx': CLIENT_REEXPORT_MODULE,
        'app/page.tsx': `import { formatLabel } from '../lib/server-safe';

export default function Page() {
    return formatLabel('x');
}
`,
    });
    const fixedResult = json(fixed.src);
    assert.equal(fixedResult.status, 0, 'importing the server-safe module directly must be clean');
    assert.deepEqual(fixedResult.json, []);

    // `export * from './server-safe'` in the client module must not excuse it either.
    const star = makeFixture(t, {
        'lib/server-safe.ts': SERVER_SAFE_MODULE,
        'lib/client-card.tsx': `'use client';

export * from './server-safe';
`,
        'app/page.tsx': `import { formatLabel } from '../lib/client-card';

export default function Page() {
    return formatLabel('x');
}
`,
    });
    const starResult = json(star.src);
    assert.equal(starResult.status, 1, '`export *` re-exports the client reference too');
    assert.equal(starResult.json.length, 1);
});

// ---------------------------------------------------------------------------
// (f) client → client
// ---------------------------------------------------------------------------

test('(f) a client module importing from a client module is clean', (t) => {
    const fixture = makeFixture(t, {
        'lib/other.tsx': CLIENT_MODULE,
        'lib/panel.tsx': `'use client';

import { formatLabel } from './other';

export function Panel() {
    return formatLabel('x');
}
`,
    });

    const result = json(fixture.src);
    assert.equal(result.status, 0, 'both sides are already client modules');
    assert.deepEqual(result.json, []);
});

// ---------------------------------------------------------------------------
// (g) @/ alias resolution from tsconfig paths
// ---------------------------------------------------------------------------

test('(g) the `@/` alias resolves through the fixture tsconfig `paths`', (t) => {
    const fixture = makeFixture(t, {
        'lib/labels.tsx': CLIENT_MODULE,
        'app/page.tsx': `import { formatLabel } from '@/lib/labels';

export default function Page() {
    return formatLabel('x');
}
`,
    });

    const result = json(fixture.src);
    assert.equal(result.status, 1, '@/ must resolve via compilerOptions.paths, not be skipped');
    assert.equal(result.json[0].target, fixture.path('lib/labels.tsx'));
});

test('(g2) an unanalyzable specifier (bare package, unknown alias) is not a violation', (t) => {
    const fixture = makeFixture(t, {
        'app/page.tsx': `import { formatLabel } from 'some-package';
import { other } from '~unknown/alias';

export const value = [formatLabel, other];
`,
    });

    const result = json(fixture.src);
    assert.equal(result.status, 0);
    assert.deepEqual(result.json, []);
});

// ---------------------------------------------------------------------------
// (h) multi-line imports + file resolution forms
// ---------------------------------------------------------------------------

test('(h) a multi-line import lists every value binding with its first line', (t) => {
    const fixture = makeFixture(t, {
        'lib/labels.tsx': CLIENT_MODULE,
        'app/page.tsx': `import {
    formatLabel,
    LABEL,
    ClientWidget,
} from '../lib/labels';

export const value = [formatLabel, LABEL, ClientWidget];
`,
    });

    const result = json(fixture.src);
    assert.equal(result.status, 1);
    assert.equal(result.json.length, 1);
    assert.equal(result.json[0].line, 1, 'the reported line is the statement start');
    assert.equal(result.json[0].bindings, 'formatLabel, LABEL, ClientWidget');
});

test('(h2) `index.<ext>` and an explicit `.js` specifier both resolve', (t) => {
    const fixture = makeFixture(t, {
        'lib/widget/index.tsx': CLIENT_MODULE,
        'lib/other.tsx': CLIENT_MODULE,
        'app/page.tsx': `import { formatLabel } from '../lib/widget';
import { LABEL } from '../lib/other.js';

export const value = [formatLabel, LABEL];
`,
    });

    const result = json(fixture.src);
    assert.equal(result.status, 1);
    assert.equal(
        result.json.length,
        2,
        'both the directory index and the .js→.tsx form must resolve',
    );
    assert.deepEqual(
        result.json.map((v) => v.target).sort(),
        [fixture.path('lib/other.tsx'), fixture.path('lib/widget/index.tsx')].sort(),
    );
});

test('(h3) a semicolon-less import at end of file is still parsed', (t) => {
    const fixture = makeFixture(t, {
        'lib/labels.tsx': CLIENT_MODULE,
        'app/page.tsx': `import { formatLabel } from '../lib/labels'
`,
    });

    const result = json(fixture.src);
    assert.equal(result.status, 1, 'ASI-terminated imports count');
    assert.equal(result.json[0].bindings, 'formatLabel');
});

test('(h4) a directive is not recognised in a comment, and a client file is skipped', (t) => {
    const fixture = makeFixture(t, {
        // The directive is inside a block comment → this is a SERVER module.
        'lib/fake-client.ts': `/*
 * 'use client'
 */
export const VALUE = 1;
`,
        // A real directive after a comment IS a client module.
        'lib/real-client.tsx': `// a leading comment is allowed before the directive
'use client';

export const CLIENT_VALUE = 2;
`,
        'app/page.tsx': `import { VALUE } from '../lib/fake-client';
import { CLIENT_VALUE } from '../lib/real-client';

export const value = [VALUE, CLIENT_VALUE];
`,
    });

    const result = json(fixture.src);
    assert.equal(result.status, 1);
    assert.equal(result.json.length, 1, 'only the real client module crosses the boundary');
    assert.equal(result.json[0].target, fixture.path('lib/real-client.tsx'));
});

// ---------------------------------------------------------------------------
// (i) --skip-component-renders
// ---------------------------------------------------------------------------

test('(i) --skip-component-renders drops a JSX-rendered component but keeps a called value', (t) => {
    const fixture = makeFixture(t, {
        'lib/widget.tsx': CLIENT_MODULE,
        'lib/labels.tsx': CLIENT_MODULE,
        'app/page.tsx': `import { ClientWidget } from '../lib/widget';
import { formatLabel } from '../lib/labels';

export default function Page() {
    const label = formatLabel('x');
    return <ClientWidget label={label} />;
}
`,
    });

    const wide = json(fixture.src);
    assert.equal(wide.status, 1);
    assert.equal(wide.json.length, 2, 'the plain rule reports both imports');

    const narrow = json(fixture.src, ['--skip-component-renders']);
    assert.equal(narrow.status, 1, 'the called value must survive the narrowing');
    assert.equal(narrow.json.length, 1);
    assert.equal(narrow.json[0].bindings, 'formatLabel');
    assert.match(narrow.stderr, /1 import skipped as JSX-component renders/);

    // A component that is ALSO called is not a pure render — it stays reported.
    const called = makeFixture(t, {
        'lib/widget.tsx': CLIENT_MODULE,
        'app/page.tsx': `import { ClientWidget } from '../lib/widget';

export default function Page() {
    const instance = ClientWidget();
    return <ClientWidget />;
}
`,
    });
    const calledResult = json(called.src, ['--skip-component-renders']);
    assert.equal(
        calledResult.status,
        1,
        'a component that is called on the server is a crash, not a render',
    );
    assert.equal(calledResult.json.length, 1);
});

// ---------------------------------------------------------------------------
// (j) report contract
// ---------------------------------------------------------------------------

test('(j) the JSON payload has exactly the four documented keys', (t) => {
    const fixture = makeFixture(t, {
        'lib/labels.tsx': CLIENT_MODULE,
        'app/page.tsx': `import { formatLabel } from '../lib/labels';

export const value = formatLabel('x');
`,
    });

    const result = json(fixture.src);
    assert.equal(result.json.length, 1);
    assert.deepEqual(Object.keys(result.json[0]), ['file', 'line', 'bindings', 'target']);
});

test('(j2) the plain-text report is one line per violation plus a count', (t) => {
    const fixture = makeFixture(t, {
        'lib/labels.tsx': CLIENT_MODULE,
        'app/page.tsx': `import { formatLabel } from '../lib/labels';

export const value = formatLabel('x');
`,
    });

    const result = runAnalyzer(fixture.src);
    assert.equal(result.status, 1);
    // The report is one non-empty line per violation, then a blank line, then
    // the count line.
    const lines = result.stdout
        .trimEnd()
        .split(/\r?\n/)
        .filter((line) => line !== '');
    assert.deepEqual(
        lines.map((line) =>
            line.replace(/\(\d+ client modules? scanned\)/, '(N client modules scanned)'),
        ),
        [
            `${fixture.path('app/page.tsx')}:1 imports formatLabel from client module ${fixture.path('lib/labels.tsx')}`,
            '1 server→client value import violation in 1 server module (N client modules scanned).',
        ],
    );
});

test('(j3) exit codes: 0 clean, 1 with violations, 2 on a usage error', (t) => {
    const clean = makeFixture(t, {
        'lib/labels.ts': SERVER_MODULE,
        'app/page.tsx': `import { formatLabel } from '../lib/labels';

export const value = formatLabel('x');
`,
    });
    assert.equal(runAnalyzer(clean.src).status, 0);

    const dirty = makeFixture(t, {
        'lib/labels.tsx': CLIENT_MODULE,
        'app/page.tsx': `import { formatLabel } from '../lib/labels';

export const value = formatLabel('x');
`,
    });
    assert.equal(runAnalyzer(dirty.src).status, 1);

    const usage = runAnalyzer(clean.src, ['--not-a-flag']);
    assert.equal(usage.status, 2, 'an unknown flag is a usage error, never a silent pass');
    assert.match(usage.stderr, /unknown argument: --not-a-flag/);

    const missing = runAnalyzer(join(clean.dir, 'does-not-exist'));
    assert.equal(missing.status, 2, 'a missing --root is a usage error');
});

test('(j4) test files and `node_modules` are not walked', (t) => {
    const fixture = makeFixture(t, {
        'lib/labels.tsx': CLIENT_MODULE,
        'app/page.unit.spec.tsx': `import { formatLabel } from '../lib/labels';

export const value = formatLabel('x');
`,
        'app/page.test.ts': `import { formatLabel } from '../lib/labels';

export const value = formatLabel('x');
`,
        'node_modules/pkg/page.tsx': `import { formatLabel } from '../../lib/labels';

export const value = formatLabel('x');
`,
    });

    const result = json(fixture.src);
    assert.equal(result.status, 0, 'spec/test files and vendored code are out of scope');
    assert.deepEqual(result.json, []);
});

// ---------------------------------------------------------------------------
// KNOWN BLIND SPOT — pinned so a future change to it is a deliberate one
// ---------------------------------------------------------------------------

test('KNOWN BLIND SPOT: a server barrel re-exporting a client module is not followed by default', (t) => {
    const fixture = makeFixture(t, {
        'lib/labels.tsx': CLIENT_MODULE,
        'lib/index.ts': `export { formatLabel } from './labels';
`,
        'app/page.tsx': `import { formatLabel } from '../lib';

export const value = formatLabel('x');
`,
    });

    const result = json(fixture.src);
    assert.equal(
        result.status,
        0,
        'barrels are not chased by DEFAULT: re-exporting Client Components from an index is legal and everywhere',
    );
    assert.deepEqual(result.json, []);

    // The blind spot is closable on demand. Pinned in both directions so neither
    // the default's silence nor the flag's report can change unnoticed.
    const chased = json(fixture.src, ['--follow-barrels']);
    assert.equal(chased.status, 1, '--follow-barrels must report the same route');
    assert.equal(chased.json.length, 1);
    assert.deepEqual(chased.json[0], {
        file: fixture.path('app/page.tsx'),
        line: 1,
        bindings: 'formatLabel',
        target: fixture.path('lib/labels.tsx'),
    });
});

// ---------------------------------------------------------------------------
// --follow-barrels — the opt-in rule that closes the C22/C27 blind spot
// ---------------------------------------------------------------------------

test('(barrel-1) a named re-export through a barrel is reported when asked', (t) => {
    const fixture = makeFixture(t, {
        'lib/labels.tsx': CLIENT_MODULE,
        'lib/barrel.ts': `export { formatLabel } from './labels';
`,
        'app/page.tsx': `import { formatLabel } from '../lib/barrel';

export const value = formatLabel('x');
`,
    });

    const result = json(fixture.src, ['--follow-barrels']);
    assert.equal(result.status, 1);
    assert.equal(result.json.length, 1);
    assert.equal(result.json[0].target, fixture.path('lib/labels.tsx'));
    assert.equal(result.json[0].line, 1);
});

test('(barrel-2) an ALIASED re-export is followed by the name each side uses', (t) => {
    const fixture = makeFixture(t, {
        // The client module exports `formatLabel`; the barrel advertises it as
        // `renderLabel`, and the importer asks for `renderLabel`.
        'lib/labels.tsx': CLIENT_MODULE,
        'lib/barrel.ts': `export { formatLabel as renderLabel } from './labels';
`,
        'app/page.tsx': `import { renderLabel } from '../lib/barrel';

export const value = renderLabel('x');
`,
    });

    const result = json(fixture.src, ['--follow-barrels']);
    assert.equal(result.status, 1, 'the alias mapping must be followed');
    assert.equal(result.json.length, 1);
    assert.equal(result.json[0].target, fixture.path('lib/labels.tsx'));
});

test('(barrel-3) TWO barrels deep is still reported', (t) => {
    const fixture = makeFixture(t, {
        'lib/labels.tsx': CLIENT_MODULE,
        'lib/inner.ts': `export { formatLabel } from './labels';
`,
        'lib/outer.ts': `export { formatLabel } from './inner';
`,
        'app/page.tsx': `import { formatLabel } from '../lib/outer';

export const value = formatLabel('x');
`,
    });

    const result = json(fixture.src, ['--follow-barrels']);
    assert.equal(result.status, 1);
    assert.equal(result.json.length, 1);
    assert.equal(result.json[0].target, fixture.path('lib/labels.tsx'));
});

test('(barrel-4) `export *` is claimed ONLY when the client module declares the name', (t) => {
    // This is the false positive the first version of the mode produced on the
    // real tree: a utils barrel star-re-exports several modules, one of them a
    // client module, and a name declared by a PLAIN SIBLING was attributed to the
    // client module (`sanitizeText` → `./refresh-page.ts`, which declares only
    // `pageIntervalRefresh`). Over-reporting is how a real signal gets ignored, so
    // the star case verifies the declaration.
    //
    // Note the client module here is written inline and declares a DIFFERENT name
    // from the plain sibling: reusing `CLIENT_MODULE` would declare `formatLabel`
    // too and quietly turn this case into its own positive control.
    const files = {
        'lib/client-only.tsx': `'use client';

export function clientOnly(value: string): string {
    return value;
}
`,
        'lib/plain.ts': `export function formatLabel(value: string): string {
    return value;
}
`,
        'lib/index.ts': `export * from './client-only';
export * from './plain';
`,
    };

    const notDeclaredByClient = makeFixture(t, {
        ...files,
        'app/plain-user.tsx': `import { formatLabel } from '../lib';

export const value = formatLabel('x');
`,
    });

    const result = json(notDeclaredByClient.src, ['--follow-barrels']);
    assert.deepEqual(
        result.json,
        [],
        'a name the client module does NOT declare is not a client value, even through a star barrel',
    );
    assert.equal(result.status, 0);

    // Positive control in the same fixture shape: the name the client module DOES
    // declare is still reported through the same star barrel.
    const declaredByClient = makeFixture(t, {
        ...files,
        'app/uses-client-only.tsx': `import { clientOnly } from '../lib';

export const value = clientOnly('x');
`,
    });

    const positive = json(declaredByClient.src, ['--follow-barrels']);
    assert.equal(positive.status, 1, 'the star route must still be reported when it is real');
    assert.equal(positive.json.length, 1);
    assert.equal(positive.json[0].target, declaredByClient.path('lib/client-only.tsx'));
});

test('(barrel-5) a NAMESPACE import from a barrel is not attributed (documented limit)', (t) => {
    const fixture = makeFixture(t, {
        'lib/labels.tsx': CLIENT_MODULE,
        'lib/barrel.ts': `export { formatLabel } from './labels';
`,
        'app/page.tsx': `import * as utils from '../lib/barrel';

export const value = utils.formatLabel('x');
`,
    });

    const result = json(fixture.src, ['--follow-barrels']);
    assert.equal(
        result.status,
        0,
        'a namespace import asks for the whole module object, so no single name can be attributed',
    );
});
