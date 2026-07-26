import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Portable date columns — the durable guard for a bug class that has now
 * landed FIVE separate times.
 *
 * better-sqlite3 (the driver behind the entire e2e/CI stack and several
 * integration specs) has no `timestamp` type. A raw `@Column({ type:
 * 'timestamp' })` therefore makes TypeORM's metadata validation throw at
 * BOOT — not at query time:
 *
 *     DataTypeNotSupportedError: Data type "timestamp" in
 *     "IngestedEvent.occurredAt" is not supported by "better-sqlite3".
 *
 * That is total: the API cannot start at all, so every e2e shard dies in
 * global-setup with an error that names one column and looks nothing like
 * "somebody added an entity". The repo's answer is `PortableDateColumn`
 * (`type: Date`), which lets TypeORM pick the dialect's own type —
 * Postgres still gets `timestamp`, sqlite gets `datetime` — or a bare
 * `@Column()` on a `Date`-typed property, which resolves identically via
 * reflected metadata.
 *
 * Every previous fix was a one-off (agent, mission, organization, user,
 * work-budget-alert-state, and most recently the whole Wave 6–9 entity
 * batch), each leaving only a warning comment behind. This spec is the
 * fix that scales: it scans the entity sources, so the SIXTH occurrence
 * fails here, in a fast unit test, instead of in an e2e global-setup.
 */

const ENTITIES_DIR = join(__dirname, '..');

/**
 * Column types that exist on one driver and not the other. `date`, `time`
 * and the `timestamp` family are all Postgres/MySQL spellings that
 * better-sqlite3 rejects outright.
 */
const BANNED_COLUMN_TYPES = [
    'timestamp',
    'timestamptz',
    'timestamp with time zone',
    'timestamp without time zone',
    'datetime',
    'datetime2',
    'datetimeoffset',
    'smalldatetime',
    'date',
    'time',
    'timetz',
    'time with time zone',
    'time without time zone',
];

export interface RawDateColumnFinding {
    line: number;
    snippet: string;
}

/**
 * Strip line + block comments so the many `// H-17: \`type: 'timestamp'\`
 * is Postgres-only` warning comments already in these files are not
 * reported as violations. Replaces comment bodies with spaces so line
 * numbers stay exact.
 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/**
 * Find raw driver-specific date/time column declarations in one entity
 * source. Matches both decorator spellings TypeORM accepts:
 *   - `@Column({ type: 'timestamp' })` / `@Column({ type: "datetime" })`
 *   - `@Column('timestamp', { ... })` (positional type)
 *
 * Exported so the spec can feed it a deliberately-bad fixture — a scanner
 * nobody has ever seen fail is not a guard.
 */
