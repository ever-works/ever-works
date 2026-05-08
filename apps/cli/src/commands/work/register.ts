import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { handleCliError } from '../../utils/error';

const DEFAULT_API_URL = process.env.EVER_WORKS_API_URL || 'https://api.ever.works';

interface RegisterOptions {
    repo: string;
    githubToken?: string;
    email?: string;
    agentId?: string;
    webhookUrl?: string;
    subdomain?: string;
    idempotencyKey?: string;
    apiUrl?: string;
}

export const registerCommand = new Command('register')
    .description(
        'Zero-friction registration: creates an Ever Works account if needed and queues a Work from your GitHub repo manifest (.works/works.yml).',
    )
    .requiredOption('--repo <url>', 'HTTPS GitHub repo URL with .works/works.yml at root')
    .option('--github-token <token>', 'GitHub PAT (defaults to $GITHUB_TOKEN)')
    .option('--email <email>', 'Optional contact email')
    .option('--agent-id <id>', 'Optional opaque agent identifier')
    .option('--webhook-url <url>', 'HTTPS URL for signed terminal-status webhooks')
    .option('--subdomain <slug>', 'DNS-safe slug for the assigned subdomain')
    .option('--idempotency-key <key>', 'Optional idempotency key for safe retry')
    .option('--api-url <url>', 'Override the Ever Works API base URL', DEFAULT_API_URL)
    .action(async (options: RegisterOptions) => {
        const githubToken = options.githubToken || process.env.GITHUB_TOKEN;
        if (!githubToken) {
            console.error(
                chalk.red('A GitHub token is required. Pass --github-token or set $GITHUB_TOKEN.'),
            );
            process.exit(2);
        }

        const apiUrl = (options.apiUrl || DEFAULT_API_URL).replace(/\/$/, '');
        const spinner = ora(`Registering ${options.repo} with ${apiUrl}…`).start();

        try {
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'X-GitHub-Token': githubToken,
            };
            if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

            const body = JSON.stringify({
                repo: options.repo,
                email: options.email,
                agentId: options.agentId,
                webhookUrl: options.webhookUrl,
                subdomain: options.subdomain,
            });

            const response = await fetch(`${apiUrl}/api/register-work`, {
                method: 'POST',
                headers,
                body,
            });
            const text = await response.text();
            let parsed: any = {};
            try {
                parsed = text ? JSON.parse(text) : {};
            } catch {
                parsed = { raw: text };
            }

            if (response.status >= 200 && response.status < 300) {
                spinner.succeed(chalk.green('Onboarding accepted'));
                console.log();
                console.log(`  ${chalk.bold('Onboarding ID')}  ${parsed.onboardingId ?? '—'}`);
                console.log(`  ${chalk.bold('Work ID')}        ${parsed.workId ?? '—'}`);
                console.log(`  ${chalk.bold('Status')}         ${parsed.status ?? '—'}`);
                console.log(`  ${chalk.bold('Subdomain')}      ${parsed.subdomain ?? '—'}`);
                console.log(`  ${chalk.bold('Status URL')}     ${parsed.statusUrl ?? '—'}`);
                if (Array.isArray(parsed.warnings) && parsed.warnings.length) {
                    console.log();
                    console.log(chalk.yellow('Warnings:'));
                    for (const w of parsed.warnings) console.log(`  • ${w}`);
                }
                process.exit(0);
            }

            spinner.fail(chalk.red(`Onboarding rejected (HTTP ${response.status})`));
            console.error();
            console.error(chalk.red(`  Code:    ${parsed.code ?? 'unknown'}`));
            console.error(chalk.red(`  Message: ${parsed.message ?? text}`));
            if (Array.isArray(parsed.errors)) {
                console.error();
                console.error(chalk.red('  Field errors:'));
                for (const e of parsed.errors) {
                    console.error(`    • ${e.path}: ${e.message}`);
                }
            }
            process.exit(1);
        } catch (err) {
            spinner.fail('Network error');
            handleCliError(err);
        }
    });
