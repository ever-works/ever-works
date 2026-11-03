#!/usr/bin/env node
/**
 * EW-58 — regenerate the embedded copy of the data-repository release
 * workflow.
 *
 * The canonical, human-editable artifact is a real GitHub Actions workflow
 * file:
 *
 *   packages/agent/src/generators/data-generator/assets/data-repo-release.yml
 *
 * Keeping it as YAML means it can be linted, reviewed with syntax
 * highlighting and copy-pasted straight into a data repository. But the data
 * generator has to WRITE that file at runtime, from code that is compiled by
 * SWC and re-bundled by esbuild for the Trigger.dev worker — neither of which
 * copies sibling assets or keeps `__dirname` meaningful. So the same bytes are
 * also embedded as a TypeScript string constant in:
 *
 *   packages/agent/src/generators/data-generator/release-workflow.ts
 *
 * This script rewrites the generated region of that constant from the YAML.
 * `release-workflow.spec.ts` asserts the two stay byte-identical, so a YAML
 * edit that forgets to run this script fails the agent test suite rather than
 * shipping a stale workflow.
 *
 * Usage:
 *   node scripts/generate-data-repo-release-workflow.mjs            # rewrite
 *   node scripts/generate-data-repo-release-workflow.mjs --check    # verify
 *
 * Exit codes:
 *   0 — the embedded copy matches the YAML (or was rewritten successfully).
 *   1 — `--check` was passed and the embedded copy is stale.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const generatorDir = join(repoRoot, 'packages', 'agent', 'src', 'generators', 'data-generator');
const yamlPath = join(generatorDir, 'assets', 'data-repo-release.yml');
const tsPath = join(generatorDir, 'release-workflow.ts');

const BEGIN = '// <generated from assets/data-repo-release.yml>';
const END = '// </generated from assets/data-repo-release.yml>';

/**
 * Escape the workflow so it survives a TypeScript template literal. Only
 * backticks, backslashes and `${` are meaningful there; everything else —
 * quotes, `$`, newlines — is carried verbatim.
 */
function toTemplateLiteral(source) {
    const escaped = source
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$\{/g, '\\${');
    return `export const DATA_REPO_RELEASE_WORKFLOW = \`${escaped}\`;`;
}

const workflow = readFileSync(yamlPath, 'utf-8').replace(/\r\n/g, '\n');
const current = readFileSync(tsPath, 'utf-8').replace(/\r\n/g, '\n');

const beginIndex = current.indexOf(BEGIN);
const endIndex = current.indexOf(END);
if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
    console.error(`Could not find the generated region markers in ${tsPath}.`);
    process.exit(1);
}

const next =
    current.slice(0, beginIndex) +
    `${BEGIN}\n${toTemplateLiteral(workflow)}\n${END}` +
    current.slice(endIndex + END.length);

if (next === current) {
    console.log('release-workflow.ts is already in sync with data-repo-release.yml.');
    process.exit(0);
}

if (process.argv.includes('--check')) {
    console.error(
        'release-workflow.ts is out of sync with data-repo-release.yml. ' +
            'Run: node scripts/generate-data-repo-release-workflow.mjs',
    );
    process.exit(1);
}

writeFileSync(tsPath, next, 'utf-8');
console.log(`Rewrote the embedded workflow in ${tsPath}.`);
