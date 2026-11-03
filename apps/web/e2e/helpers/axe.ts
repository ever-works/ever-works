/**
 * axe-core for the e2e accessibility specs, loaded from the installed package.
 *
 * The specs used to append `<script src="https://unpkg.com/axe-core@…">` and skip
 * themselves when it did not load. The app's own Content-Security-Policy lists no
 * CDN in `script-src`, so it never loaded: every one of those axe checks skipped,
 * in CI and locally alike (Gauzy Ever Works #533).
 *
 * `page.addScriptTag({ path })` reads `axe-core/axe.min.js` from `node_modules`
 * and injects its text as an inline script, which the CSP allows
 * (`script-src 'unsafe-inline'`, `next.config.ts` and `src/proxy.ts`). No network,
 * no `bypassCSP`, and the version is the one in the lockfile.
 *
 * A load failure throws: an axe check that cannot run fails its test rather than
 * skipping it.
 */
import type { Page } from '@playwright/test';

const AXE_SCRIPT_PATH = require.resolve('axe-core/axe.min.js');

/** The WCAG 2.0 A and AA rule tags most of the specs run. */
export const WCAG_A_AA = ['wcag2a', 'wcag2aa'] as const;

export interface AxeViolation {
    id: string;
    impact: string | null;
    help?: string;
    nodes: Array<{ html?: string; target?: string[]; failureSummary?: string }>;
}

export interface RunAxeOptions {
    /** CSS selectors to scan; the whole document when omitted. Each must match. */
    include?: string[];
    /** Run only the rules with these tags; every rule when omitted. */
    tags?: readonly string[];
}

/** Inject axe-core into the current document (once per navigation). Throws when it cannot. */
export async function injectAxe(page: Page): Promise<void> {
    const present = await page.evaluate(
        () => typeof (window as unknown as { axe?: { run?: unknown } }).axe?.run === 'function',
    );
    if (present) return;
    await page.addScriptTag({ path: AXE_SCRIPT_PATH });
    const loaded = await page.evaluate(
        () => typeof (window as unknown as { axe?: { run?: unknown } }).axe?.run === 'function',
    );
    if (!loaded) {
        throw new Error(
            `axe-core did not load from ${AXE_SCRIPT_PATH} (window.axe.run is missing after injection)`,
        );
    }
}

/** Run axe on the page (or on `include`) and answer its violations. */
export async function runAxe(page: Page, options: RunAxeOptions = {}): Promise<AxeViolation[]> {
    await injectAxe(page);
    return page.evaluate(
        async ({ include, tags }) => {
            const w = window as unknown as {
                axe: {
                    run: (
                        context: unknown,
                        options: unknown,
                    ) => Promise<{ violations: AxeViolation[] }>;
                };
            };
            const context = include ? { include: include.map((selector) => [selector]) } : document;
            const result = await w.axe.run(context, {
                resultTypes: ['violations'],
                ...(tags ? { runOnly: { type: 'tag', values: tags } } : {}),
            });
            return result.violations;
        },
        { include: options.include, tags: options.tags ? [...options.tags] : undefined },
    );
}

/** The serious and critical violations. */
export function seriousViolations(violations: AxeViolation[]): AxeViolation[] {
    return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

/** One line per violation: rule, impact and the offending nodes, for assertion messages. */
export function describeViolations(violations: AxeViolation[]): string {
    return violations
        .map(
            (v) =>
                `${v.id} (${v.impact}): ${v.nodes.map((n) => (n.target ?? []).join(' ')).join(' | ')}`,
        )
        .join('; ');
}
