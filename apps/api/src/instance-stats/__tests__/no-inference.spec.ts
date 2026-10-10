import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Nothing about the installation is inferred. `install_source` comes only from
 * `EVER_INSTALL_SOURCE` and `country` only from `EVER_STATS_COUNTRY`: no file of
 * the statistics module, its identity primitive or its sender reads a payment
 * key, a demo flag, a cloud hint, a desktop flag, a host name or a request's
 * address.
 */
const REPO = join(__dirname, '..', '..', '..', '..', '..');
const ROOTS = [
    join(REPO, 'apps', 'api', 'src', 'instance-stats'),
    join(REPO, 'packages', 'agent', 'src', 'ever-instance'),
    join(REPO, 'packages', 'plugins', 'ever-stats-sink', 'src'),
];
/** Single files on the send path outside those directories. */
const FILES = [
    join(REPO, 'packages', 'contracts', 'src', 'ever-platform', 'stats.ts'),
    join(REPO, 'packages', 'agent', 'src', 'facades', 'stats-sink.facade.ts'),
    join(REPO, 'packages', 'plugin', 'src', 'contracts', 'capabilities', 'stats-sink.interface.ts'),
];

const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
    ['a payment key', /STRIPE_[A-Z_]*KEY/],
    ['a demo flag', /\bDEMO\b|IS_DEMO|DEMO_MODE/],
    ['a cloud hint', /CLOUD_PROVIDER|KUBERNETES_SERVICE_HOST|VERCEL_ENV|\bK_SERVICE\b/],
    ['a desktop flag', /IS_ELECTRON|process\.versions\.electron/],
    ['a host name', /os\.hostname|hostname\(\)|process\.env\.HOSTNAME|networkInterfaces/],
    ['a request address or host', /headers\.host|x-forwarded-for|req(uest)?\.ip\b|remoteAddress/i],
    ['a deployment path', /\/srv\//],
];

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            if (name === '__tests__') continue;
            out.push(...sourceFiles(path));
        } else if (/\.ts$/.test(name) && !/\.spec\.ts$/.test(name)) {
            out.push(path);
        }
    }
    return out;
}

function findings(files: string[]): string[] {
    const found: string[] = [];
    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const [what, pattern] of FORBIDDEN) {
            if (pattern.test(text)) found.push(`${relative(REPO, file)}: ${what}`);
        }
    }
    return found;
}

describe('instance statistics — no inference', () => {
    const files = [...ROOTS.flatMap(sourceFiles), ...FILES];

    it('scans the module, the identity primitive, the sender and the send-path contracts', () => {
        expect(files.length).toBeGreaterThanOrEqual(15);
        for (const file of FILES) expect(statSync(file).isFile()).toBe(true);
    });

    it('reads nothing it could infer the installation from', () => {
        expect(findings(files)).toEqual([]);
    });

    it('control: the scan sees a planted read', () => {
        const planted = join(ROOTS[0], 'instance-stats-builder.service.ts');
        const original = readFileSync(planted, 'utf8');
        const scan = (text: string) =>
            FORBIDDEN.filter(([, pattern]) => pattern.test(text)).map(([what]) => what);
        expect(scan(original)).toEqual([]);
        expect(
            scan(`${original}\nconst cloud = !!process.env.STRIPE_SECRET_KEY || os.hostname();`),
        ).toEqual(['a payment key', 'a host name']);
    });
});
