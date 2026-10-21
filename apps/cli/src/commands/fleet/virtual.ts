import { Command } from 'commander';
import chalk from 'chalk';
import {
    FLEET_VIRTUAL_SYSTEM_IDS,
    isFleetVirtualCpus,
    isFleetVirtualDiskGiB,
    isFleetVirtualMemoryGiB,
    isFleetVirtualName,
    isFleetVirtualSystemId,
    type FleetConfirmArgs,
    type FleetNodeView,
    type FleetVirtualOptionsView
} from '@ever-works/contracts';
import { fleetRequest, resolveFleetNodeId, runFleetVerb } from './fleet-client';
import { fleetConfirmFields, type FleetConfirmFlags } from './fleet-confirm';
import { emitFleetError, fleetTable, fleetUsage, readFleetCliError } from './fleet-output';

/**
 * Virtual computers from a shell (FL-16 P3, T-35, CONTRACTS §11.3) — the
 * `virtual` family over the same routes the web uses, with the names the
 * fleet tool catalogue gives them (`fleet virtual list|options|create|power|
 * destroy`) plus `start` / `stop` / `resize` / `rebuild`:
 *
 *   ever-works fleet virtual list [--on <host>]
 *   ever-works fleet virtual options [--system ubuntu-26.04]
 *   ever-works fleet virtual create <name> --system <id> [--on <host>] [--cpus 4] [--memory 8] [--disk 64] [--yes]
 *   ever-works fleet virtual start|stop <computer> [--yes]
 *   ever-works fleet virtual power <computer> <start|stop> [--yes]
 *   ever-works fleet virtual resize <computer> [--cpus n] [--memory n] [--yes]
 *   ever-works fleet virtual rebuild <computer> [--yes]
 *   ever-works fleet virtual destroy <computer> --confirm-name <name>
 *
 * `<computer>` is the virtual computer's id or name; its host is read off its
 * row. Every verb takes `--json` (`{ ok, data }`) and exits `0 / 1 / 2`; a
 * missing confirmation exits 2 with the summary (asked on a terminal).
 */

type Flags = FleetConfirmFlags & { json?: boolean; on?: string };

function confirmOf(flags: Flags): FleetConfirmArgs {
    return fleetConfirmFields({ yes: flags.yes, confirmName: flags.confirmName });
}

function withConfirm(command: Command, destructive = false): Command {
    command.option('--yes', 'Confirm (class confirm)').option('--json', 'Machine-readable output');
    if (destructive) command.option('--confirm-name <name>', "Type the virtual computer's exact name (class confirm-destructive)");
    return command;
}

function accepted(label: string): (data: unknown) => void {
    return (data) => {
        const value = (data ?? {}) as { operationId?: string; childNodeId?: string };
        const id = value.childNodeId ? ` (${value.childNodeId})` : '';
        console.log(chalk.green(`✓ ${label}${id}`));
        if (value.operationId) console.log(chalk.gray(`Running as job ${value.operationId}; watch it with: ever-works fleet virtual list`));
    };
}

/** The child's id and its host's, from the child's own row. */
async function resolveChild(json: boolean, ref: string): Promise<{ childId: string; hostId: string; name: string }> {
    const childId = await resolveFleetNodeId(json, ref);
    let node: FleetNodeView;
    try {
        node = await fleetRequest<FleetNodeView>({ method: 'GET', path: `/fleet/nodes/${childId}` });
    } catch (error) {
        return emitFleetError(json, readFleetCliError(error));
    }
    if (!node?.hostNodeId) {
        return emitFleetError(json, {
            code: 'unsupported_on_node',
            hint: `${node?.name ?? ref} is not a virtual computer`,
            details: { field: 'computer' }
        });
    }
    return { childId, hostId: node.hostNodeId, name: node.name };
}

const list = new Command('list')
    .description('The virtual computers on one host, or on every host you may see')
    .option('--on <host>', 'Only this host (id or name)')
    .option('--json', 'Machine-readable output')
    .action(async (flags: Flags) => {
        const json = flags.json === true;
        const path = flags.on ? `/fleet/nodes/${await resolveFleetNodeId(json, flags.on)}/virtual` : '/fleet/virtual';
        await runFleetVerb<unknown>(json, { method: 'GET', path }, (data) => {
            const hosts = flags.on
                ? [data as { host: { name: string }; children: FleetNodeView[] }]
                : ((data as { hosts?: Array<{ host: { name: string }; children: FleetNodeView[] }> }).hosts ?? []);
            const rows = [['ID', 'NAME', 'HOST', 'KIND', 'SYSTEM', 'SIZE', 'STATE']];
            for (const host of hosts) {
                for (const child of host.children ?? []) {
                    const v = child.virtual;
                    rows.push([
                        child.id,
                        child.name,
                        host.host?.name ?? '—',
                        child.virtualKind === 'vm' ? 'VM' : 'Container',
                        v?.systemLabel ?? '—',
                        v ? `${v.cpus} CPU · ${v.memoryGiB} GB${v.diskGiB ? ` · ${v.diskGiB} GB disk` : ''}` : '—',
                        v?.state ?? child.status
                    ]);
                }
            }
            console.log(rows.length === 1 ? chalk.yellow('No virtual computers.') : fleetTable(rows));
        });
    });

