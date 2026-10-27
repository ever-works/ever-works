/**
 * APW-03 T27 — the three-way App spec merge behind a Blueprint upgrade (plan §2.5
 * "Upgrade", FR-50/FR-51, ACC-03-29).
 *
 * ```
 * base   = the Blueprint's `.works/works.yml` at the version the App Work applied
 * ours   = the App Work's own `.works/works.yml` today (the member's edits included)
 * theirs = the Blueprint's `.works/works.yml` at the new version
 * ```
 *
 * The rule, key by key, is the classic one:
 *
 *  - both sides agree ⇒ that value;
 *  - only the Blueprint changed it (`ours` still equals `base`) ⇒ the Blueprint's value;
 *  - only the member changed it (`theirs` still equals `base`) ⇒ the member's value;
 *  - both changed it, differently ⇒ **a conflict: the member's value is kept and the
 *    conflict is listed** — never silently overwritten.
 *
 * Objects are merged key by key, recursively. Arrays of named objects (`components`,
 * `env`, `jobs`, `cron`, `smoke`, `checks` — and any other array whose every element is
 * an object with a unique string `name`) are merged **by `name`**, so a Blueprint that
 * adds an env entry does not collide with a member who edited another one. Every other
 * array (a `command`, `args`, a list of paths) is a single value: order can carry meaning
 * there, so no element-wise merge is attempted.
 *
 * Two paths are owned by one side whatever the values say:
 *
 *  - `spec.source` always comes from `ours` — it records the Work's own repository
 *    relation, which a Blueprint can never decide (T27's "`source` never comes from
 *    `theirs`");
 *  - `spec.blueprint` comes from `theirs` — it is the platform's marker of which
 *    Blueprint version the file now follows.
 *
 * Deletions are three-way too: a key the Blueprint removed is removed when the member
 * never touched it, and kept (as a `deleted_by_blueprint` conflict) when the member did
 * edit it; a key the member removed stays removed, and a Blueprint change to it is listed
 * as `deleted_by_you`.
 *
 * ## An unknown base
 *
 * When the base cannot be read (a Blueprint that never tagged the applied version), the
 * caller passes `null`. The merge then degrades to the safe two-way rule: what only one
 * side has is taken from that side, and every value the two sides both carry but disagree
 * on is a conflict (the member's value kept). A Blueprint removal can never be inferred
 * without a base, so nothing is removed. `apply` mode (a Blueprint applied to an App Work
 * that had none) is the same computation with an empty base.
 *
 * ## Purity
 *
 * No I/O, no clock, no environment: the inputs are copied (prototype-polluting keys
 * dropped, the rule `AppSourceInitializerService` and `AppBlueprintApplyService` already
 * apply to a parsed `.works/works.yml`) and never mutated, and the same inputs always give
 * the same output, key order included (the member's order first, then what the Blueprint
 * added, in the Blueprint's order).
 *
 * {@link renderMergedAppSpecText} turns the result back into the file text the upgrade
 * pull request commits. It patches the member's own YAML document in place, so their
 * comments and formatting survive, and annotates each conflict with a one-line
 * `# ever-works:` comment next to the kept value.
 */
import * as yaml from 'yaml';

/** One step of a merge path: a map key, or the `name` of an element of a named array. */
export type AppSpecMergePathSegment = string | { readonly name: string };

/**
 * Why a value was kept from `ours` against the Blueprint:
 *
 *  - `both_changed` — both sides changed it, to different values;
 *  - `both_added` — it is new on both sides (or the base is unknown), with different values;
 *  - `deleted_by_blueprint` — the Blueprint removed it, the member had changed it;
 *  - `deleted_by_you` — the member removed it, the Blueprint changed it.
 */
export type AppSpecMergeConflictKind =
    | 'both_changed'
    | 'both_added'
    | 'deleted_by_blueprint'
    | 'deleted_by_you';

/** `undefined` in `base` / `ours` / `theirs` means "absent on that side". */
export interface AppSpecMergeConflict {
    /** `spec.env[name=DATABASE_URL].value` — stable and human-readable. */
    readonly path: string;
    readonly segments: readonly AppSpecMergePathSegment[];
    readonly kind: AppSpecMergeConflictKind;
    readonly base: unknown;
    readonly ours: unknown;
    readonly theirs: unknown;
}

