import { Command } from 'commander';
import chalk from 'chalk';
import type { FleetNodeHealthView, FleetNodeView, NeedsALookItem } from '@ever-works/contracts';
import { resolveFleetNodeId, runFleetVerb } from './fleet-client';
import { fleetTable, fleetUsage } from './fleet-output';

/**
 * `ever-works fleet nodes …` (FL-19, plan §9.3; alias `fleet node`) — my
 * computers: `list`, `get`, `health` (FL-03), `needs-a-look`. Every verb
 * takes `--json` (`{ ok, data }`, the web's own shapes). A computer is named
 * by id or by name (`--on build-01`). State-changing verbs (`wake`,
 * `git-identity --set`) are FL-19 P2.
 */

const KINDS = ['desktop-node', 'node', 'k8s'];
const STATUSES = ['enrolling', 'online', 'offline', 'disabled'];
const RANGES = ['1h', '24h', '7d', '90d'];

function nodeRows(nodes: FleetNodeView[]): string {
    const rows = [['ID', 'NAME', 'KIND', 'STATUS', 'PLATFORM', 'ROLE']];
    for (const node of nodes) {
        rows.push([
            node.id,
            node.name,
            node.kind,
            node.status === 'online' ? chalk.green(node.status) : node.status,
            node.platform ?? '—',
            node.viewerRole ?? 'owner',
        ]);
    }
    return fleetTable(rows);
}

const list = new Command('list')
    .description('List my computers (and those shared with me, unless --own)')
    .option('--own', 'Only computers I enrolled')
    .option('--kind <kind>', 'desktop-node | node | k8s')
    .option('--status <status>', 'enrolling | online | offline | disabled')
    .option('--json', 'Machine-readable output')
    .action(async (options: { own?: boolean; kind?: string; status?: string; json?: boolean }) => {
        const json = options.json === true;
        if (options.kind && !KINDS.includes(options.kind))
            fleetUsage(json, '--kind is desktop-node, node or k8s', 'kind');
        if (options.status && !STATUSES.includes(options.status)) {
            fleetUsage(json, '--status is enrolling, online, offline or disabled', 'status');
        }
        await runFleetVerb<FleetNodeView[]>(
            json,
            {
                method: 'GET',
                path: '/fleet/nodes',
                query: { scope: options.own ? 'own' : 'visible' },
            },
            (nodes) => {
                const shown = nodes.filter(
                    (node) =>
                        (!options.kind || node.kind === options.kind) &&
                        (!options.status || node.status === options.status),
                );
                console.log(shown.length === 0 ? chalk.yellow('No computers.') : nodeRows(shown));
            },
        );
    });

const get = new Command('get')
    .description('One computer: status, platform, consents, last health, my role')
    .requiredOption('--on <computer>', 'The computer (id or name)')
    .option('--json', 'Machine-readable output')
    .action(async (options: { on: string; json?: boolean }) => {
        const json = options.json === true;
        const nodeId = await resolveFleetNodeId(json, options.on);
        await runFleetVerb<{ node?: FleetNodeView } & Partial<FleetNodeView>>(
            json,
            { method: 'GET', path: `/fleet/nodes/${nodeId}` },
            (detail) => {
                const node = (detail.node ?? detail) as FleetNodeView;
                console.log(nodeRows([node]));
                if (node.consents) {
                    const on = Object.entries(node.consents)
                        .filter(([, value]) => value)
                        .map(([key]) => key);
                    console.log(chalk.gray(`consents: ${on.length > 0 ? on.join(', ') : 'none'}`));
                }
            },
        );
    });

const health = new Command('health')
    .description("A computer's health: CPU, memory, disk, load, state and its fix")
    .requiredOption('--on <computer>', 'The computer (id or name)')
    .option('--range <range>', 'Also its history: 1h | 24h | 7d | 90d')
    .option('--json', 'Machine-readable output')
    .action(async (options: { on: string; range?: string; json?: boolean }) => {
        const json = options.json === true;
        if (options.range && !RANGES.includes(options.range))
            fleetUsage(json, '--range is 1h, 24h, 7d or 90d', 'range');
        const nodeId = await resolveFleetNodeId(json, options.on);
        await runFleetVerb<FleetNodeHealthView>(
            json,
            {
                method: 'GET',
                path: options.range
                    ? `/fleet/nodes/${nodeId}/health/history`
                    : `/fleet/nodes/${nodeId}/health`,
                ...(options.range ? { query: { range: options.range } } : {}),
            },
            (view) => {
                const snapshot = (view as FleetNodeHealthView).snapshot;
                if (!snapshot) {
                    console.log(
                        chalk.yellow('This computer reports no health (an older node version).'),
                    );
                    return;
                }
                const line = [
                    `CPU ${snapshot.cpuPercent ?? '—'}%`,
                    `memory ${snapshot.memPercent ?? '—'}%`,
                    `disk ${snapshot.diskPercent ?? '—'}%`,
                    snapshot.loadAvg1 !== undefined ? `load ${snapshot.loadAvg1}` : null,
                ]
                    .filter(Boolean)
                    .join(' · ');
                console.log(
                    `${line}${(view as FleetNodeHealthView).stale ? chalk.gray(' (stale)') : ''}`,
                );
                console.log(chalk.gray(`read ${snapshot.at}`));
            },
        );
    });

const needsALook = new Command('needs-a-look')
    .description('What needs a look — on every computer, or one (--on)')
    .option('--on <computer>', 'Only this computer (id or name)')
    .option('--json', 'Machine-readable output')
    .action(async (options: { on?: string; json?: boolean }) => {
        const json = options.json === true;
        const nodeId = options.on ? await resolveFleetNodeId(json, options.on) : null;
        await runFleetVerb<NeedsALookItem[]>(
            json,
            {
                method: 'GET',
                path: nodeId ? `/fleet/nodes/${nodeId}/needs-a-look` : '/fleet/needs-a-look',
            },
            (items) => {
                if (items.length === 0) {
                    console.log(chalk.green('Nothing needs a look.'));
                    return;
                }
                for (const item of items) {
                    const mark =
                        item.severity === 'critical'
                            ? chalk.red('●')
                            : item.severity === 'warn'
                              ? chalk.yellow('●')
                              : chalk.gray('●');
                    console.log(`${mark} ${item.title} ${chalk.gray(item.detail)}`);
                }
            },
        );
    });

export const nodesCommand = new Command('nodes')
    .alias('node')
    .description('My computers: list, get, health, needs-a-look')
    .addCommand(list)
    .addCommand(get)
    .addCommand(health)
    .addCommand(needsALook);