const options = new Command('options')
    .description('Which computers can host a new virtual computer of a system, and why the others cannot')
    .option('--system <id>', `One of ${FLEET_VIRTUAL_SYSTEM_IDS.join(', ')}`)
    .option('--json', 'Machine-readable output')
    .action(async (flags: Flags & { system?: string }) => {
        const json = flags.json === true;
        if (flags.system && !isFleetVirtualSystemId(flags.system)) fleetUsage(json, '--system is not a listed system', 'system');
        await runFleetVerb<FleetVirtualOptionsView>(
            json,
            { method: 'GET', path: '/fleet/nodes/auto/virtual/options', query: flags.system ? { system: flags.system } : {} },
            (data) => {
                const rows = [['HOST', 'FREE MEMORY', 'FREE DISK', 'KVM', 'CHILDREN', 'CAN HOST']];
                for (const host of data.hosts) {
                    rows.push([
                        host.name + (host.nodeId === data.autoPickNodeId ? ' (Choose for me)' : ''),
                        host.freeMemoryMiB === null ? '—' : `${Math.round(host.freeMemoryMiB / 1024)} GB`,
                        host.freeDiskMiB === null ? '—' : `${Math.round(host.freeDiskMiB / 1024)} GB`,
                        host.kvm ? 'yes' : 'no',
                        String(host.childCount),
                        host.eligible ? chalk.green('yes') : chalk.gray(host.reason ?? 'no')
                    ]);
                }
                console.log(fleetTable(rows));
            }
        );
    });

const create = withConfirm(
    new Command('create')
        .description('Create a virtual computer on a host (or the host with the most free memory)')
        .argument('<name>', '2–39 lower-case letters, digits and hyphens')
        .requiredOption('--system <id>', `One of ${FLEET_VIRTUAL_SYSTEM_IDS.join(', ')}`)
        .option('--on <host>', 'The host (id or name); omitted = Choose for me')
        .option('--cpus <n>', '2, 4 or 8 (default 4)')
        .option('--memory <gb>', '4, 8 or 16 (default 8)')
        .option('--disk <gb>', 'Windows VMs only: 64, 128 or 256 (default 64)')
).action(async (name: string, flags: Flags & { system: string; cpus?: string; memory?: string; disk?: string }) => {
    const json = flags.json === true;
    if (!isFleetVirtualName(name)) fleetUsage(json, '<name> is 2–39 lower-case letters, digits and hyphens', 'name');
    if (!isFleetVirtualSystemId(flags.system)) fleetUsage(json, '--system is not a listed system', 'system');
    const cpus = flags.cpus === undefined ? undefined : Number(flags.cpus);
    const memoryGiB = flags.memory === undefined ? undefined : Number(flags.memory);
    const diskGiB = flags.disk === undefined ? undefined : Number(flags.disk);
    if (cpus !== undefined && !isFleetVirtualCpus(cpus)) fleetUsage(json, '--cpus is 2, 4 or 8', 'cpus');
    if (memoryGiB !== undefined && !isFleetVirtualMemoryGiB(memoryGiB)) fleetUsage(json, '--memory is 4, 8 or 16', 'memory');
    if (diskGiB !== undefined && !isFleetVirtualDiskGiB(diskGiB)) fleetUsage(json, '--disk is 64, 128 or 256', 'disk');
    const host = flags.on ? await resolveFleetNodeId(json, flags.on) : 'auto';
    await runFleetVerb(
        json,
        {
            method: 'POST',
            path: `/fleet/nodes/${host}/virtual`,
            body: {
                name,
                systemId: flags.system,
                ...(cpus !== undefined ? { cpus } : {}),
                ...(memoryGiB !== undefined ? { memoryGiB } : {}),
                ...(diskGiB !== undefined ? { diskGiB } : {})
            }
        },
        accepted(`creating ${name}`),
        confirmOf(flags)
    );
});