/** One Blueprint change the merge applied. */
export interface AppSpecMergeChange {
    readonly path: string;
    readonly segments: readonly AppSpecMergePathSegment[];
    readonly kind: 'added' | 'changed' | 'removed';
}

export interface AppSpecMergeResult {
    /** The merged document. A fresh object; no input is shared or mutated. */
    readonly merged: Record<string, unknown>;
    /** The conflicts, at most `maxConflicts` of them, in document order. */
    readonly conflicts: readonly AppSpecMergeConflict[];
    /** Every conflict, even beyond the cap. */
    readonly conflictCount: number;
    /** The Blueprint changes the merge took, at most `maxConflicts` of them. */
    readonly applied: readonly AppSpecMergeChange[];
    /** `true` when a base was given; `false` is the two-way degradation. */
    readonly baseKnown: boolean;
    /** `false` when the merged document equals `ours` — nothing to propose. */
    readonly changed: boolean;
}

export interface AppSpecMergeOptions {
    /** Paths always taken from `ours`. Default: `spec.source`. */
    readonly oursOwned?: readonly (readonly string[])[];
    /** Paths taken from `theirs` when it has them. Default: `spec.blueprint`. */
    readonly theirsOwned?: readonly (readonly string[])[];
    /** Cap of the `conflicts` and `applied` lists. Default {@link APP_SPEC_MERGE_MAX_LISTED}. */
    readonly maxConflicts?: number;
}

/** How many conflicts (and applied changes) a result lists; the count is never capped. */
export const APP_SPEC_MERGE_MAX_LISTED = 200;

/** The paths `ours` always wins (T27: "`source` never comes from `theirs`"). */
export const APP_SPEC_MERGE_OURS_OWNED: readonly (readonly string[])[] = [['spec', 'source']];

/** The paths `theirs` wins when it carries them — the Blueprint version marker. */
export const APP_SPEC_MERGE_THEIRS_OWNED: readonly (readonly string[])[] = [['spec', 'blueprint']];

/** Marker of a comment line the renderer wrote, so a later run replaces rather than stacks it. */
export const APP_SPEC_MERGE_COMMENT_PREFIX = 'ever-works:';

const ABSENT: unique symbol = Symbol('absent');
type Maybe = unknown | typeof ABSENT;

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/** A deep copy with the three prototype-polluting keys dropped at every level. */
function sanitize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sanitize);
    }
    if (isPlainObject(value)) {
        const out: Record<string, unknown> = {};
        for (const [key, inner] of Object.entries(value)) {
            if (DANGEROUS_KEYS.has(key)) continue;
            out[key] = sanitize(inner);
        }
        return out;
    }
    if (value instanceof Date) {
        return new Date(value.getTime());
    }
    return value;
}

