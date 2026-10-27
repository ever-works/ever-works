import { Command } from 'commander';
import chalk from 'chalk';
import { FLEET_LOGS_INITIAL_LINES } from '@ever-works/contracts';
import { resolveFleetNodeId, runFleetVerb } from './fleet-client';
import { fleetUsage, printFleetList } from './fleet-output';

/**
 * What runs on a computer, from a shell (FL-19 T-10, plan §9.3) — the read
 * verbs of the machine families, over the same routes the computer page reads:
 *
 *   ever-works fleet logs sources --on <computer>
 *   ever-works fleet logs read --on <computer> --source <id> [--lines n] [--filter text]
 *   ever-works fleet services list --on <computer>
 *   ever-works fleet processes list --on <computer>
 *   ever-works fleet docker containers|images|compose --on <computer>
 *   ever-works fleet ports list --on <computer>
 *
 * Every verb takes `--json` (`{ ok, data }`, the web's own shapes) and exits
 * `0 / 1 / 2`. The state-changing verbs (service and container actions,
 * signals, pulls, Open on the machine, previews) are FL-19 P2, through the same
 * `--yes` / `--confirm-name` confirmation as every other act.
 */

type JsonOption = { on: string; json?: boolean };

function nodeRead(
    name: string,
    description: string,
    path: (nodeId: string) => string,
    columns: ReadonlyArray<{ key: string; label: string }>,
    empty: string,
): Command {
    return new Command(name)
        .description(description)
        .requiredOption('--on <computer>', 'The computer (id or name)')
        .option('--json', 'Machine-readable output')
        .action(async (options: JsonOption) => {
            const json = options.json === true;
            const nodeId = await resolveFleetNodeId(json, options.on);
            await runFleetVerb<unknown>(json, { method: 'GET', path: path(nodeId) }, (data) =>
                printFleetList(data, columns, empty),
            );
        });
}

// ── logs (FL-08) ──

const logsRead = new Command('read')
    .description(
        `Read the newest lines (at most ${FLEET_LOGS_INITIAL_LINES}) of one log source, secret-scanned on the machine`,
    )
    .requiredOption('--on <computer>', 'The computer (id or name)')
    .requiredOption(
        '--source <id>',
        'A source id from `fleet logs sources` (e.g. service:nginx.service)',
    )
    .option('--lines <n>', `How many of the newest lines (1–${FLEET_LOGS_INITIAL_LINES})`)
    .option('--filter <text>', 'Keep only lines containing this text')
    .option('--json', 'Machine-readable output')
    .action(async (options: JsonOption & { source: string; lines?: string; filter?: string }) => {
        const json = options.json === true;
        const lines = options.lines === undefined ? undefined : Number(options.lines);
        if (
            lines !== undefined &&
            (!Number.isInteger(lines) || lines < 1 || lines > FLEET_LOGS_INITIAL_LINES)
        ) {
            fleetUsage(json, `--lines is 1–${FLEET_LOGS_INITIAL_LINES}`, 'lines');
        }
        const nodeId = await resolveFleetNodeId(json, options.on);
        await runFleetVerb<{ lines?: Array<string | { text?: string }> }>(
            json,
            {
                method: 'POST',
                path: `/fleet/nodes/${nodeId}/logs/read`,
                body: {
                    source: options.source,
                    ...(lines !== undefined ? { lines } : {}),
                    ...(options.filter ? { filter: options.filter } : {}),
                },
            },
            (result) => {
                const out = result.lines ?? [];
                if (out.length === 0) console.log(chalk.yellow('No lines.'));
                for (const line of out)
                    console.log(typeof line === 'string' ? line : (line.text ?? ''));
            },
        );
    });

export const logsCommand = new Command('logs')
    .alias('log')
    .description('Logs on a computer: sources, read')
    .addCommand(
        nodeRead(
            'sources',
            'The log sources of a computer: System, Files, Containers, Services',
            (id) => `/fleet/nodes/${id}/logs/sources`,
            [
                { key: 'id', label: 'SOURCE' },
                { key: 'label', label: 'NAME' },
                { key: 'group', label: 'GROUP' },
            ],
            'No log sources.',
        ),
    )
    .addCommand(logsRead);

// ── services, processes (FL-09) ──

export const servicesCommand = new Command('services')
    .alias('service')
    .description('Services on a computer: list')
    .addCommand(
        nodeRead(
            'list',
            'The services on a computer, failed first',
            (id) => `/fleet/nodes/${id}/services`,
            [
                { key: 'name', label: 'SERVICE' },
                { key: 'state', label: 'STATE' },
                { key: 'manager', label: 'MANAGER' },
                { key: 'scope', label: 'SCOPE' },
            ],
            'No services.',
        ),
    );

export const processesCommand = new Command('processes')
    .alias('process')
    .description('Processes on a computer: list')
    .addCommand(
        nodeRead(
            'list',
            'The processes on a computer, busiest first',
            (id) => `/fleet/nodes/${id}/processes`,
            [
                { key: 'pid', label: 'PID' },
                { key: 'name', label: 'NAME' },
                { key: 'user', label: 'USER' },
                { key: 'cpuPercent', label: 'CPU%' },
                { key: 'memPercent', label: 'MEM%' },
            ],
            'No processes.',
        ),
    );

// ── docker (FL-09) ──

export const dockerCommand = new Command('docker')
    .description('Docker on a computer: containers, images, compose')
    .addCommand(
        nodeRead(
            'containers',
            'Docker containers on a computer',
            (id) => `/fleet/nodes/${id}/docker/containers`,
            [
                { key: 'id', label: 'ID' },
                { key: 'name', label: 'NAME' },
                { key: 'image', label: 'IMAGE' },
                { key: 'state', label: 'STATE' },
                { key: 'status', label: 'STATUS' },
            ],
            'No containers.',
        ),
    )
    .addCommand(
        nodeRead(
            'images',
            'Docker images on a computer',
            (id) => `/fleet/nodes/${id}/docker/images`,
            [
                { key: 'id', label: 'ID' },
                { key: 'repository', label: 'REPOSITORY' },
                { key: 'tag', label: 'TAG' },
                { key: 'size', label: 'SIZE' },
            ],
            'No images.',
        ),
    )
    .addCommand(
        nodeRead(
            'compose',
            'Docker Compose projects on a computer',
            (id) => `/fleet/nodes/${id}/docker/compose`,
            [
                { key: 'name', label: 'PROJECT' },
                { key: 'status', label: 'STATUS' },
                { key: 'configFiles', label: 'FILES' },
            ],
            'No Compose projects.',
        ),
    );

// ── ports (FL-10) ──

export const portsCommand = new Command('ports')
    .alias('port')
    .description('Ports and web servers on a computer: list')
    .addCommand(
        nodeRead(
            'list',
            'The TCP ports a computer listens on, web servers first',
            (id) => `/fleet/nodes/${id}/ports`,
            [
                { key: 'port', label: 'PORT' },
                { key: 'title', label: 'TITLE' },
                { key: 'process', label: 'PROGRAM' },
                { key: 'bind', label: 'BIND' },
            ],
            'Nothing is listening.',
        ),
    );
