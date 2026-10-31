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
import { test, type Page } from '@playwright/test';

const AXE_SCRIPT_PATH = require.resolve('axe-core/axe.min.js');

/** The WCAG 2.0 A and AA rule tags most of the specs run. */
export const WCAG_A_AA = ['wcag2a', 'wcag2aa'] as const;

export interface AxeNode {
    html?: string;
    target?: string[];
    failureSummary?: string;
    /** The checks that failed; `color-contrast` carries the colours it measured. */
    any?: Array<{
        id: string;
        data?: { fgColor?: string; bgColor?: string; contrastRatio?: number } | null;
    }>;
}

export interface AxeViolation {
    id: string;
    impact: string | null;
    help?: string;
    nodes: AxeNode[];
}

/**
 * `color-contrast` failures caused by an app-wide colour token, not by the component under
 * test. Each is an owner decision (Gauzy Ever Works #533): until its token changes, a node
 * that fails only because of it is recorded on the test as an `axe-pending-token`
 * annotation instead of failing the spec. Keyed on the colour axe measured; delete an
 * entry once its token is fixed and the specs fail again on anything it hid.
 */
const PENDING_TOKEN_FOREGROUNDS: Record<string, string> = {
    '#94a3b8': '--color-text-muted',
    '#3079fb': '--primary (text-primary)',
    '#ef4444': '--color-danger (text-danger)',
    '#05df72': '--color-success (text-success)',
};
const PENDING_TOKEN_BACKGROUNDS: Record<string, string> = {
    '#3079fb': '--primary (bg-primary)',
};

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

function pendingTokenOf(violation: AxeViolation, node: AxeNode): string | null {
    if (violation.id !== 'color-contrast') return null;
    const data = node.any?.find((check) => check.id === 'color-contrast')?.data;
    const fg = data?.fgColor?.toLowerCase() ?? '';
    const bg = data?.bgColor?.toLowerCase() ?? '';
    return PENDING_TOKEN_FOREGROUNDS[fg] ?? PENDING_TOKEN_BACKGROUNDS[bg] ?? null;
}

/**
 * The violations without the nodes that fail only on a pending token (see
 * `PENDING_TOKEN_FOREGROUNDS`), which are counted per token on the running test instead.
 */
export function withoutPendingTokenContrast(violations: AxeViolation[]): AxeViolation[] {
    const pending = new Map<string, number>();
    const kept: AxeViolation[] = [];
    for (const violation of violations) {
        const nodes = violation.nodes.filter((node) => {
            const token = pendingTokenOf(violation, node);
            if (token) pending.set(token, (pending.get(token) ?? 0) + 1);
            return token === null;
        });
        if (nodes.length > 0) kept.push({ ...violation, nodes });
    }
    if (pending.size > 0) {
        test.info().annotations.push({
            type: 'axe-pending-token',
            description: [...pending].map(([token, n]) => `${token}: ${n} node(s)`).join('; '),
        });
    }
    return kept;
}

/** The serious and critical violations, less the pending-token contrast nodes. */
export function seriousViolations(violations: AxeViolation[]): AxeViolation[] {
    return withoutPendingTokenContrast(violations).filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
    );
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