/** Canonical JSON (sorted keys) — the equality the merge uses. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonical).join(',')}]`;
    }
    if (isPlainObject(value)) {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
            .join(',')}}`;
    }
    if (value instanceof Date) {
        return JSON.stringify(value.toISOString());
    }
    if (value === undefined) {
        return 'undefined';
    }
    return JSON.stringify(value) ?? String(value);
}

function same(a: Maybe, b: Maybe): boolean {
    if (a === ABSENT || b === ABSENT) {
        return a === b;
    }
    return canonical(a) === canonical(b);
}

function own(record: unknown, key: string): Maybe {
    return isPlainObject(record) && Object.prototype.hasOwnProperty.call(record, key)
        ? record[key]
        : ABSENT;
}

/** Every element is a plain object with a non-empty string `name`, and the names are unique. */
export function isNamedArray(value: unknown): value is Array<Record<string, unknown>> {
    if (!Array.isArray(value)) {
        return false;
    }
    const names = new Set<string>();
    for (const element of value) {
        if (!isPlainObject(element)) return false;
        const name = element.name;
        if (typeof name !== 'string' || name === '' || names.has(name)) return false;
        names.add(name);
    }
    return true;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

/** `spec.env[name=DATABASE_URL].value`; an odd key is quoted (`spec["a.b"]`). */
export function formatMergePath(segments: readonly AppSpecMergePathSegment[]): string {
    let out = '';
    for (const segment of segments) {
        if (typeof segment === 'string') {
            if (IDENTIFIER.test(segment)) {
                out += out === '' ? segment : `.${segment}`;
            } else {
                out += `[${JSON.stringify(segment)}]`;
            }
        } else {
            out += `[name=${segment.name}]`;
        }
    }
    return out === '' ? '(document)' : out;
}

function pathEquals(segments: readonly AppSpecMergePathSegment[], owned: readonly string[]): boolean {
    return (
        segments.length === owned.length &&
        segments.every((segment, index) => segment === owned[index])
    );
}

interface MergeContext {
    readonly oursOwned: readonly (readonly string[])[];
    readonly theirsOwned: readonly (readonly string[])[];
    readonly max: number;
    readonly conflicts: AppSpecMergeConflict[];
    readonly applied: AppSpecMergeChange[];
    conflictCount: number;
}

function conflict(
    context: MergeContext,
    segments: readonly AppSpecMergePathSegment[],
    kind: AppSpecMergeConflictKind,
    base: Maybe,
    ours: Maybe,
    theirs: Maybe,
): void {
    context.conflictCount += 1;
    if (context.conflicts.length < context.max) {
        context.conflicts.push({
            path: formatMergePath(segments),
            segments: [...segments],
            kind,
            base: base === ABSENT ? undefined : base,
            ours: ours === ABSENT ? undefined : ours,
            theirs: theirs === ABSENT ? undefined : theirs,
        });
    }
}

function applied(
    context: MergeContext,
    segments: readonly AppSpecMergePathSegment[],
    base: Maybe,
    theirs: Maybe,
): void {
    if (context.applied.length >= context.max) return;
    context.applied.push({
        path: formatMergePath(segments),
        segments: [...segments],
        kind: base === ABSENT ? 'added' : theirs === ABSENT ? 'removed' : 'changed',
    });
}

/** `segments` is a strict ancestor of an owned path (the root and `spec`, by default). */
function isOwnedAncestor(context: MergeContext, segments: readonly AppSpecMergePathSegment[]): boolean {
    return [...context.oursOwned, ...context.theirsOwned].some(
        (path) =>
            path.length > segments.length &&
            segments.every((segment, index) => segment === path[index]),
    );
}

function mergeValue(
    context: MergeContext,
    segments: readonly AppSpecMergePathSegment[],
    base: Maybe,
    ours: Maybe,
    theirs: Maybe,
): Maybe {
    if (context.oursOwned.some((path) => pathEquals(segments, path))) {
        return ours;
    }
    if (context.theirsOwned.some((path) => pathEquals(segments, path))) {
        if (theirs === ABSENT) return ours;
        if (!same(ours, theirs)) applied(context, segments, ours, theirs);
        return theirs;
    }

    if (same(ours, theirs)) {
        return ours;
    }

    // Containers on every side are always merged member by member, even when one side
    // equals the base: taking a whole object from `theirs` would carry `theirs`'s copy of
    // an owned path below it (`spec.source`), and would list one coarse change where the
    // member deserves the exact paths that moved.
    const baseIsObject = base === ABSENT || isPlainObject(base);
    if (isPlainObject(ours) && isPlainObject(theirs) && baseIsObject) {
        return mergeObjects(context, segments, base, ours, theirs);
    }
    if (isNamedArray(ours) && isNamedArray(theirs) && (base === ABSENT || isNamedArray(base))) {
        return mergeNamedArrays(context, segments, base, ours, theirs);
    }
    // An ancestor of an owned path that one side lacks altogether is still walked, so the
    // owned child keeps its owner's value; an empty result means the block is gone.
    if (
        isOwnedAncestor(context, segments) &&
        baseIsObject &&
        (isPlainObject(ours) || ours === ABSENT) &&
        (isPlainObject(theirs) || theirs === ABSENT)
    ) {
        const merged = mergeObjects(
            context,
            segments,
            base,
            ours === ABSENT ? {} : (ours as Record<string, unknown>),
            theirs === ABSENT ? {} : (theirs as Record<string, unknown>),
        );
        return Object.keys(merged).length === 0 ? ABSENT : merged;
    }

    if (same(base, ours)) {
        // Only the Blueprint moved: take it (an absent `theirs` is a removal).
        applied(context, segments, base, theirs);
        return theirs;
    }
    if (same(base, theirs)) {
        // Only the member moved: keep it.
        return ours;
    }

    // Both moved, to different places (containers were merged above).
    if (ours !== ABSENT && theirs !== ABSENT) {
        conflict(context, segments, base === ABSENT ? 'both_added' : 'both_changed', base, ours, theirs);
        return ours;
    }
    if (theirs === ABSENT) {
        // The Blueprint removed what the member changed: keep the member's.
        conflict(context, segments, 'deleted_by_blueprint', base, ours, theirs);
        return ours;
    }
    // The member removed what the Blueprint changed: it stays removed.
    conflict(context, segments, 'deleted_by_you', base, ours, theirs);
    return ABSENT;
}

function mergeObjects(
    context: MergeContext,
    segments: readonly AppSpecMergePathSegment[],
    base: Maybe,
    ours: Record<string, unknown>,
    theirs: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const keys = [...Object.keys(ours)];
    for (const key of Object.keys(theirs)) {
        if (!Object.prototype.hasOwnProperty.call(ours, key)) keys.push(key);
    }
    for (const key of keys) {
        if (DANGEROUS_KEYS.has(key)) continue;
        const value = mergeValue(
            context,
            [...segments, key],
            own(base, key),
            own(ours, key),
            own(theirs, key),
        );
        if (value !== ABSENT) {
            out[key] = value;
        }
    }
    return out;
}

function byName(array: Maybe): Map<string, Record<string, unknown>> {
    const map = new Map<string, Record<string, unknown>>();
    if (Array.isArray(array)) {
        for (const element of array as Array<Record<string, unknown>>) {
            map.set(element.name as string, element);
        }
    }
    return map;
}

function mergeNamedArrays(
    context: MergeContext,
    segments: readonly AppSpecMergePathSegment[],
    base: Maybe,
    ours: Array<Record<string, unknown>>,
    theirs: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
    const baseByName = byName(base);
    const oursByName = byName(ours);
    const theirsByName = byName(theirs);
    const names = ours.map((element) => element.name as string);
    for (const element of theirs) {
        const name = element.name as string;
        if (!oursByName.has(name)) names.push(name);
    }
    const out: Array<Record<string, unknown>> = [];
    for (const name of names) {
        const value = mergeValue(
            context,
            [...segments, { name }],
            baseByName.has(name) ? baseByName.get(name) : ABSENT,
            oursByName.has(name) ? oursByName.get(name) : ABSENT,
            theirsByName.has(name) ? theirsByName.get(name) : ABSENT,
        );
        if (value !== ABSENT) {
            out.push(value as Record<string, unknown>);
        }
    }
    return out;
}

/**
 * The three-way merge. `base: null` (or `undefined`) is the unknown-base degradation
 * described in the header; `ours` / `theirs` that are not objects are read as empty
 * documents.
 */
export function mergeAppSpecDocuments(
    base: unknown,
    ours: unknown,
    theirs: unknown,
    options: AppSpecMergeOptions = {},
): AppSpecMergeResult {
    const context: MergeContext = {
        oursOwned: options.oursOwned ?? APP_SPEC_MERGE_OURS_OWNED,
        theirsOwned: options.theirsOwned ?? APP_SPEC_MERGE_THEIRS_OWNED,
        max: Math.max(0, Math.floor(options.maxConflicts ?? APP_SPEC_MERGE_MAX_LISTED)),
        conflicts: [],
        applied: [],
        conflictCount: 0,
    };
    const baseKnown = base !== null && base !== undefined;
    const oursDoc = isPlainObject(ours) ? (sanitize(ours) as Record<string, unknown>) : {};
    const theirsDoc = isPlainObject(theirs) ? (sanitize(theirs) as Record<string, unknown>) : {};
    const baseDoc: Maybe = baseKnown
        ? isPlainObject(base)
            ? (sanitize(base) as Record<string, unknown>)
            : {}
        : ABSENT;

    const merged = mergeObjects(context, [], baseDoc, oursDoc, theirsDoc);

    return {
        merged,
        conflicts: context.conflicts,
        conflictCount: context.conflictCount,
        applied: context.applied,
        baseKnown,
        changed: !same(merged, oursDoc),
    };
}

/* -------------------------------------------------------------------------- *
 * Rendering — the member's YAML, patched in place
 * -------------------------------------------------------------------------- */

export interface RenderMergedAppSpecOptions {
    /** The conflicts to annotate in the file (from the same merge). */
    readonly conflicts?: readonly AppSpecMergeConflict[];
    /** The Blueprint version named in the annotations, e.g. `0.2.0`. */
    readonly blueprintVersion?: string;
}

const PREVIEW_MAX = 80;

/** A one-line, control-character-free preview of a (Blueprint-supplied) value. */
export function previewMergeValue(value: unknown): string {
    if (value === undefined) return '(absent)';
    let text: string;
    try {
        text = typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value));
    } catch {
        text = String(value);
    }
    text = text.replace(/[\u0000-\u001f\u007f]/g, ' ');
    return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
}

