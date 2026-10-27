import * as yaml from 'yaml';
import {
    APP_SPEC_MERGE_COMMENT_PREFIX,
    conflictComment,
    formatMergePath,
    isNamedArray,
    mergeAppSpecDocuments,
    previewMergeValue,
    renderMergedAppSpecText,
} from '../app-spec-merge';

/**
 * APW-03 T27 — the three-way App spec merge (plan §2.5 "Upgrade", ACC-03-29).
 *
 * base = the Blueprint at the applied version, ours = the App Work's file today,
 * theirs = the Blueprint at the new version. The member's value is never silently
 * overwritten: a disagreement keeps `ours` and is listed.
 */

/** A deep-frozen copy, so a mutation of an input fails the test that made it. */
function frozen<T>(value: T): T {
    const copy = JSON.parse(JSON.stringify(value));
    const freeze = (node: unknown): void => {
        if (node && typeof node === 'object') {
            Object.freeze(node);
            for (const inner of Object.values(node as Record<string, unknown>)) freeze(inner);
        }
    };
    freeze(copy);
    return copy;
}

function doc(spec: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return { version: 2, kind: 'app', name: 'Umami', ...extra, spec };
}

describe('APW-03 T27 — mergeAppSpecDocuments', () => {
    describe('the four basic cases, key by key', () => {
        it('returns ours unchanged when the three agree', () => {
            const value = doc({ build: { dockerfile: 'Dockerfile' } });
            const result = mergeAppSpecDocuments(value, value, value);
            expect(result.merged).toEqual(value);
            expect(result.conflicts).toEqual([]);
            expect(result.applied).toEqual([]);
            expect(result.changed).toBe(false);
            expect(result.baseKnown).toBe(true);
        });

        it('takes the Blueprint value when only the Blueprint changed it', () => {
            const base = doc({ build: { dockerfile: 'Dockerfile' } });
            const ours = doc({ build: { dockerfile: 'Dockerfile' } });
            const theirs = doc({ build: { dockerfile: 'Dockerfile.prod' } });
            const result = mergeAppSpecDocuments(base, ours, theirs);
            expect(result.merged).toEqual(theirs);
            expect(result.conflicts).toEqual([]);
            expect(result.applied).toEqual([
                expect.objectContaining({ path: 'spec.build.dockerfile', kind: 'changed' }),
            ]);
            expect(result.changed).toBe(true);
        });

        it('keeps the member value when only the member changed it (ACC-03-29: user change kept)', () => {
            const base = doc({ build: { dockerfile: 'Dockerfile' } });
            const ours = doc({ build: { dockerfile: 'Dockerfile.custom' } });
            const theirs = doc({ build: { dockerfile: 'Dockerfile' } });
            const result = mergeAppSpecDocuments(base, ours, theirs);
            expect(result.merged).toEqual(ours);
            expect(result.conflicts).toEqual([]);
            expect(result.changed).toBe(false);
        });

        it('lists a conflict and keeps ours when both changed a leaf differently (ACC-03-29)', () => {
            const base = doc({ build: { dockerfile: 'Dockerfile' } });
            const ours = doc({ build: { dockerfile: 'Dockerfile.custom' } });
            const theirs = doc({ build: { dockerfile: 'Dockerfile.prod' } });
            const result = mergeAppSpecDocuments(base, ours, theirs);
            expect(result.merged).toEqual(ours);
            expect(result.conflicts).toEqual([
                {
                    path: 'spec.build.dockerfile',
                    segments: ['spec', 'build', 'dockerfile'],
                    kind: 'both_changed',
                    base: 'Dockerfile',
                    ours: 'Dockerfile.custom',
                    theirs: 'Dockerfile.prod',
                },
            ]);
            expect(result.conflictCount).toBe(1);
        });

        it('is not a conflict when both sides made the same change', () => {
            const base = doc({ build: { dockerfile: 'Dockerfile' } });
            const both = doc({ build: { dockerfile: 'Dockerfile.prod' } });
            const result = mergeAppSpecDocuments(base, both, both);
            expect(result.conflicts).toEqual([]);
            expect(result.merged).toEqual(both);
        });

        it('merges sibling keys independently — one side each, no conflict', () => {
            const base = doc({ build: { dockerfile: 'Dockerfile', context: '.' } });
            const ours = doc({ build: { dockerfile: 'Dockerfile.custom', context: '.' } });
            const theirs = doc({ build: { dockerfile: 'Dockerfile', context: 'app' } });
            const result = mergeAppSpecDocuments(base, ours, theirs);
            expect(result.merged).toEqual(doc({ build: { dockerfile: 'Dockerfile.custom', context: 'app' } }));
            expect(result.conflicts).toEqual([]);
        });
    });

    describe('additions and removals', () => {
        it('adds a key the Blueprint added', () => {
            const base = doc({ build: { dockerfile: 'Dockerfile' } });
            const theirs = doc({ build: { dockerfile: 'Dockerfile' }, smoke: [{ name: 'home', path: '/' }] });
            const result = mergeAppSpecDocuments(base, base, theirs);
            expect(result.merged).toEqual(theirs);
            expect(result.applied).toEqual([expect.objectContaining({ path: 'spec.smoke', kind: 'added' })]);
        });

        it('keeps a key only the member added', () => {
            const base = doc({ build: { dockerfile: 'Dockerfile' } });
            const ours = doc({ build: { dockerfile: 'Dockerfile' }, domains: { managed: true } });
            const result = mergeAppSpecDocuments(base, ours, base);
            expect(result.merged).toEqual(ours);
        });

        it('removes a key the Blueprint removed when the member never touched it', () => {
            const base = doc({ build: { dockerfile: 'Dockerfile', args: ['A=1'] } });
            const theirs = doc({ build: { dockerfile: 'Dockerfile' } });
            const result = mergeAppSpecDocuments(base, base, theirs);
            expect(result.merged).toEqual(theirs);
            expect(result.applied).toEqual([
                expect.objectContaining({ path: 'spec.build.args', kind: 'removed' }),
            ]);
        });

        it('keeps a key the Blueprint removed when the member had changed it — listed', () => {
            const base = doc({ build: { dockerfile: 'Dockerfile', args: ['A=1'] } });
            const ours = doc({ build: { dockerfile: 'Dockerfile', args: ['A=2'] } });
            const theirs = doc({ build: { dockerfile: 'Dockerfile' } });
            const result = mergeAppSpecDocuments(base, ours, theirs);
            expect(result.merged).toEqual(ours);
            expect(result.conflicts).toEqual([
                expect.objectContaining({
                    path: 'spec.build.args',
                    kind: 'deleted_by_blueprint',
                    ours: ['A=2'],
                    theirs: undefined,
                }),
            ]);
        });

        it('leaves a key the member removed removed when the Blueprint did not change it', () => {
            const base = doc({ build: { dockerfile: 'Dockerfile', context: '.' } });
            const ours = doc({ build: { dockerfile: 'Dockerfile' } });
            const result = mergeAppSpecDocuments(base, ours, base);
            expect(result.merged).toEqual(ours);
            expect(result.conflicts).toEqual([]);
        });

        it('leaves a key the member removed removed when the Blueprint changed it — listed as deleted_by_you', () => {
            const base = doc({ build: { dockerfile: 'Dockerfile', context: '.' } });
            const ours = doc({ build: { dockerfile: 'Dockerfile' } });
            const theirs = doc({ build: { dockerfile: 'Dockerfile', context: 'web' } });
            const result = mergeAppSpecDocuments(base, ours, theirs);
            expect(result.merged).toEqual(ours);
            expect(result.conflicts).toEqual([
                expect.objectContaining({ path: 'spec.build.context', kind: 'deleted_by_you', theirs: 'web' }),
            ]);
        });

        it('drops a key both sides removed', () => {
            const base = doc({ build: { dockerfile: 'Dockerfile', context: '.' } });
            const both = doc({ build: { dockerfile: 'Dockerfile' } });
            expect(mergeAppSpecDocuments(base, both, both).merged).toEqual(both);
        });
    });

    describe('arrays of named objects are merged by name', () => {
        const base = doc({
            env: [
                { name: 'A', value: '1' },
                { name: 'B', value: '2' },
            ],
        });

        it('takes a Blueprint edit of one entry and keeps a member edit of another, and adds a new one', () => {
            const ours = doc({
                env: [
                    { name: 'A', value: 'mine' },
                    { name: 'B', value: '2' },
                ],
            });
            const theirs = doc({
                env: [
                    { name: 'A', value: '1' },
                    { name: 'B', value: 'theirs' },
                    { name: 'C', value: '3' },
                ],
            });
            const result = mergeAppSpecDocuments(base, ours, theirs);
            expect(result.merged).toEqual(
                doc({
                    env: [
                        { name: 'A', value: 'mine' },
                        { name: 'B', value: 'theirs' },
                        { name: 'C', value: '3' },
                    ],
                }),
            );
            expect(result.conflicts).toEqual([]);
            expect(result.applied.map((change) => change.path)).toEqual([
                'spec.env[name=B].value',
                'spec.env[name=C]',
            ]);
        });

        it('keeps an env entry the Blueprint removed when the member edited it (ACC-03-29)', () => {
            const ours = doc({
                env: [
                    { name: 'A', value: '1' },
                    { name: 'B', value: 'edited' },
                ],
            });
            const theirs = doc({ env: [{ name: 'A', value: '1' }] });
            const result = mergeAppSpecDocuments(base, ours, theirs);
            expect(result.merged).toEqual(ours);
            expect(result.conflicts).toEqual([
                expect.objectContaining({ path: 'spec.env[name=B]', kind: 'deleted_by_blueprint' }),
            ]);
        });

        it('removes an env entry the Blueprint removed when the member did not edit it', () => {
            const theirs = doc({ env: [{ name: 'A', value: '1' }] });
            const result = mergeAppSpecDocuments(base, base, theirs);
            expect(result.merged).toEqual(theirs);
            expect(result.conflicts).toEqual([]);
        });

        it('keeps an entry the member deleted deleted', () => {
            const ours = doc({ env: [{ name: 'A', value: '1' }] });
            const result = mergeAppSpecDocuments(base, ours, base);
            expect(result.merged).toEqual(ours);
            expect(result.conflicts).toEqual([]);
        });

        it('names the nested path of a conflict inside one entry', () => {
            const ours = doc({
                env: [
                    { name: 'A', value: 'mine' },
                    { name: 'B', value: '2' },
                ],
            });
            const theirs = doc({
                env: [
                    { name: 'A', value: 'theirs' },
                    { name: 'B', value: '2' },
                ],
            });
            const result = mergeAppSpecDocuments(base, ours, theirs);
            expect(result.merged).toEqual(ours);
            expect(result.conflicts).toEqual([
                expect.objectContaining({
                    path: 'spec.env[name=A].value',
                    segments: ['spec', 'env', { name: 'A' }, 'value'],
                    kind: 'both_changed',
                }),
            ]);
        });

        it('merges components, jobs, cron, smoke and checks the same way', () => {
            for (const block of ['components', 'jobs', 'cron', 'smoke', 'checks']) {
                const b = doc({ [block]: [{ name: 'one', x: 1 }] });
                const o = doc({ [block]: [{ name: 'one', x: 1, mine: true }] });
                const t = doc({ [block]: [{ name: 'one', x: 1 }, { name: 'two', x: 2 }] });
                const result = mergeAppSpecDocuments(b, o, t);
                expect(result.conflicts).toEqual([]);
                expect(result.merged.spec).toEqual({
                    [block]: [
                        { name: 'one', x: 1, mine: true },
                        { name: 'two', x: 2 },
                    ],
                });
            }
        });

        it('keeps the member order and appends what the Blueprint added, in its order', () => {
            const b = doc({ env: [{ name: 'A' }, { name: 'B' }] });
            const o = doc({ env: [{ name: 'B' }, { name: 'A' }] });
            const t = doc({ env: [{ name: 'Z' }, { name: 'A' }, { name: 'Y' }, { name: 'B' }] });
            const result = mergeAppSpecDocuments(b, o, t);
            expect((result.merged.spec as { env: Array<{ name: string }> }).env.map((e) => e.name)).toEqual([
                'B',
                'A',
                'Z',
                'Y',
            ]);
        });

        it('treats an array with duplicate names as one value', () => {
            const b = doc({ env: [{ name: 'A', value: '1' }, { name: 'A', value: '2' }] });
            const o = doc({ env: [{ name: 'A', value: 'x' }, { name: 'A', value: '2' }] });
            const t = doc({ env: [{ name: 'A', value: '1' }, { name: 'A', value: 'y' }] });
            const result = mergeAppSpecDocuments(b, o, t);
            expect(result.merged).toEqual(o);
            expect(result.conflicts).toEqual([expect.objectContaining({ path: 'spec.env', kind: 'both_changed' })]);
        });
    });

    describe('every other array is one value', () => {
        it('never merges a command element-wise — both changed is a conflict, ours kept', () => {
            const b = doc({ components: [{ name: 'web', command: ['node', 'b.js'] }] });
            const o = doc({ components: [{ name: 'web', command: ['node', 'a.js'] }] });
            const t = doc({ components: [{ name: 'web', command: ['node', 'c.js'] }] });
            const result = mergeAppSpecDocuments(b, o, t);
            expect(result.merged).toEqual(o);
            expect(result.conflicts).toEqual([
                expect.objectContaining({ path: 'spec.components[name=web].command', kind: 'both_changed' }),
            ]);
        });

        it('takes a whole new command when only the Blueprint changed it', () => {
            const b = doc({ components: [{ name: 'web', command: ['node', 'b.js'] }] });
            const t = doc({ components: [{ name: 'web', command: ['node', 'c.js', '--port', '3000'] }] });
            expect(mergeAppSpecDocuments(b, b, t).merged).toEqual(t);
        });

        it('a change of type (scalar to object) on both sides is a conflict', () => {
            const b = doc({ domains: 'auto' });
            const o = doc({ domains: { managed: true } });
            const t = doc({ domains: 'none' });
            const result = mergeAppSpecDocuments(b, o, t);
            expect(result.merged).toEqual(o);
            expect(result.conflicts).toEqual([expect.objectContaining({ path: 'spec.domains', kind: 'both_changed' })]);
        });
    });

    describe('the two owned paths', () => {
        it('takes spec.source from ours, never from theirs', () => {
            const b = doc({ source: { relation: 'fork', branch: 'main' } });
            const o = doc({ source: { relation: 'fork', branch: 'main', upstream: { repo: 'umami-software/umami' } } });
            const t = doc({ source: { relation: 'link', branch: 'develop' } });
            const result = mergeAppSpecDocuments(b, o, t);
            expect((result.merged.spec as Record<string, unknown>).source).toEqual(
                (o.spec as Record<string, unknown>).source,
            );
            expect(result.conflicts).toEqual([]);
        });

        it('leaves spec.source absent when ours has none, even if theirs carries one', () => {
            const result = mergeAppSpecDocuments(doc({}), doc({}), doc({ source: { relation: 'link' } }));
            expect(result.merged.spec).toEqual({});
        });

        it('takes spec.blueprint from theirs, so the file names the new version', () => {
            const b = doc({ blueprint: { id: 'umami', version: '0.1.0', repo: 'ever-works/umami-template' } });
            const o = doc({ blueprint: { id: 'umami', version: '0.1.0', repo: 'ever-works/umami-template' } });
            const t = doc({ blueprint: { id: 'umami', version: '0.2.0', repo: 'ever-works/umami-template' } });
            const result = mergeAppSpecDocuments(b, o, t);
            expect((result.merged.spec as Record<string, unknown>).blueprint).toEqual(
                (t.spec as Record<string, unknown>).blueprint,
            );
            expect(result.conflicts).toEqual([]);
        });

        it('keeps ours spec.blueprint when theirs has none', () => {
            const o = doc({ blueprint: { id: 'umami', version: '0.1.0' } });
            const result = mergeAppSpecDocuments(doc({}), o, doc({}));
            expect(result.merged).toEqual(o);
        });

        it('accepts custom owned paths', () => {
            const b = doc({ display: { name: 'A' } });
            const o = doc({ display: { name: 'Mine' } });
            const t = doc({ display: { name: 'Theirs' } });
            const result = mergeAppSpecDocuments(b, o, t, { theirsOwned: [['spec', 'display']] });
            expect(result.merged).toEqual(t);
            expect(result.conflicts).toEqual([]);
        });
    });

    describe('an unknown base (null) and apply mode (empty base)', () => {
        const ours = doc({
            source: { relation: 'fork', branch: 'main' },
            build: { dockerfile: 'Dockerfile.custom', context: '.' },
            env: [{ name: 'MINE', value: 'x' }],
        });
        const theirs = doc({
            blueprint: { id: 'umami', version: '0.2.0' },
            build: { dockerfile: 'Dockerfile', target: 'prod' },
            env: [{ name: 'MINE', value: 'blueprint' }, { name: 'NEW', value: 'y' }],
        });

        it('adds what only the Blueprint has, keeps what only the member has, removes nothing', () => {
            const result = mergeAppSpecDocuments(null, ours, theirs);
            expect(result.baseKnown).toBe(false);
            expect(result.merged).toEqual(
                doc({
                    source: { relation: 'fork', branch: 'main' },
                    build: { dockerfile: 'Dockerfile.custom', context: '.', target: 'prod' },
                    env: [
                        { name: 'MINE', value: 'x' },
                        { name: 'NEW', value: 'y' },
                    ],
                    blueprint: { id: 'umami', version: '0.2.0' },
                }),
            );
            expect(result.conflicts.map((c) => [c.path, c.kind])).toEqual([
                ['spec.build.dockerfile', 'both_added'],
                ['spec.env[name=MINE].value', 'both_added'],
            ]);
        });

        it('gives the same merge for an empty base (a Blueprint applied to a Work that had none)', () => {
            const unknown = mergeAppSpecDocuments(undefined, ours, theirs);
            const empty = mergeAppSpecDocuments({}, ours, theirs);
            expect(empty.merged).toEqual(unknown.merged);
            expect(empty.conflicts.map((c) => c.path)).toEqual(unknown.conflicts.map((c) => c.path));
            expect(empty.baseKnown).toBe(true);
        });

        it('applies the whole Blueprint onto a source-only file without a conflict', () => {
            const sourceOnly = { version: 2, kind: 'app', spec: { source: { relation: 'fork', branch: 'main' } } };
            const result = mergeAppSpecDocuments({}, sourceOnly, theirs);
            expect(result.conflicts).toEqual([]);
            expect(result.merged.spec).toEqual({
                source: { relation: 'fork', branch: 'main' },
                blueprint: { id: 'umami', version: '0.2.0' },
                build: { dockerfile: 'Dockerfile', target: 'prod' },
                env: [
                    { name: 'MINE', value: 'blueprint' },
                    { name: 'NEW', value: 'y' },
                ],
            });
            expect(result.merged.name).toBe('Umami');
        });
    });

    describe('purity and safety', () => {
        it('never mutates an input, and the same inputs give the same output', () => {
            const b = frozen(doc({ env: [{ name: 'A', value: '1' }], build: { dockerfile: 'D' } }));
            const o = frozen(doc({ env: [{ name: 'A', value: '2' }], build: { dockerfile: 'D' } }));
            const t = frozen(doc({ env: [{ name: 'A', value: '1' }, { name: 'B' }], build: { dockerfile: 'E' } }));
            const first = mergeAppSpecDocuments(b, o, t);
            const second = mergeAppSpecDocuments(b, o, t);
            expect(JSON.stringify(first)).toBe(JSON.stringify(second));
            // The result shares no object with an input.
            (first.merged.spec as Record<string, unknown>).build = 'changed';
            expect((o.spec as Record<string, unknown>).build).toEqual({ dockerfile: 'D' });
        });

        it('drops prototype-polluting keys from every side', () => {
            const theirs = yaml.parse('spec:\n  __proto__:\n    polluted: true\n  constructor:\n    x: 1\n  build:\n    dockerfile: D\n');
            const result = mergeAppSpecDocuments({}, {}, theirs);
            expect(Object.keys(result.merged.spec as object)).toEqual(['build']);
            expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        });

        it('reads a non-object ours or theirs as an empty document', () => {
            expect(mergeAppSpecDocuments(null, 'garbage', { spec: { a: 1 } }).merged).toEqual({ spec: { a: 1 } });
            expect(mergeAppSpecDocuments(null, { spec: { a: 1 } }, [1, 2]).merged).toEqual({ spec: { a: 1 } });
        });

        it('caps the listed conflicts but counts all of them', () => {
            const keys = ['a', 'b', 'c', 'd', 'e'];
            const b = doc(Object.fromEntries(keys.map((k) => [k, 'base'])));
            const o = doc(Object.fromEntries(keys.map((k) => [k, 'ours'])));
            const t = doc(Object.fromEntries(keys.map((k) => [k, 'theirs'])));
            const result = mergeAppSpecDocuments(b, o, t, { maxConflicts: 2 });
            expect(result.conflicts).toHaveLength(2);
            expect(result.conflictCount).toBe(5);
            expect(result.merged).toEqual(o);
        });

        it('keeps root keys (version, kind, name) by the same rules', () => {
            const b = { version: 2, kind: 'app', name: 'Umami', spec: {} };
            const o = { version: 2, kind: 'app', name: 'My analytics', spec: {} };
            const t = { version: 2, kind: 'app', name: 'Umami Analytics', spec: {} };
            const result = mergeAppSpecDocuments(b, o, t);
            expect(result.merged.name).toBe('My analytics');
            expect(result.conflicts).toEqual([expect.objectContaining({ path: 'name', kind: 'both_changed' })]);
        });
    });

    describe('a realistic upgrade (Umami 0.1.0 → 0.2.0)', () => {
        const base = yaml.parse(`
version: 2
kind: app
name: Umami
spec:
  blueprint: { id: umami, version: 0.1.0, repo: ever-works/umami-template }
  license: { spdx: MIT }
  build: { dockerfile: Dockerfile }
  components:
    - name: web
      port: 3000
      replicas: 1
  dependencies:
    postgres: { version: '16' }
  env:
    - name: DATABASE_URL
      fromDependency: postgres
    - name: APP_SECRET
      generate: { kind: secret, length: 32 }
    - name: DISABLE_TELEMETRY
      value: '1'
`);
        const ours = yaml.parse(`
version: 2
kind: app
name: Umami
spec:
  source: { relation: fork, upstream: { repo: umami-software/umami }, branch: master }
  blueprint: { id: umami, version: 0.1.0, repo: ever-works/umami-template }
  license: { spdx: MIT }
  build: { dockerfile: Dockerfile }
  components:
    - name: web
      port: 3000
      replicas: 2
  dependencies:
    postgres: { version: '16' }
  env:
    - name: DATABASE_URL
      fromDependency: postgres
    - name: APP_SECRET
      generate: { kind: secret, length: 32 }
    - name: DISABLE_TELEMETRY
      value: '0'
    - name: TRACKER_SCRIPT_NAME
      value: stats.js
`);
        const theirs = yaml.parse(`
version: 2
kind: app
name: Umami
spec:
  blueprint: { id: umami, version: 0.2.0, repo: ever-works/umami-template }
  license: { spdx: MIT }
  build: { dockerfile: Dockerfile, target: production }
  components:
    - name: web
      port: 3000
      replicas: 1
      probes: { readiness: { http: { path: /api/heartbeat } } }
  dependencies:
    postgres: { version: '17' }
  env:
    - name: DATABASE_URL
      fromDependency: postgres
    - name: APP_SECRET
      generate: { kind: secret, length: 32 }
    - name: DISABLE_TELEMETRY
      value: '2'
  smoke:
    - name: heartbeat
      path: /api/heartbeat
`);

        it('applies every Blueprint change the member did not touch and lists the one collision', () => {
            const result = mergeAppSpecDocuments(base, ours, theirs);
            const spec = result.merged.spec as Record<string, any>;
            expect(spec.source).toEqual(ours.spec.source);
            expect(spec.blueprint.version).toBe('0.2.0');
            expect(spec.build).toEqual({ dockerfile: 'Dockerfile', target: 'production' });
            expect(spec.components).toEqual([
                {
                    name: 'web',
                    port: 3000,
                    replicas: 2,
                    probes: { readiness: { http: { path: '/api/heartbeat' } } },
                },
            ]);
            expect(spec.dependencies).toEqual({ postgres: { version: '17' } });
            expect(spec.env.map((entry: { name: string }) => entry.name)).toEqual([
                'DATABASE_URL',
                'APP_SECRET',
                'DISABLE_TELEMETRY',
                'TRACKER_SCRIPT_NAME',
            ]);
            expect(spec.env[2]).toEqual({ name: 'DISABLE_TELEMETRY', value: '0' });
            expect(spec.smoke).toEqual(theirs.spec.smoke);
            expect(result.conflicts.map((c) => [c.path, c.kind])).toEqual([
                ['spec.env[name=DISABLE_TELEMETRY].value', 'both_changed'],
            ]);
            expect(result.changed).toBe(true);
        });
    });
});

