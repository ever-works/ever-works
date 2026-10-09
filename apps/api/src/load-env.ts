import { configDotenv } from 'dotenv';
import * as path from 'path';

/**
 * Load the API's `.env` file (from the working directory) into `process.env`.
 *
 * `main.ts` imports this module FIRST, before anything else and above all
 * before `ApiModule`. Nest evaluates the arguments of `@Module({...})` when a
 * module file is imported, and some of them read the environment at that
 * moment: the anonymous usage statistics module, for one, is imported only
 * when `EVER_STATS_ENABLED` is `true`. Loading the file later (inside
 * `bootstrap()`) left such a switch blind to a value written in `.env` — the
 * operator's choice there (on or off) was ignored.
 *
 * Nothing else changes: a variable already in the environment (container env,
 * the shell, a process manager) still wins over the file, because dotenv never
 * overrides one, and a missing file is not an error.
 */
export function loadApiEnvFile(cwd: string = process.cwd()): void {
    configDotenv({ path: path.resolve(cwd, '.env') });
}

loadApiEnvFile();