/** The one-line note a kept value carries in the file. Never echoes the member's value. */
export function mergeConflictNote(conflict: AppSpecMergeConflict, version?: string): string {
    const who = version ? `Blueprint ${version}` : 'The new Blueprint version';
    switch (conflict.kind) {
        case 'deleted_by_blueprint':
            return `${APP_SPEC_MERGE_COMMENT_PREFIX} ${who} removes this; you changed it, so it was kept.`;
        case 'deleted_by_you':
            return `${APP_SPEC_MERGE_COMMENT_PREFIX} ${who} changes something you removed; it stays removed.`;
        default:
            return `${APP_SPEC_MERGE_COMMENT_PREFIX} ${who} proposes ${previewMergeValue(conflict.theirs)}; your value was kept.`;
    }
}

type DocPath = Array<string | number>;

function patchNode(doc: yaml.Document, path: DocPath, current: unknown, target: unknown): void {
    if (same(current, target)) {
        return;
    }
    if (isPlainObject(current) && isPlainObject(target)) {
        for (const key of Object.keys(current)) {
            if (!Object.prototype.hasOwnProperty.call(target, key)) {
                doc.deleteIn([...path, key]);
            }
        }
        for (const key of Object.keys(target)) {
            if (Object.prototype.hasOwnProperty.call(current, key)) {
                patchNode(doc, [...path, key], current[key], target[key]);
            } else {
                doc.setIn([...path, key], target[key]);
            }
        }
        return;
    }
    if (isNamedArray(current) && isNamedArray(target)) {
        const targetNames = new Set(target.map((element) => element.name as string));
        for (let index = current.length - 1; index >= 0; index -= 1) {
            if (!targetNames.has(current[index].name as string)) {
                doc.deleteIn([...path, index]);
            }
        }
        const kept = current.filter((element) => targetNames.has(element.name as string));
        const inOrder = kept.every((element, index) => target[index]?.name === element.name);
        if (!inOrder) {
            doc.setIn(path, target);
            return;
        }
        kept.forEach((element, index) => patchNode(doc, [...path, index], element, target[index]));
        for (let index = kept.length; index < target.length; index += 1) {
            doc.addIn(path, target[index]);
        }
        return;
    }
    if (path.length === 0) {
        doc.contents = doc.createNode(target) as typeof doc.contents;
        return;
    }
    doc.setIn(path, target);
}

