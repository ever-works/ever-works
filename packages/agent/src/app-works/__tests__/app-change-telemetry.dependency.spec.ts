import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * APW-08 T43 (APW08-G16) — the evolve loop's telemetry stays agent-side, over the injected App
 * Works sink and its sanitizer (`app-change.telemetry.ts`); `packages/agent` never takes a
 * dependency on `@ever-works/monitoring`, whichever dependency field it would hide in.
 */
describe('APW-08 T43 — packages/agent does not depend on @ever-works/monitoring', () => {
    const manifest = JSON.parse(
        readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
    ) as Record<string, Record<string, string> | undefined>;

    it.each(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])(
        '%s does not list it',
        (field) => {
            expect(Object.keys(manifest[field] ?? {})).not.toContain('@ever-works/monitoring');
        },
    );

    it('the App Works change telemetry module does not import it', () => {
        const source = readFileSync(join(__dirname, '..', 'app-change.telemetry.ts'), 'utf8');
        expect(source).not.toMatch(/from ['"]@ever-works\/monitoring/);
    });
});
