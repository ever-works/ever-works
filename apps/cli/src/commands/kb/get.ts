import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireAuth } from '../auth';
import { getHttpClient } from '../../services/http-client';
import { handleCliError } from '../../utils/error';

/**
 * Shape returned by `GET /api/works/:id/kb/documents/:docIdOrPath` —
 * `KbDocumentBodyDto` from `@ever-works/contracts/kb`. Kept inline
 * for the same package-export reason as `list.ts`.
 */
interface KbDocumentBody {
    id: string;
    path: string;
    title: string;
    class: string;
    status: string;
    locked: boolean;
    lockMode: string | null;
    description: string | null;
    tags: string[];
    categories: string[];
    body: string;
    updatedAt: string;
}

export const getCommand = new Command('get')
    .description('Fetch a Knowledge Base document (markdown body + metadata)')
    .argument('<workId>', 'Work UUID')
    .argument('<idOrPath>', 'KB document UUID or path (e.g. "runbooks/deploy.md")')
    .option('--json', 'Emit the raw JSON DTO instead of rendered markdown')
    .action(async (workId: string, idOrPath: string, options) => {
        try {
            await requireAuth();
            const http = getHttpClient();
            const spinner = ora('Fetching KB document...').start();

            try {
                // `docIdOrPath` legitimately accepts forward slashes
                // (KB paths are slash-separated). `encodeURIComponent`
                // would escape them and break the route match — only
                // escape characters that have URL semantics in path
                // segments. Mirrors the server-side controller param.
                const safeIdOrPath = idOrPath
                    .split('/')
                    .map((segment) => encodeURIComponent(segment))
                    .join('/');
                const url = `/works/${encodeURIComponent(workId)}/kb/documents/${safeIdOrPath}`;
                const { data } = await http.get<KbDocumentBody>(url);
                spinner.stop();

                if (options.json) {
                    // Raw passthrough so callers can pipe into `jq`.
                    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
                    return;
                }

                console.log(chalk.cyan.bold(`\n${data.title}`));
                console.log(chalk.gray('─'.repeat(60)));
                console.log(`${chalk.gray('ID:')}       ${data.id}`);
                console.log(`${chalk.gray('Path:')}     ${data.path}`);
                console.log(`${chalk.gray('Class:')}    ${data.class}`);
                console.log(`${chalk.gray('Status:')}   ${data.status}`);
                if (data.locked) {
                    console.log(
                        `${chalk.gray('Lock:')}     ${chalk.yellow(`locked (${data.lockMode ?? 'unknown'})`)}`,
                    );
                }
                if (data.description) {
                    console.log(`${chalk.gray('Summary:')}  ${data.description}`);
                }
                if (data.tags.length > 0) {
                    console.log(`${chalk.gray('Tags:')}     ${data.tags.join(', ')}`);
                }
                if (data.categories.length > 0) {
                    console.log(`${chalk.gray('Cats:')}     ${data.categories.join(', ')}`);
                }
                console.log(chalk.gray('─'.repeat(60)));
                // Raw markdown body — `cat`-style passthrough. Operators
                // who want highlighting can pipe through `bat`/`glow`.
                process.stdout.write(data.body);
                if (!data.body.endsWith('\n')) process.stdout.write('\n');
            } catch (error) {
                spinner.fail('Failed to fetch KB document');
                throw error;
            }
        } catch (error) {
            handleCliError(error);
            process.exit(1);
        }
    });
