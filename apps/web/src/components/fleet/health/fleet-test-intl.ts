import messages from '../../../../messages/en.json';

/**
 * Test-only translator over the REAL `en.json` for the fleet health specs.
 *
 * Loading the real `next-intl` under Vitest pulls in `next/navigation`, which
 * does not resolve as an ES module outside Next — so the specs mock
 * `next-intl` with this instead of echoing keys. It understands the subset of
 * ICU the fleet strings use (`{name}` and `{n, plural, =0 {…} one {…} other
 * {…}}` with `#`) and THROWS on a key `en.json` lacks, so a component asking
 * for a missing string fails its test.
 */

type Values = Record<string, string | number | null | undefined>;

function lookup(path: string): string {
    let node: unknown = messages;
    for (const part of path.split('.')) {
        if (!node || typeof node !== 'object' || !(part in (node as Record<string, unknown>))) {
            throw new Error(`Missing message: ${path}`);
        }
        node = (node as Record<string, unknown>)[part];
    }
    if (typeof node !== 'string') throw new Error(`Not a message: ${path}`);
    return node;
}

/** The index of the brace that closes the one opened at `open`. */
function closing(text: string, open: number): number {
    let depth = 0;
    for (let index = open; index < text.length; index += 1) {
        if (text[index] === '{') depth += 1;
        if (text[index] === '}') {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    throw new Error(`Unbalanced braces in: ${text}`);
}

function plural(body: string, count: number): string {
    const branches = new Map<string, string>();
    let index = 0;
    while (index < body.length) {
        const open = body.indexOf('{', index);
        if (open < 0) break;
        const selector = body.slice(index, open).trim();
        const end = closing(body, open);
        branches.set(selector, body.slice(open + 1, end));
        index = end + 1;
    }
    const chosen =
        branches.get(`=${count}`) ??
        (count === 1 ? branches.get('one') : undefined) ??
        branches.get('other') ??
        '';
    return chosen.replace(/#/g, String(count));
}

export function formatMessage(template: string, values: Values = {}): string {
    let out = '';
    let index = 0;
    while (index < template.length) {
        const open = template.indexOf('{', index);
        if (open < 0) {
            out += template.slice(index);
            break;
        }
        out += template.slice(index, open);
        const end = closing(template, open);
        const inner = template.slice(open + 1, end);
        const [name, kind, ...rest] = inner.split(',');
        const value = values[name.trim()];
        if (kind && kind.trim() === 'plural') {
            out += plural(rest.join(','), Number(value));
        } else {
            if (value === undefined)
                throw new Error(`Missing value {${name.trim()}} for: ${template}`);
            out += String(value ?? '');
        }
        index = end + 1;
    }
    return out;
}

/** What `useTranslations(namespace)` returns, over the real English messages. */
export function testTranslations(namespace: string) {
    return (key: string, values?: Values) => formatMessage(lookup(`${namespace}.${key}`), values);
}