function powerCommand(action: 'start' | 'stop'): Command {
    return withConfirm(
        new Command(action)
            .description(action === 'start' ? 'Start a virtual computer' : 'Stop a virtual computer (asks first)')
            .argument('<computer>', 'The virtual computer (id or name)')
    ).action(async (ref: string, flags: Flags) => {
        const json = flags.json === true;
        const { childId, hostId, name } = await resolveChild(json, ref);
        await runFleetVerb(
            json,
            { method: 'POST', path: `/fleet/nodes/${hostId}/virtual/${childId}/power`, body: { action } },
            accepted(`${action === 'start' ? 'starting' : 'stopping'} ${name}`),
            confirmOf(flags)
        );
    });
}

const power = withConfirm(
    new Command('power')
        .description('Start or stop a virtual computer')
        .argument('<computer>', 'The virtual computer (id or name)')
        .argument('<action>', 'start | stop')
).action(async (ref: string, action: string, flags: Flags) => {
    const json = flags.json === true;
    if (action !== 'start' && action !== 'stop') fleetUsage(json, '<action> is start or stop', 'action');
    const { childId, hostId, name } = await resolveChild(json, ref);
    await runFleetVerb(
        json,
        { method: 'POST', path: `/fleet/nodes/${hostId}/virtual/${childId}/power`, body: { action } },
        accepted(`${action} ${name}`),
        confirmOf(flags)
    );
});

const resize = withConfirm(
    new Command('resize')
        .description('Change a stopped virtual computer’s CPUs and memory')
        .argument('<computer>', 'The virtual computer (id or name)')
        .option('--cpus <n>', '2, 4 or 8')
        .option('--memory <gb>', '4, 8 or 16')
).action(async (ref: string, flags: Flags & { cpus?: string; memory?: string }) => {
    const json = flags.json === true;
    const cpus = flags.cpus === undefined ? undefined : Number(flags.cpus);
    const memoryGiB = flags.memory === undefined ? undefined : Number(flags.memory);
    if (cpus === undefined && memoryGiB === undefined) fleetUsage(json, 'give --cpus, --memory or both', 'cpus');
    if (cpus !== undefined && !isFleetVirtualCpus(cpus)) fleetUsage(json, '--cpus is 2, 4 or 8', 'cpus');
    if (memoryGiB !== undefined && !isFleetVirtualMemoryGiB(memoryGiB)) fleetUsage(json, '--memory is 4, 8 or 16', 'memory');
    const { childId, hostId, name } = await resolveChild(json, ref);
    await runFleetVerb(
        json,
        {
            method: 'PATCH',
            path: `/fleet/nodes/${hostId}/virtual/${childId}`,
            body: { ...(cpus !== undefined ? { cpus } : {}), ...(memoryGiB !== undefined ? { memoryGiB } : {}) }
        },
        accepted(`resizing ${name}`),
        confirmOf(flags)
    );
});

const rebuild = withConfirm(
    new Command('rebuild')
        .description('Re-create a Container from the current image, keeping its home and registration')
        .argument('<computer>', 'The virtual computer (id or name)')
).action(async (ref: string, flags: Flags) => {
    const json = flags.json === true;
    const { childId, hostId, name } = await resolveChild(json, ref);
    await runFleetVerb(
        json,
        { method: 'POST', path: `/fleet/nodes/${hostId}/virtual/${childId}/rebuild` },
        accepted(`rebuilding ${name}`),
        confirmOf(flags)
    );
});

const destroy = withConfirm(
    new Command('destroy')
        .description('Destroy a virtual computer: its machine and disk on the host, then its registration (job history is kept)')
        .argument('<computer>', 'The virtual computer (id or name)'),
    true
).action(async (ref: string, flags: Flags) => {
    const json = flags.json === true;
    const { childId, hostId, name } = await resolveChild(json, ref);
    await runFleetVerb(
        json,
        { method: 'POST', path: `/fleet/nodes/${hostId}/virtual/${childId}/destroy` },
        accepted(`destroying ${name}`),
        confirmOf(flags)
    );
});

export const virtualCommand = new Command('virtual')
    .description('Virtual computers on your computers: list, options, create, start, stop, power, resize, rebuild, destroy')
    .addCommand(list)
    .addCommand(options)
    .addCommand(create)
    .addCommand(powerCommand('start'))
    .addCommand(powerCommand('stop'))
    .addCommand(power)
    .addCommand(resize)
    .addCommand(rebuild)
    .addCommand(destroy);