/** Resolve named segments to the indexes of `document`; `null` when the path is gone. */
function resolveDocPath(
    document: unknown,
    segments: readonly AppSpecMergePathSegment[],
): DocPath | null {
    const out: DocPath = [];
    let cursor: unknown = document;
    for (const segment of segments) {
        if (typeof segment === 'string') {
            if (!isPlainObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, segment)) {
                return null;
            }
            out.push(segment);
            cursor = cursor[segment];
        } else {
            if (!Array.isArray(cursor)) return null;
            const index = cursor.findIndex(
                (element) => isPlainObject(element) && element.name === segment.name,
            );
            if (index < 0) return null;
            out.push(index);
            cursor = cursor[index];
        }
    }
    return out;
}

function withNote(existing: string | null | undefined, note: string): string {
    const kept = (existing ?? '')
        .split('\n')
        .filter((line) => line !== '' && !line.trim().startsWith(APP_SPEC_MERGE_COMMENT_PREFIX));
    kept.push(` ${note}`);
    return kept.join('\n');
}

/** `existing` without the lines a previous run wrote; `null` when nothing is left. */
function withoutNotes(existing: string | null | undefined): string | null {
    if (typeof existing !== 'string' || existing === '') {
        return existing ?? null;
    }
    const kept = existing
        .split('\n')
        .filter((line) => !line.trim().startsWith(APP_SPEC_MERGE_COMMENT_PREFIX));
    return kept.length === 0 ? null : kept.join('\n');
}

