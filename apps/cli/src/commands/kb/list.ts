import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireAuth } from '../auth';
import { getHttpClient } from '../../services/http-client';
import { handleCliError } from '../../utils/error';

/**
 * Row shape emitted by `GET /api/works/:id/kb/documents`. Mirrors
 * `KbDocumentDto` from `@ever-works/contracts/kb` but kept minimal so
 * the CLI doesn't take a hard dependency on the contracts package's
 * KB sub-path (which isn't currently re-exported via the package's
 * top-level `exports` map — `dist/index.cjs` only).
 */
interface KbDocumentRow {
    id: string;
    path: string;
    title: string;
    class: string;
    status: string;
    locked: boolean;
    tags: string[];
    updatedAt: string;
}

interface KbDocumentListResponse {
    items: KbDocumentRow[];
    total: number;
}

function parsePositiveInt(name: string, raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 0 || !isFinite(parsed)) {
        console.error(chalk.red(`Error: --${name} must be a non-negative integer`));
        process.exit(1);
    }
    return parsed;
}

function truncate(value: string, max: number): string {
    if (value.length <= max) return value;
    return value.slice(0, Math.max(0, max - 1)) + '…';
}

export const listCommand = new Command('list')
    .description('List Knowledge Base documents for a Work')
    .argument('<workId>', 'Work UUID')
    .option('--class <class>', 'Filter by KB document class (e.g. note, runbook, brief)')
    .option('--tag <tag>', 'Filter by tag slug')
    .option('--q <query>', 'Lexical + semantic blended search query')
    .option('--limit <n>', 'Max rows to return', '20')
    .option('--offset <n>', 'Pagination offset', '0')
    .action(async (workId: string, options) => {
        try {
            await requireAuth();

            const limit = parsePositiveInt('limit', options.limit);
            const offset = parsePositiveInt('offset', options.offset);

            const http = getHttpClient();
            const spinner = ora('Loading KB documents...').start();

            const query = new URLSearchParams();
            if (options.class) query.append('class', String(options.class));
            if (options.tag) query.append('tag', String(options.tag));
            if (options.q) query.append('q', String(options.q));
            if (limit !== undefined) query.append('limit', String(limit));
            if (offset !== undefined) query.append('offset', String(offset));

            try {
                const qs = query.toString();
                const url = `/works/${encodeURIComponent(workId)}/kb/documents${qs ? `?${qs}` : ''}`;
                const { data } = await http.get<KbDocumentListResponse>(url);
                spinner.succeed(
                    `Found ${data.total} KB document(s) (showing ${data.items.length})`,
                );

                if (data.items.length === 0) {
                    console.log(chalk.yellow('\nNo KB documents match the supplied filters.'));
                    return;
                }

                // Compact table — keeps wide-terminal output readable
                // without pulling a table dep that the rest of the CLI
                // doesn't already use.
                const header = [
                    chalk.gray('ID'.padEnd(36)),
                    chalk.gray('Class'.padEnd(12)),
                    chalk.gray('Status'.padEnd(10)),
                    chalk.gray('Lock'.padEnd(5)),
                    chalk.gray('Path'.padEnd(40)),
                    chalk.gray('Title'),
                ].join('  ');
                console.log('\n' + header);
                console.log(chalk.gray('─'.repeat(120)));

                for (const row of data.items) {
                    const lockMark = row.locked ? chalk.yellow('LOCK') : chalk.gray('—');
                    console.log(
                        [
                            row.id.padEnd(36),
                            truncate(row.class, 12).padEnd(12),
                            truncate(row.status, 10).padEnd(10),
                            lockMark.padEnd(5),
                            chalk.cyan(truncate(row.path, 40).padEnd(40)),
                            chalk.white(truncate(row.title, 60)),
                        ].join('  '),
                    );
                    if (row.tags.length > 0) {
                        console.log(chalk.gray('    tags: ' + row.tags.join(', ')));
                    }
                }
                console.log(chalk.gray('─'.repeat(120)));
                console.log(
                    chalk.cyan(`Total: ${data.total}`) +
                        chalk.gray(` (limit=${limit ?? '∅'}, offset=${offset ?? 0})`),
                );
            } catch (error) {
                spinner.fail('Failed to load KB documents');
                throw error;
            }
        } catch (error) {
            handleCliError(error);
            process.exit(1);
        }
    });
