// C-15 (Gauzy Ever Works #35) — `nest build -b swc` compiles every file under `src/`; SWC does not
// honour `tsconfig.build.json`'s `**/*spec.ts` exclude, so `dist/` shipped ~1,100 compiled spec files
// to every consumer of `@ever-works/agent`. Remove them (and their source maps) right after the SWC
// step. Test HELPERS under `__tests__/` are left alone: nothing imports them from `dist`, but they are
// not specs, and deleting more than the finding names is not this script's job.
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');
const SPEC = /\.(spec|test)\.js(\.map)?$/;

let removed = 0;
for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !SPEC.test(entry.name)) continue;
    rmSync(join(entry.parentPath ?? entry.path, entry.name));
    removed += 1;
}
console.log(`strip-dist-specs: removed ${removed} compiled spec file(s) from dist/`);