export function findRawDateColumns(source: string): RawDateColumnFinding[] {
    const code = stripComments(source);
    const lines = code.split(/\r?\n/);
    const originalLines = source.split(/\r?\n/);
    const banned = BANNED_COLUMN_TYPES.map((t) => t.toLowerCase());
    const findings: RawDateColumnFinding[] = [];

    // `type:` option form, e.g. `type: 'timestamp'`.
    const optionRe = /\btype\s*:\s*(['"])([^'"]+)\1/g;
    // Positional form, e.g. `@Column('timestamp'` / `@CreateDateColumn('datetime'`.
    const positionalRe = /@\w*Column\s*\(\s*(['"])([^'"]+)\1/g;

    for (let i = 0; i < lines.length; i += 1) {
        for (const re of [optionRe, positionalRe]) {
            re.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = re.exec(lines[i])) !== null) {
                if (banned.includes(match[2].trim().toLowerCase())) {
                    findings.push({ line: i + 1, snippet: originalLines[i].trim() });
                }
            }
        }
    }
    return findings;
}

function entitySourceFiles(): string[] {
    return readdirSync(ENTITIES_DIR)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.d.ts'))
        .sort();
}

describe('entities — portable date columns (sqlite boot guard)', () => {
    const files = entitySourceFiles();

    it('finds entity sources to scan (a scanner over zero files proves nothing)', () => {
        expect(files.length).toBeGreaterThan(50);
        expect(files).toContain('ingested-event.entity.ts');
    });

    it('NO entity declares a raw driver-specific date/time column', () => {
        const offenders: string[] = [];
        for (const file of files) {
            const source = readFileSync(join(ENTITIES_DIR, file), 'utf8');
            for (const finding of findRawDateColumns(source)) {
                offenders.push(`${file}:${finding.line}  ${finding.snippet}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    // The entities named in the 2026-07 feature-program audit. Pinned by
    // name so deleting one is a deliberate act, and so a regression in
    // any of them points at the right file immediately.
    it.each([
        'ingested-event.entity.ts',
        'ingest-cursor.entity.ts',
        'ingest-install-binding.entity.ts',
        'meeting.entity.ts',
        'fleet-node.entity.ts',
        'credit-ledger-entry.entity.ts',
        'plan-entitlement.entity.ts',
    ])('%s (2026-07 wave) uses portable date columns only', (file) => {
        expect(files).toContain(file);
        const source = readFileSync(join(ENTITIES_DIR, file), 'utf8');
        expect(findRawDateColumns(source)).toEqual([]);
    });

    describe('the scanner itself', () => {
        it('CATCHES a deliberately-bad fixture (option form)', () => {
            const bad = `
                @Entity({ name: 'bad_things' })
                export class BadThing {
                    @Column({ type: 'timestamp' })
                    occurredAt: Date;
                }
            `;
            const found = findRawDateColumns(bad);
            expect(found).toHaveLength(1);
            expect(found[0].snippet).toContain("type: 'timestamp'");
        });

        it('CATCHES the positional decorator form', () => {
            const bad = `@Column('timestamptz', { nullable: true })\nendedAt?: Date | null;`;
            expect(findRawDateColumns(bad)).toHaveLength(1);
        });

        it.each(BANNED_COLUMN_TYPES)('CATCHES the banned type `%s`', (type) => {
            expect(findRawDateColumns(`@Column({ type: '${type}' })`)).toHaveLength(1);
        });

        it('CATCHES several offenders in one file and reports each line', () => {
            const bad = [
                "@Column({ type: 'timestamp' })",
                'startedAt: Date;',
                "@Column({ type: 'datetime', nullable: true })",
                'endedAt?: Date | null;',
            ].join('\n');
            expect(findRawDateColumns(bad).map((f) => f.line)).toEqual([1, 3]);
        });

        it('ACCEPTS PortableDateColumn / TimestampColumn / bare @Column', () => {
            const good = [
                '@PortableDateColumn()',
                'occurredAt: Date;',
                '@PortableDateColumn({ nullable: true })',
                'processedAt?: Date | null;',
                "@TimestampColumn({ nullable: true, name: 'last_used_at' })",
                'lastUsedAt: Date;',
                '@Column({ nullable: true })',
                'revokedAt: Date;',
                '@CreateDateColumn()',
                'createdAt: Date;',
            ].join('\n');
            expect(findRawDateColumns(good)).toEqual([]);
        });

        it('does NOT flag unrelated column types', () => {
            const good = [
                "@Column({ type: 'varchar', length: 200 })",
                "@Column({ type: 'uuid', nullable: true })",
                "@Column({ type: 'simple-json' })",
                "@Column({ type: 'bigint', nullable: true })",
                "@Column({ type: 'int', default: 0 })",
            ].join('\n');
            expect(findRawDateColumns(good)).toEqual([]);
        });

        it('does NOT flag the warning COMMENTS the previous fixes left behind', () => {
            // Every earlier one-off fix left a comment quoting the banned
            // literal. A scanner that flagged those would be permanently red.
            const commented = [
                "// H-17: `type: 'timestamp'` is Postgres-only and breaks integration specs",
                '/**',
                " *  PortableDateColumn: raw `type: 'timestamp'` breaks the better-sqlite3",
                ' *  stack at BOOT, not at query time.',
                ' */',
                '@PortableDateColumn({ nullable: true })',
                'lockedUntil?: Date | null;',
            ].join('\n');
            expect(findRawDateColumns(commented)).toEqual([]);
        });

        it('flags a banned type that follows a comment on the SAME line', () => {
            // Comment stripping must not swallow real code before it.
            const bad = "@Column({ type: 'timestamp' }) // portable? no.";
            expect(findRawDateColumns(bad)).toHaveLength(1);
        });
    });
});