describe('APW-03 T27 — helpers', () => {
    it('formats paths with named segments and quotes odd keys', () => {
        expect(formatMergePath(['spec', 'env', { name: 'A_B' }, 'value'])).toBe('spec.env[name=A_B].value');
        expect(formatMergePath(['spec', 'a.b', 'c d'])).toBe('spec["a.b"]["c d"]');
        expect(formatMergePath([])).toBe('(document)');
    });

    it('recognises named arrays', () => {
        expect(isNamedArray([{ name: 'a' }, { name: 'b' }])).toBe(true);
        expect(isNamedArray([])).toBe(true);
        expect(isNamedArray([{ name: 'a' }, { name: 'a' }])).toBe(false);
        expect(isNamedArray([{ name: '' }])).toBe(false);
        expect(isNamedArray([{ id: 'a' }])).toBe(false);
        expect(isNamedArray(['a'])).toBe(false);
        expect(isNamedArray({ name: 'a' })).toBe(false);
    });

    it('previews a value on one line, bounded', () => {
        expect(previewMergeValue('x\ny')).toBe('"x\\ny"');
        expect(previewMergeValue(undefined)).toBe('(absent)');
        expect(previewMergeValue({ a: 1 })).toBe('{"a":1}');
        const long = previewMergeValue('z'.repeat(500));
        expect(long.length).toBeLessThanOrEqual(80);
        expect(long.endsWith('…')).toBe(true);
    });

    it('never echoes the member value in a conflict note', () => {
        const note = conflictComment(
            {
                path: 'spec.env[name=A].value',
                segments: ['spec', 'env', { name: 'A' }, 'value'],
                kind: 'both_changed',
                base: '1',
                ours: 'member-secret-looking-value',
                theirs: '2',
            },
            '0.2.0',
        );
        expect(note).toContain(APP_SPEC_MERGE_COMMENT_PREFIX);
        expect(note).toContain('Blueprint 0.2.0 proposes "2"');
        expect(note).not.toContain('member-secret-looking-value');
    });
});

