import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireAuth } from '../auth';
import { getHttpClient } from '../../services/http-client';
import { handleCliError } from '../../utils/error';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_LOCK_MODES = new Set(['full', 'content']);

/**
 * Resolve a `<idOrPath>` argument to a KB document UUID. The lock /
 * unlock endpoints are pinned to `:docId` (`ParseUUIDPipe` on the
 * server), but operators typically know documents by path. We hit
 * the GET-by-id-or-path route to translate before issuing the
 * mutation.
 */
async function resolveDocId(
    workId: string,
    idOrPath: string,
    http = getHttpClient(),
): Promise<string> {
    if (UUID_RE.test(idOrPath)) return idOrPath;

    const safe = idOrPath
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
    const { data } = await http.get<{ id: string }>(
        `/works/${encodeURIComponent(workId)}/kb/documents/${safe}`,
    );
    return data.id;
}

export const lockCommand = new Command('lock')
    .description('Lock a Knowledge Base document (full or content-only)')
    .argument('<workId>', 'Work UUID')
    .argument('<idOrPath>', 'KB document UUID or path')
    .requiredOption('--mode <mode>', 'Lock mode: "full" or "content"')
    .action(async (workId: string, idOrPath: string, options) => {
        try {
            await requireAuth();

            const mode = String(options.mode).toLowerCase();
            if (!VALID_LOCK_MODES.has(mode)) {
                console.error(chalk.red('Error: --mode must be either "full" or "content"'));
                process.exit(1);
            }

            const http = getHttpClient();
            const spinner = ora('Locking KB document...').start();

            try {
                const docId = await resolveDocId(workId, idOrPath, http);
                const { data } = await http.post<{
                    id: string;
                    locked: boolean;
                    lockMode: string | null;
                }>(`/works/${encodeURIComponent(workId)}/kb/documents/${docId}/lock`, { mode });
                spinner.succeed(
                    `Locked ${chalk.cyan(data.id)} (mode=${chalk.yellow(data.lockMode ?? mode)})`,
                );
            } catch (error) {
                spinner.fail('Failed to lock KB document');
                throw error;
            }
        } catch (error) {
            handleCliError(error);
            process.exit(1);
        }
    });

export const unlockCommand = new Command('unlock')
    .description('Unlock a Knowledge Base document')
    .argument('<workId>', 'Work UUID')
    .argument('<idOrPath>', 'KB document UUID or path')
    .action(async (workId: string, idOrPath: string) => {
        try {
            await requireAuth();
            const http = getHttpClient();
            const spinner = ora('Unlocking KB document...').start();

            try {
                const docId = await resolveDocId(workId, idOrPath, http);
                const { data } = await http.post<{ id: string; locked: boolean }>(
                    `/works/${encodeURIComponent(workId)}/kb/documents/${docId}/unlock`,
                );
                spinner.succeed(
                    `Unlocked ${chalk.cyan(data.id)} (locked=${chalk.gray(String(data.locked))})`,
                );
            } catch (error) {
                spinner.fail('Failed to unlock KB document');
                throw error;
            }
        } catch (error) {
            handleCliError(error);
            process.exit(1);
        }
    });
