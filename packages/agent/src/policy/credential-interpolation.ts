import { credentialRefPattern, isCredentialKey } from '@ever-works/contracts';

/**
 * `{{cred.key}}` interpolation (audit item G14) — the PURE half.
 *
 * ## The problem this closes
 *
 * A tool that needs a secret had no way to say so. Either the secret was
 * baked into a plugin's settings (invisible to the tool contract) or the
 * model was expected to supply it — which means the secret has to be IN
 * the prompt, i.e. in the transcript, in the provider's logs, and one
 * prompt-injection away from exfiltration.
 *
 * `{{cred.key}}` is the fix: the model writes the REFERENCE, the server
 * substitutes the VALUE immediately before the outbound call, and the
 * value never travels back. Three invariants hold everywhere below:
 *
 *   1. **Server-side only.** Resolution happens in the tool-invocation
 *      path, never in prompt assembly. A secret must never be a token in
 *      a system message.
 *   2. **Never logged.** Nothing here accepts a logger, and every error
 *      message names KEYS, never values.
 *   3. **Never echoed back.** `redactCredentialValues` scrubs any resolved
 *      value that turns up in a tool RESULT before that result re-enters
 *      the conversation — an API that reflects its own auth header would
 *      otherwise hand the secret straight to the model.
 *
 * All functions are side-effect free and dependency-free so they can be
 * unit-tested exhaustively and reused by the worker.
 */

/** Max nesting depth when walking tool arguments. Guards pathological input. */
const MAX_WALK_DEPTH = 8;

/**
 * Collect every distinct `{{cred.key}}` key referenced anywhere in a
 * value — strings, arrays, plain objects. Order is first-seen so error
 * messages are stable.
 */
export function collectCredentialRefs(value: unknown, depth = 0): string[] {
    const out: string[] = [];
    const seen = new Set<string>();

    const visit = (node: unknown, level: number): void => {
        if (level > MAX_WALK_DEPTH) return;
        if (typeof node === 'string') {
            const pattern = credentialRefPattern();
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(node)) !== null) {
                const key = match[1];
                if (!seen.has(key)) {
                    seen.add(key);
                    out.push(key);
                }
            }
            return;
        }
        if (Array.isArray(node)) {
            for (const item of node) visit(item, level + 1);
            return;
        }
        if (node && typeof node === 'object') {
            for (const item of Object.values(node as Record<string, unknown>)) {
                visit(item, level + 1);
            }
        }
    };

    visit(value, depth);
    return out;
}

export interface InterpolationResult<T> {
    /** The value with every RESOLVED reference substituted. */
    value: T;
    /** Keys that were substituted. Keys only — never values. */
    used: string[];
    /**
     * Keys the value referenced that the resolver could not supply. The
     * reference is left VERBATIM in the output so the caller can fail the
     * call; silently substituting an empty string would send an
     * unauthenticated request that looks like it worked.
     */
    missing: string[];
}

/**
 * Substitute `{{cred.key}}` references using a resolved key → value map.
 *
 * Structure-preserving: strings, arrays and plain objects are walked;
 * anything else passes through untouched. A string that is EXACTLY one
 * reference is replaced wholesale (so a numeric-looking secret is still a
 * string, which is what every HTTP header wants).
 */
export function interpolateCredentials<T>(
    value: T,
    credentials: ReadonlyMap<string, string>,
): InterpolationResult<T> {
    const used = new Set<string>();
    const missing = new Set<string>();

    const substitute = (input: string, level: number): string => {
        if (level > MAX_WALK_DEPTH) return input;
        return input.replace(credentialRefPattern(), (whole, key: string) => {
            const resolved = credentials.get(key);
            if (resolved === undefined) {
                missing.add(key);
                return whole;
            }
            used.add(key);
            return resolved;
        });
    };

    const walk = (node: unknown, level: number): unknown => {
        if (typeof node === 'string') return substitute(node, level);
        if (Array.isArray(node)) return node.map((item) => walk(item, level + 1));
        if (node && typeof node === 'object') {
            // Only PLAIN objects are rebuilt; class instances (Date, Buffer,
            // …) pass through untouched so we never mangle them.
            if (!isPlainObject(node)) return node;
            const out: Record<string, unknown> = {};
            for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
                out[key] = walk(item, level + 1);
            }
            return out;
        }
        return node;
    };

    return {
        value: walk(value, 0) as T,
        used: Array.from(used),
        missing: Array.from(missing),
    };
}

/** Placeholder written in place of a leaked secret. */
export function credentialRedactionToken(key: string): string {
    return `[redacted:cred.${key}]`;
}

/** Plain object = literal or `Object.create(null)`. Class instances are not. */
function isPlainObject(node: object): boolean {
    const proto = Object.getPrototypeOf(node);
    return proto === Object.prototype || proto === null;
}

/**
 * Minimum length for a value to be treated as a plausible secret. Below
 * this, blanket-replacing every occurrence would corrupt ordinary text
 * (a 3-character "key" would scrub half the response).
 */
const MIN_REDACTABLE_SECRET_LENGTH = 8;

/**
 * How far `'credential'` mode rebuilds a structure level by level. Content
 * nested deeper is still checked (iteratively, so no input depth can
 * exhaust the stack), and a subtree that carries a value is replaced whole.
 */