describe('APW-03 T27 — renderMergedAppSpecText', () => {
    const oursText = `# Umami, deployed by Ever Works
version: 2
kind: app
name: Umami
spec:
  # Never change the source block by hand.
  source:
    relation: fork
    branch: master
  blueprint:
    id: umami
    version: 0.1.0
  build:
    dockerfile: "Dockerfile" # quoted on purpose
  env:
    - name: A
      value: "1" # first
    - name: B
      value: "2"
`;

    it('patches the member file in place: comments, quoting and order survive', () => {
        const ours = yaml.parse(oursText);
        const theirs = yaml.parse(oursText.replace('0.1.0', '0.2.0').replace('"2"', '"22"')) as Record<string, any>;
        theirs.spec.env.push({ name: 'C', value: '3' });
        theirs.spec.build.target = 'prod';
        const base = yaml.parse(oursText);
        const result = mergeAppSpecDocuments(base, ours, theirs);
        const text = renderMergedAppSpecText(oursText, result.merged);

        expect(yaml.parse(text)).toEqual(result.merged);
        expect(text).toContain('# Umami, deployed by Ever Works');
        expect(text).toContain('# Never change the source block by hand.');
        expect(text).toContain('dockerfile: "Dockerfile" # quoted on purpose');
        expect(text).toContain('value: "1" # first');
        expect(text).toContain('version: 0.2.0');
        expect(text).toContain('target: prod');
        expect(text.indexOf('name: A')).toBeLessThan(text.indexOf('name: C'));
    });

    it('annotates each kept value, without the member value, and replaces an old note on re-run', () => {
        const base = yaml.parse(oursText);
        const ours = yaml.parse(oursText.replace('"Dockerfile"', '"Dockerfile.mine"'));
        const theirs = yaml.parse(oursText.replace('"Dockerfile"', '"Dockerfile.prod"'));
        const oursFile = oursText.replace('"Dockerfile"', '"Dockerfile.mine"');
        const result = mergeAppSpecDocuments(base, ours, theirs);
        expect(result.conflicts).toHaveLength(1);

        const first = renderMergedAppSpecText(oursFile, result.merged, {
            conflicts: result.conflicts,
            blueprintVersion: '0.2.0',
        });
        expect(first).toContain('# ever-works: Blueprint 0.2.0 proposes "Dockerfile.prod"; your value was kept.');
        expect(yaml.parse(first)).toEqual(result.merged);

        // A second run (a newer version) replaces the note rather than stacking it.
        const again = renderMergedAppSpecText(first, result.merged, {
            conflicts: result.conflicts,
            blueprintVersion: '0.3.0',
        });
        expect(again.match(/# ever-works:/g)).toHaveLength(1);
        expect(again).toContain('Blueprint 0.3.0');
    });

    it('annotates a kept named-array entry the Blueprint removed', () => {
        const base = yaml.parse(oursText);
        const oursFile = oursText.replace('value: "2"', 'value: "edited"');
        const ours = yaml.parse(oursFile);
        const theirs = yaml.parse(oursText) as Record<string, any>;
        theirs.spec.env = theirs.spec.env.filter((entry: { name: string }) => entry.name !== 'B');
        const result = mergeAppSpecDocuments(base, ours, theirs);
        const text = renderMergedAppSpecText(oursFile, result.merged, {
            conflicts: result.conflicts,
            blueprintVersion: '0.2.0',
        });
        expect(text).toMatch(/# ever-works: Blueprint 0\.2\.0 removes this; you changed it, so it was kept\.\n\s+- name: B/);
        expect(yaml.parse(text)).toEqual(result.merged);
    });

    it('removes a named entry and rewrites a reordered array, still reading back exactly', () => {
        const merged = yaml.parse(oursText) as Record<string, any>;
        merged.spec.env = [{ name: 'B', value: '2' }, { name: 'A', value: '1' }];
        const reordered = renderMergedAppSpecText(oursText, merged);
        expect(yaml.parse(reordered)).toEqual(merged);

        const removed = yaml.parse(oursText) as Record<string, any>;
        removed.spec.env = [{ name: 'B', value: '2' }];
        const text = renderMergedAppSpecText(oursText, removed);
        expect(yaml.parse(text)).toEqual(removed);
        expect(text).not.toContain('name: A');
    });

    it('serialises plainly when there is no file, or the file does not parse', () => {
        const merged = { version: 2, kind: 'app', spec: { build: { dockerfile: 'D' } } };
        expect(yaml.parse(renderMergedAppSpecText(null, merged))).toEqual(merged);
        expect(yaml.parse(renderMergedAppSpecText('   ', merged))).toEqual(merged);
        expect(yaml.parse(renderMergedAppSpecText('spec: [unclosed', merged))).toEqual(merged);
        expect(yaml.parse(renderMergedAppSpecText('- a list\n- not a map\n', merged))).toEqual(merged);
    });
});
