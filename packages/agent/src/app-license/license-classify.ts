/**
 * APW-03 (App spec, Apps catalog and license gate) — classify an SPDX licence
 * expression against a licence registry.
 *
 * This is the pure core the Apps-catalog port's `classifyLicense(spdx)` answers
 * with (`app-works/app-source-catalog.port.ts`: "`null` … yields `'unknown'`;
 * the adapter must never guess a class from a missing one"). The rules are
 * `catalog.md` §4 "Expressions":
 *
 * - `A OR B` takes the **best** class of its operands, `A AND B` the **worst**,
 *   on the fixed rank **green < amber < unknown < red**
 *   ({@link LICENSE_CLASS_RANK});
 * - an operand the registry does not list counts as `unknown`, so
 *   `MIT OR LicenseRef-x` is green and `MIT AND LicenseRef-x` is unknown;
 * - `A WITH E` takes `A`'s class unless `E` is listed with an effect
 *   `class:<green|amber|red>`. An effect of `none`, or an exception the
 *   registry does not list, keeps the base class. An exception never lifts an
 *   UNLISTED licence out of `unknown`: the registry cannot vouch for a licence it
 *   does not list. It can still make one worse (`unknown WITH class:red` is red).
 *
 * An operand is looked up by its SPDX id (case-insensitive, exact, a trailing
 * `+` included), then by an `aliases[].match` (case-insensitive, exact) whose
 * target is a listed licence. An input that is not an SPDX expression at all
 * (it has spaces or punctuation, like `The MIT License`) is looked up as a
 * whole against the aliases, which map licence TITLES (`catalog.md` §4). Anything
 * else, and `null`, blank, oversized or malformed input, is `unknown`.
 *
 * The registry's `unknown` block is **never read**: its `class` is advisory
 * display metadata that "never becomes a license class" (`catalog.md` §4).
 *
 * No I/O and no `process.env`: the registry is an argument, and the default is
 * the bundled seed snapshot. Choosing live / last-good / snapshot is the
 * registry loader's job (plan §2.6), not this function's.
 */
import { LICENSE_CLASS_RANK, type LicenseClass } from '@ever-works/contracts';
import {
    LICENSE_REGISTRY_SNAPSHOT,
    type LicenseExceptionEffect,
    type LicenseRegistryClass,
    type LicenseRegistryContent,
} from './license-registry.snapshot';
import {
    parseSpdxExpression,
    SPDX_EXPRESSION_MAX_LENGTH,
    type SpdxExpressionNode,
} from './spdx-expression';

/** The parts of a registry classification reads. The `unknown` block is deliberately absent. */
export type LicenseClassifyRegistry = Pick<
    LicenseRegistryContent,
    'licenses' | 'exceptions' | 'aliases'
>;

interface RegistryIndex {
    /** Lower-cased `spdx` ⇒ the row's class. First row wins on a duplicate. */
    readonly licenses: ReadonlyMap<string, LicenseClass>;
    /** Lower-cased `match` ⇒ target `spdx`. First row wins on a duplicate. */
    readonly aliases: ReadonlyMap<string, string>;
    /** Lower-cased exception `spdx` ⇒ its effect. First row wins on a duplicate. */
    readonly exceptions: ReadonlyMap<string, LicenseExceptionEffect>;
}

function isRegistryClass(value: unknown): value is LicenseRegistryClass {
    return value === 'green' || value === 'amber' || value === 'red';
}

function indexRegistry(registry: LicenseClassifyRegistry): RegistryIndex {
    const licenses = new Map<string, LicenseClass>();
    for (const row of registry.licenses ?? []) {
        const key = row.spdx.toLowerCase();
        if (!licenses.has(key)) {
            // A row whose class is not one of the three is not a classification.
            licenses.set(key, isRegistryClass(row.class) ? row.class : 'unknown');
        }
    }
    const aliases = new Map<string, string>();
    for (const row of registry.aliases ?? []) {
        const key = row.match.toLowerCase();
        if (!aliases.has(key)) {
            aliases.set(key, row.spdx);
        }
    }
    const exceptions = new Map<string, LicenseExceptionEffect>();
    for (const row of registry.exceptions ?? []) {
        const key = row.spdx.toLowerCase();
        if (!exceptions.has(key)) {
            exceptions.set(key, row.effect);
        }
    }
    return { licenses, aliases, exceptions };
}

function best(a: LicenseClass, b: LicenseClass): LicenseClass {
    return LICENSE_CLASS_RANK[a] <= LICENSE_CLASS_RANK[b] ? a : b;
}

function worst(a: LicenseClass, b: LicenseClass): LicenseClass {
    return LICENSE_CLASS_RANK[a] >= LICENSE_CLASS_RANK[b] ? a : b;
}

/** A listed id's class, else a listed alias's target's class, else `unknown`. */
function classOfId(id: string, index: RegistryIndex): LicenseClass {
    const key = id.toLowerCase();
    const direct = index.licenses.get(key);
    if (direct !== undefined) {
        return direct;
    }
    const target = index.aliases.get(key);
    if (target === undefined) {
        return 'unknown';
    }
    return index.licenses.get(target.toLowerCase()) ?? 'unknown';
}

/** The class an exception's effect imposes, or `undefined` when it keeps the base (`none`, unlisted). */
function classOfEffect(
    effect: LicenseExceptionEffect | undefined,
): LicenseRegistryClass | undefined {
    switch (effect) {
        case 'class:green':
            return 'green';
        case 'class:amber':
            return 'amber';
        case 'class:red':
            return 'red';
        default:
            return undefined;
    }
}

function classOfNode(node: SpdxExpressionNode, index: RegistryIndex): LicenseClass {
    switch (node.type) {
        case 'or':
            return best(classOfNode(node.left, index), classOfNode(node.right, index));
        case 'and':
            return worst(classOfNode(node.left, index), classOfNode(node.right, index));
        case 'license': {
            const base = classOfId(node.id, index);
            if (node.exception === undefined) {
                return base;
            }
            const imposed = classOfEffect(index.exceptions.get(node.exception.toLowerCase()));
            if (imposed === undefined) {
                return base;
            }
            return base === 'unknown' ? worst(base, imposed) : imposed;
        }
    }
}

/**
 * Classify an SPDX licence expression (or a licence title) against a registry.
 *
 * `null`, `undefined`, blank, oversized (> 1 KiB) or malformed input, and any
 * expression whose deciding operand the registry does not list, answer
 * `'unknown'`. Never throws for any string input.
 */
export function classifyLicenseExpression(
    spdx: string | null | undefined,
    registry: LicenseClassifyRegistry = LICENSE_REGISTRY_SNAPSHOT,
): LicenseClass {
    if (typeof spdx !== 'string' || spdx.length > SPDX_EXPRESSION_MAX_LENGTH) {
        return 'unknown';
    }
    const text = spdx.trim();
    if (text === '') {
        return 'unknown';
    }
    const index = indexRegistry(registry);
    const tree = parseSpdxExpression(text);
    if (tree !== null) {
        return classOfNode(tree, index);
    }
    // Not an expression; a licence title (`The MIT License`) is still an exact
    // alias match. Its target must be a listed licence.
    const target = index.aliases.get(text.toLowerCase());
    return target === undefined
        ? 'unknown'
        : (index.licenses.get(target.toLowerCase()) ?? 'unknown');
}
