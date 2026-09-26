/**
 * APW-03 (App spec, Apps catalog and license gate) — a pure SPDX licence
 * expression parser.
 *
 * Spec: `docs/specs/features/app-works/APW-03-app-spec-and-catalog/catalog.md`
 * §4 ("Expressions": `OR` takes the best class, `AND` the worst, `WITH` keeps the
 * base class unless the exception is listed) and `plan.md` §2.6 (the license
 * gate's `spdx-expression.ts`). This module only turns text into a tree; what a
 * tree is worth is `license-classify.ts`'s job.
 *
 * ## What it accepts
 *
 * - licence ids made of `[A-Za-z0-9.-]`, with an optional trailing `+`, which
 *   stays PART of the id (`GPL-2.0+` is the id `GPL-2.0+`, never `GPL-2.0`);
 * - `LicenseRef-*` ids, optionally qualified as `DocumentRef-*:LicenseRef-*`;
 * - `AND`, `OR` and `WITH` in any letter case;
 * - parentheses, nested to any depth the size limit allows.
 *
 * Precedence is `WITH` > `AND` > `OR`, and `AND` / `OR` are left-associative,
 * as in the SPDX specification (Annex D). `WITH` binds a single licence id to a
 * single exception id: `(MIT OR Apache-2.0) WITH X` is a syntax error, as the
 * SPDX grammar has it.
 *
 * ## What it refuses
 *
 * Anything else answers `null` — never a best-effort tree. A caller asking
 * "what licence is this?" must get "I cannot tell" for `MIT/Apache-2.0`, an
 * unbalanced parenthesis or a dangling operator, because a partial parse is a
 * guess. Input longer than {@link SPDX_EXPRESSION_MAX_LENGTH} is refused the
 * same way, before any tokenising, so a hostile manifest cannot make the parser
 * do unbounded work.
 *
 * No I/O, no `process.env`, no dependencies.
 */

/** The longest expression the parser reads — 1 KiB. Longer input is refused (`null`). */
export const SPDX_EXPRESSION_MAX_LENGTH = 1024;

/** A single licence, optionally modified by an exception (`<id> WITH <exception>`). */
export interface SpdxLicenseNode {
    readonly type: 'license';
    /** The id as written, a trailing `+` included. Case is preserved; lookups are the caller's business. */
    readonly id: string;
    /** The exception id after `WITH`, when there is one. */
    readonly exception?: string;
}

/** `left AND right` or `left OR right`. */
export interface SpdxCompoundNode {
    readonly type: 'and' | 'or';
    readonly left: SpdxExpressionNode;
    readonly right: SpdxExpressionNode;
}

/** A parsed SPDX licence expression. */
export type SpdxExpressionNode = SpdxLicenseNode | SpdxCompoundNode;

type Token =
    | { readonly kind: 'open' }
    | { readonly kind: 'close' }
    | { readonly kind: 'and' }
    | { readonly kind: 'or' }
    | { readonly kind: 'with' }
    | { readonly kind: 'word'; readonly text: string };

/** A licence id: an SPDX-style id with an optional trailing `+`, or a (document-qualified) `LicenseRef-*`. */
const LICENSE_ID_PATTERN =
    /^(?:DocumentRef-[A-Za-z0-9.-]+:LicenseRef-[A-Za-z0-9.-]+|[A-Za-z0-9.-]+\+?)$/;

/** An exception id: no `+` (the "or later" suffix belongs to licences only). */
const EXCEPTION_ID_PATTERN = /^(?:DocumentRef-[A-Za-z0-9.-]+:[A-Za-z0-9.-]+|[A-Za-z0-9.-]+)$/;

/** What a word may contain at all; anything else (`/`, `,`, quotes, non-ASCII) is a syntax error. */
const WORD_PATTERN = /[A-Za-z0-9.+:-]+/y;

class SpdxSyntaxError extends Error {}

function tokenize(input: string): Token[] {
    const tokens: Token[] = [];
    let index = 0;
    while (index < input.length) {
        const char = input[index];
        if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
            index += 1;
            continue;
        }
        if (char === '(') {
            tokens.push({ kind: 'open' });
            index += 1;
            continue;
        }
        if (char === ')') {
            tokens.push({ kind: 'close' });
            index += 1;
            continue;
        }
        WORD_PATTERN.lastIndex = index;
        const match = WORD_PATTERN.exec(input);
        if (!match) {
            throw new SpdxSyntaxError(`unexpected character at ${index}`);
        }
        const text = match[0];
        const upper = text.toUpperCase();
        if (upper === 'AND') {
            tokens.push({ kind: 'and' });
        } else if (upper === 'OR') {
            tokens.push({ kind: 'or' });
        } else if (upper === 'WITH') {
            tokens.push({ kind: 'with' });
        } else {
            tokens.push({ kind: 'word', text });
        }
        index += text.length;
    }
    return tokens;
}

class Parser {
    private position = 0;

    constructor(private readonly tokens: readonly Token[]) {}

    parse(): SpdxExpressionNode {
        const node = this.parseOr();
        if (this.position !== this.tokens.length) {
            throw new SpdxSyntaxError('trailing tokens');
        }
        return node;
    }

    private peek(): Token | undefined {
        return this.tokens[this.position];
    }

    private next(): Token {
        const token = this.tokens[this.position];
        if (!token) {
            throw new SpdxSyntaxError('unexpected end of expression');
        }
        this.position += 1;
        return token;
    }

    private parseOr(): SpdxExpressionNode {
        let left = this.parseAnd();
        while (this.peek()?.kind === 'or') {
            this.position += 1;
            left = { type: 'or', left, right: this.parseAnd() };
        }
        return left;
    }

    private parseAnd(): SpdxExpressionNode {
        let left = this.parsePrimary();
        while (this.peek()?.kind === 'and') {
            this.position += 1;
            left = { type: 'and', left, right: this.parsePrimary() };
        }
        return left;
    }

    private parsePrimary(): SpdxExpressionNode {
        const token = this.next();
        if (token.kind === 'open') {
            const inner = this.parseOr();
            if (this.next().kind !== 'close') {
                throw new SpdxSyntaxError('expected )');
            }
            return inner;
        }
        if (token.kind !== 'word' || !LICENSE_ID_PATTERN.test(token.text)) {
            throw new SpdxSyntaxError('expected a licence id');
        }
        if (this.peek()?.kind !== 'with') {
            return { type: 'license', id: token.text };
        }
        this.position += 1;
        const exception = this.next();
        if (exception.kind !== 'word' || !EXCEPTION_ID_PATTERN.test(exception.text)) {
            throw new SpdxSyntaxError('expected an exception id');
        }
        return { type: 'license', id: token.text, exception: exception.text };
    }
}

/**
 * Parse an SPDX licence expression.
 *
 * Answers `null` for `null` / `undefined`, blank input, input longer than
 * {@link SPDX_EXPRESSION_MAX_LENGTH}, and any syntax error — never a partial
 * tree.
 */
export function parseSpdxExpression(input: string | null | undefined): SpdxExpressionNode | null {
    if (typeof input !== 'string' || input.length > SPDX_EXPRESSION_MAX_LENGTH) {
        return null;
    }
    try {
        const tokens = tokenize(input);
        if (tokens.length === 0) {
            return null;
        }
        return new Parser(tokens).parse();
    } catch (error) {
        if (error instanceof SpdxSyntaxError) {
            return null;
        }
        throw error;
    }
}