const CREDENTIAL_MODE_WALK_DEPTH = 64;

/**
 * How thoroughly `redactCredentialValues` scrubs.
 *
 *  - `'text'` (the default): values of at least 8 characters are replaced
 *    wherever they occur inside string VALUES, down to the walk depth
 *    limit. Object keys are kept as they are, shorter values are ignored so
 *    ordinary text is not corrupted, and content nested past the limit is
 *    returned untouched.
 *  - `'credential'`: for content that must never carry a resolved value at
 *    all (a connection's tool list, a tool result). On top of the above it
 *    scrubs object KEYS, replaces a string or key that is EXACTLY a shorter
 *    value (a substring of ordinary text is still left alone), and never
 *    lets content past a depth limit through unchecked.
 */
export type CredentialRedactionMode = 'text' | 'credential';

export interface CredentialRedactionOptions {
    /** Defaults to `'text'`. See `CredentialRedactionMode`. */
    mode?: CredentialRedactionMode;
}

/**
 * Scrub resolved credential VALUES out of anything about to travel back
 * to the model (or into a log, or into a stored transcript).
 *
 * Called on every tool result whose arguments carried a credential — the
 * upstream API is not ours and may well reflect the token it was given
 * (error bodies that echo the Authorization header are depressingly
 * common). Each occurrence becomes `[redacted:cred.<key>]`, which is both
 * unmistakable in a transcript and tells a debugging human WHICH
 * credential leaked without telling them its value.
 */
export function redactCredentialValues<T>(
    value: T,
    credentials: ReadonlyMap<string, string> | Iterable<[string, string]>,
    options: CredentialRedactionOptions = {},
): T {
    const strict = options.mode === 'credential';
    const resolved = Array.from(
        credentials instanceof Map ? credentials.entries() : credentials,
    ).filter(([, secret]) => typeof secret === 'string' && secret.length > 0);
    const entries = resolved.filter(([, secret]) => secret.length >= MIN_REDACTABLE_SECRET_LENGTH);
    // Longest first, so a secret that contains another is scrubbed whole.
    entries.sort((a, b) => b[1].length - a[1].length);
    // Shorter values: only a string that IS the value, and only in strict mode.
    const exact = strict
        ? resolved.filter(([, secret]) => secret.length < MIN_REDACTABLE_SECRET_LENGTH)
        : [];
    if (entries.length === 0 && exact.length === 0) return value;

    /** The key of the first value `input` carries, if any. */
    const leakedKeyIn = (input: string): string | undefined => {
        for (const [key, secret] of exact) {
            if (input === secret) return key;
        }
        for (const [key, secret] of entries) {
            if (input.includes(secret)) return key;
        }
        return undefined;
    };

    const scrubString = (input: string): string => {
        for (const [key, secret] of exact) {
            if (input === secret) return credentialRedactionToken(key);
        }
        let out = input;
        for (const [key, secret] of entries) {
            if (!out.includes(secret)) continue;
            out = out.split(secret).join(credentialRedactionToken(key));
        }
        return out;
    };

    /**
     * Strict mode, past the rebuild depth: an iterative search (no recursion,
     * cycle-safe) for any value in strings, keys and nested containers.
     */
    const findLeakedKey = (root: object): string | undefined => {
        const stack: unknown[] = [root];
        const seen = new Set<object>();
        while (stack.length > 0) {
            const node = stack.pop();
            if (typeof node === 'string') {
                const key = leakedKeyIn(node);
                if (key !== undefined) return key;
                continue;
            }
            if (!node || typeof node !== 'object' || seen.has(node)) continue;
            seen.add(node);
            if (Array.isArray(node)) {
                for (const item of node) stack.push(item);
                continue;
            }
            if (!isPlainObject(node)) continue;
            for (const [name, item] of Object.entries(node as Record<string, unknown>)) {
                const key = leakedKeyIn(name);
                if (key !== undefined) return key;
                stack.push(item);
            }
        }
        return undefined;
    };

    const walk = (node: unknown, level: number): unknown => {
        if (strict) {
            if (typeof node === 'string') return scrubString(node);
            if (level > CREDENTIAL_MODE_WALK_DEPTH && node && typeof node === 'object') {
                // Fail closed: a subtree too deep to rebuild that still
                // carries a value is replaced whole, never passed through.
                const leaked = findLeakedKey(node);
                return leaked === undefined ? node : credentialRedactionToken(leaked);
            }
        } else if (level > MAX_WALK_DEPTH) {
            return node;
        }
        if (typeof node === 'string') return scrubString(node);
        if (Array.isArray(node)) return node.map((item) => walk(item, level + 1));
        if (node && typeof node === 'object') {
            if (!isPlainObject(node)) return node;
            const out: Record<string, unknown> = {};
            for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
                out[strict ? scrubString(key) : key] = walk(item, level + 1);
            }
            return out;
        }
        return node;
    };

    return walk(value, 0) as T;
}

/**
 * Validate the KEYS a template references. A key that does not match the
 * credential-key grammar can never resolve, so catching it here turns a
 * confusing "missing credential" at call time into a precise complaint.
 */
export function invalidCredentialKeys(value: unknown): string[] {
    return collectCredentialRefs(value).filter((key) => !isCredentialKey(key));
}