type Commented = { commentBefore?: string | null; comment?: string | null };

function stripNotes(node: Commented | null | undefined): void {
    if (!node || typeof node !== 'object') return;
    if ('commentBefore' in node) {
        const next = withoutNotes(node.commentBefore);
        if (next !== node.commentBefore) node.commentBefore = next;
    }
    if ('comment' in node) {
        const next = withoutNotes(node.comment);
        if (next !== node.comment) node.comment = next;
    }
}

/**
 * Remove every note an earlier upgrade wrote, wherever the parser attached it (a note
 * above the first key of a map is read back as the MAP's comment, not the key's), so the
 * file only ever carries the notes of the proposal being made now.
 */
function stripAllNotes(doc: yaml.Document): void {
    stripNotes(doc as unknown as Commented);
    yaml.visit(doc, {
        Node(_key, node) {
            stripNotes(node as unknown as Commented);
        },
        Pair(_key, pair) {
            stripNotes(pair.key as Commented);
            stripNotes(pair.value as Commented);
        },
    });
}

function annotate(doc: yaml.Document, merged: unknown, conflict: AppSpecMergeConflict, version?: string): void {
    if (conflict.kind === 'deleted_by_you') {
        return; // nothing in the file to hang a note on; the pull request lists it.
    }
    const path = resolveDocPath(merged, conflict.segments);
    if (!path || path.length === 0) {
        return;
    }
    const note = mergeConflictNote(conflict, version);
    const last = path[path.length - 1];
    if (typeof last === 'number') {
        const node = doc.getIn(path, true) as { commentBefore?: string | null } | undefined;
        if (node && typeof node === 'object') {
            node.commentBefore = withNote(node.commentBefore, note);
        }
        return;
    }
    const parentPath = path.slice(0, -1);
    const parent = (parentPath.length === 0 ? doc.contents : doc.getIn(parentPath, true)) as unknown;
    if (!yaml.isMap(parent)) {
        return;
    }
    const pair = parent.items.find(
        (item) => yaml.isScalar(item.key) && item.key.value === last,
    );
    if (pair && yaml.isScalar(pair.key)) {
        pair.key.commentBefore = withNote(pair.key.commentBefore, note);
    }
}

/**
 * The text the upgrade pull request commits.
 *
 * `oursText` is patched in place toward `merged` (so the member's comments, quoting and
 * key order survive), each conflict is annotated next to the value that was kept, and
 * the output is **re-parsed and compared** to `merged`: anything that does not read back
 * as exactly the merged document falls back to a plain serialisation of it. A file that
 * cannot be parsed, or no file at all, is serialised the same way.
 */
export function renderMergedAppSpecText(
    oursText: string | null | undefined,
    merged: Record<string, unknown>,
    options: RenderMergedAppSpecOptions = {},
): string {
    const plain = (): string => yaml.stringify(merged, { lineWidth: 0 });
    if (typeof oursText !== 'string' || oursText.trim() === '') {
        return plain();
    }
    try {
        const doc = yaml.parseDocument(oursText);
        if (doc.errors.length > 0 || !yaml.isMap(doc.contents)) {
            return plain();
        }
        patchNode(doc, [], doc.toJS(), merged);
        stripAllNotes(doc);
        for (const conflict of options.conflicts ?? []) {
            try {
                annotate(doc, merged, conflict, options.blueprintVersion);
            } catch {
                // An annotation is an affordance; the merged values are what matter.
            }
        }
        const text = doc.toString({ lineWidth: 0 });
        return same(sanitize(yaml.parse(text)), merged) ? text : plain();
    } catch {
        return plain();
    }
}
