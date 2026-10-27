import { Command } from 'commander';
import chalk from 'chalk';
import type { FleetConfirmArgs } from '@ever-works/contracts';
import { resolveFleetNodeId, runFleetVerb } from './fleet-client';
import { fleetConfirmFields, type FleetConfirmFlags } from './fleet-confirm';
import { FLEET_CLI_UUID, fleetUsage } from './fleet-output';

/**
 * The state-changing `ever-works fleet …` verbs (FL-19 P2, T-16, spec FR-19 –
 * FR-21) — the same routes, confirmation classes and refusals as the hub and
 * the Agent tools. Every act takes the CONTRACTS §2.2 fields as flags:
 *
 *   --yes                 confirm: true                (class `confirm`; asked on a TTY otherwise)
 *   --confirm-name <n>    confirmName                  (class `confirm-destructive`, never asked)
 *   --ack-blast-radius    acknowledgeBlastRadius: true (with --yes, class `blast-radius`)
 *   --no-wait             wait: false                  (answer with the operation id)
 *
 * Without them a confirming verb exits 2 with the summary on stderr (spec U10).
 *
 *   fleet services action <service> <start|stop|restart|enable|disable> --on <computer>
 *   fleet processes signal <pid> <TERM|KILL|…> --on <computer>
 *   fleet docker container <container> <action> --on <computer>
 *   fleet docker pull <ref> --on <computer>
 *   fleet docker image-remove <image> --on <computer>
 *   fleet docker prune --on <computer>
 *   fleet docker compose-action <project> <up|down|restart|…> --on <computer>
 *   fleet ports open <port> --on <computer> [--target desktop|preview-profile]
 *   fleet ports preview-close <port> --on <computer>
 *   fleet sessions end <id> · fleet sessions rename <id> <title>
 *   fleet nodes wake --on <computer>   (git identity: FL-15's `fleet nodes git-identity`)
 *   fleet commands cancel <id> · fleet operations cancel <id>
 */

type ActFlags = FleetConfirmFlags & { on?: string; json?: boolean };

function withConfirmFlags(command: Command, destructive = false): Command {
    command
        .option('--yes', 'Confirm (class confirm)')
        .option(
            '--ack-blast-radius',
            'Acknowledge the warning that the act could cut the computer off (with --yes)',
        )
        .option('--no-wait', 'Answer with the operation id instead of waiting')
        .option('--json', 'Machine-readable output');
    if (destructive)
        command.option(
            '--confirm-name <name>',
            "Type the target's exact name (class confirm-destructive)",
        );
    return command;
}

function done(label: string): (data: unknown) => void {
    return (data) => {
        const operationId =
            data &&
            typeof data === 'object' &&
            typeof (data as { operationId?: unknown }).operationId === 'string'
                ? (data as { operationId: string }).operationId
                : null;
        if (operationId) {
            console.log(chalk.cyan(`${label} — running as operation ${operationId}`));
            console.log(
                chalk.gray(`Follow it with: ever-works fleet operations get ${operationId}`),
            );
            return;
        }
        const held =
            data && typeof data === 'object' && (data as { held?: unknown }).held === true
                ? ((data as { hint?: string }).hint ?? 'held for the owner in My Decisions')
                : null;
        console.log(held ? chalk.yellow(`${label} — ${held}`) : chalk.green(`✓ ${label}`));
    };
}

function confirmOf(flags: ActFlags): FleetConfirmArgs {
    return fleetConfirmFields({
        yes: flags.yes,
        confirmName: flags.confirmName,
        ackBlastRadius: flags.ackBlastRadius,
        wait: flags.wait,
    });
}

// ── services / processes ──

export const servicesActionCommand = withConfirmFlags(
    new Command('action')
        .description('Start, stop, restart, enable or disable one service')
        .argument('<service>', 'The service name as `fleet services list` shows it')
        .argument('<action>', 'start | stop | restart | enable | disable')
        .requiredOption('--on <computer>', 'The computer (id or name)')
        .option('--scope <scope>', 'system (default) | user')
        .option('--manager <manager>', 'macOS only: launchd (default) | brew'),
).action(
    async (
        service: string,
        action: string,
        flags: ActFlags & { scope?: string; manager?: string },
    ) => {
        const json = flags.json === true;
        if (!['start', 'stop', 'restart', 'enable', 'disable'].includes(action)) {
            fleetUsage(json, '<action> is start, stop, restart, enable or disable', 'action');
        }
        const nodeId = await resolveFleetNodeId(json, flags.on);
        await runFleetVerb(
            json,
            {
                method: 'POST',
                path: `/fleet/nodes/${nodeId}/services/${encodeURIComponent(service)}/${action}`,
                body: {
                    ...(flags.scope ? { scope: flags.scope } : {}),
                    ...(flags.manager ? { manager: flags.manager } : {}),
                },
            },
            done(`${action} ${service}`),
            confirmOf(flags),
        );
    },
);

export const processesSignalCommand = withConfirmFlags(
    new Command('signal')
        .description(
            'Send a signal to one process (TERM asks it to stop; KILL is held for an Agent)',
        )
        .argument('<pid>', 'The process id')
        .argument('[signal]', 'TERM (default) | KILL | HUP | INT | …', 'TERM')
        .requiredOption('--on <computer>', 'The computer (id or name)'),
).action(async (pid: string, signal: string, flags: ActFlags) => {
    const json = flags.json === true;
    const value = Number(pid);
    if (!Number.isInteger(value) || value <= 0)
        fleetUsage(json, '<pid> must be a process id', 'pid');
    const nodeId = await resolveFleetNodeId(json, flags.on);
    await runFleetVerb(
        json,
        {
            method: 'POST',
            path: `/fleet/nodes/${nodeId}/processes/${value}/signal`,
            body: { signal },
        },
        done(`${signal} → ${value}`),
        confirmOf(flags),
    );
});

// ── docker ──

export const dockerContainerCommand = withConfirmFlags(
    new Command('container')
        .description('Start, stop, restart, pause, unpause or remove one container')
        .argument('<container>', 'Container id or name')
        .argument('<action>', 'start | stop | restart | pause | unpause | remove')
        .requiredOption('--on <computer>', 'The computer (id or name)'),
    true,
).action(async (container: string, action: string, flags: ActFlags) => {
    const json = flags.json === true;
    const nodeId = await resolveFleetNodeId(json, flags.on);
    await runFleetVerb(
        json,
        {
            method: 'POST',
            path: `/fleet/nodes/${nodeId}/docker/containers/${encodeURIComponent(container)}/${encodeURIComponent(action)}`,
        },
        done(`${action} ${container}`),
        confirmOf(flags),
    );
});

export const dockerPullCommand = withConfirmFlags(
    new Command('pull')
        .description('Pull an image')
        .argument('<ref>', 'Image reference, e.g. nginx:1.27')
        .requiredOption('--on <computer>', 'The computer (id or name)'),
).action(async (ref: string, flags: ActFlags) => {
    const json = flags.json === true;
    const nodeId = await resolveFleetNodeId(json, flags.on);
    await runFleetVerb(
        json,
        { method: 'POST', path: `/fleet/nodes/${nodeId}/docker/images`, body: { ref } },
        done(`pull ${ref}`),
        confirmOf(flags),
    );
});

export const dockerImageRemoveCommand = withConfirmFlags(
    new Command('image-remove')
        .description('Remove an image')
        .argument('<image>', 'Image id')
        .requiredOption('--on <computer>', 'The computer (id or name)'),
).action(async (image: string, flags: ActFlags) => {
    const json = flags.json === true;
    const nodeId = await resolveFleetNodeId(json, flags.on);
    await runFleetVerb(
        json,
        {
            method: 'POST',
            path: `/fleet/nodes/${nodeId}/docker/images/${encodeURIComponent(image)}/remove`,
        },
        done(`remove ${image}`),
        confirmOf(flags),
    );
});

export const dockerPruneCommand = withConfirmFlags(
    new Command('prune')
        .description('Remove dangling images (all unused with --unused)')
        .requiredOption('--on <computer>', 'The computer (id or name)')
        .option('--unused', 'Every image no container uses, not only dangling ones'),
).action(async (flags: ActFlags & { unused?: boolean }) => {
    const json = flags.json === true;
    const nodeId = await resolveFleetNodeId(json, flags.on);
    await runFleetVerb(
        json,
        {
            method: 'DELETE',
            path: `/fleet/nodes/${nodeId}/docker/images`,
            query: flags.unused ? { unused: 'true' } : undefined,
            body: {},
        },
        done('prune images'),
        confirmOf(flags),
    );
});

export const dockerComposeActionCommand = withConfirmFlags(
    new Command('compose-action')
        .description('Run up, down, restart, stop, start or pull on a Compose project')
        .argument('<project>', 'The Compose project')
        .argument('<action>', 'up | down | restart | stop | start | pull')
        .requiredOption('--on <computer>', 'The computer (id or name)')
        .option('--service <service>', 'Only one service of the project'),
).action(async (project: string, action: string, flags: ActFlags & { service?: string }) => {
    const json = flags.json === true;
    const nodeId = await resolveFleetNodeId(json, flags.on);
    await runFleetVerb(
        json,
        {
            method: 'POST',
            path: `/fleet/nodes/${nodeId}/docker/compose/${encodeURIComponent(project)}/${encodeURIComponent(action)}`,
            body: flags.service ? { service: flags.service } : {},
        },
        done(`${action} ${project}`),
        confirmOf(flags),
    );
});

// ── ports ──

export const portsOpenCommand = withConfirmFlags(
    new Command('open')
        .description(
            "Open a computer's web server ON that machine (its desktop or its preview browser)",
        )
        .argument('<port>', 'The port')
        .requiredOption('--on <computer>', 'The computer (id or name)')
        .option('--target <target>', 'desktop | preview-profile'),
).action(async (port: string, flags: ActFlags & { target?: string }) => {
    const json = flags.json === true;
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1 || value > 65535)
        fleetUsage(json, '<port> is 1–65535', 'port');
    const nodeId = await resolveFleetNodeId(json, flags.on);
    await runFleetVerb(
        json,
        {
            method: 'POST',
            path: `/fleet/nodes/${nodeId}/ports/${value}/open`,
            body: flags.target ? { target: flags.target } : {},
        },
        done(`open port ${value}`),
        confirmOf(flags),
    );
});

export const portsPreviewCloseCommand = withConfirmFlags(
    new Command('preview-close')
        .description('Close my preview tunnel to a port')
        .argument('<port>', 'The port')
        .requiredOption('--on <computer>', 'The computer (id or name)'),
).action(async (port: string, flags: ActFlags) => {
    const json = flags.json === true;
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1 || value > 65535)
        fleetUsage(json, '<port> is 1–65535', 'port');
    const nodeId = await resolveFleetNodeId(json, flags.on);
    await runFleetVerb(
        json,
        { method: 'DELETE', path: `/fleet/nodes/${nodeId}/ports/${value}/preview` },
        done(`close the preview of port ${value}`),
        confirmOf(flags),
    );
});

// ── sessions ──

export const sessionsEndCommand = withConfirmFlags(
    new Command('end')
        .description('End a session (stops its process)')
        .argument('<id>', 'Session id'),
).action(async (id: string, flags: ActFlags) => {
    const json = flags.json === true;
    if (!FLEET_CLI_UUID.test(id)) fleetUsage(json, '<id> must be a session id', 'id');
    await runFleetVerb(
        json,
        { method: 'POST', path: `/fleet/sessions/${id}/end` },
        done('session ended'),
        confirmOf(flags),
    );
});

export const sessionsRenameCommand = new Command('rename')
    .description('Rename a session')
    .argument('<id>', 'Session id')
    .argument('<title>', 'The new title')
    .option('--json', 'Machine-readable output')
    .action(async (id: string, title: string, flags: { json?: boolean }) => {
        const json = flags.json === true;
        if (!FLEET_CLI_UUID.test(id)) fleetUsage(json, '<id> must be a session id', 'id');
        if (title.trim().length === 0) fleetUsage(json, '<title> must not be empty', 'title');
        await runFleetVerb(
            json,
            { method: 'PATCH', path: `/fleet/sessions/${id}`, body: { title } },
            done('renamed'),
        );
    });

// ── nodes ──

export const nodesWakeCommand = new Command('wake')
    .description('Wake an offline computer through another of mine on its network (Wake-on-LAN)')
    .requiredOption('--on <computer>', 'The computer to wake (id or name)')
    .option('--json', 'Machine-readable output')
    .action(async (flags: { on: string; json?: boolean }) => {
        const json = flags.json === true;
        const nodeId = await resolveFleetNodeId(json, flags.on);
        await runFleetVerb(
            json,
            { method: 'POST', path: `/fleet/nodes/${nodeId}/wake` },
            (data) => {
                const via = (data as { via?: { name?: string } } | null)?.via?.name;
                console.log(chalk.green(`✓ wake sent${via ? ` through ${via}` : ''}`));
                console.log(
                    chalk.gray(
                        'Check in 20–60 seconds: ever-works fleet nodes health --on <computer>',
                    ),
                );
            },
        );
    });

// ── commands / operations ──

export const commandsCancelCommand = new Command('cancel')
    .description('Stop a running command on every computer it still runs on')
    .argument('<id>', 'Command id')
    .option('--json', 'Machine-readable output')
    .action(async (id: string, flags: { json?: boolean }) => {
        const json = flags.json === true;
        if (!FLEET_CLI_UUID.test(id)) fleetUsage(json, '<id> must be a command id', 'id');
        await runFleetVerb(
            json,
            { method: 'POST', path: `/fleet/commands/${id}/cancel` },
            done('cancel sent'),
        );
    });

export const operationsCancelCommand = new Command('cancel')
    .description('Ask the computer to stop a running operation')
    .argument('<id>', 'Operation id')
    .option('--json', 'Machine-readable output')
    .action(async (id: string, flags: { json?: boolean }) => {
        const json = flags.json === true;
        if (!id || id.length > 100)
            fleetUsage(json, '<id> is the operation id a verb answered with', 'id');
        await runFleetVerb(
            json,
            { method: 'DELETE', path: `/fleet/operations/${encodeURIComponent(id)}` },
            (data) => {
                const sent = (data as { sent?: boolean } | null)?.sent;
                console.log(
                    sent === false
                        ? chalk.gray('It had already ended.')
                        : chalk.green('✓ cancel sent'),
                );
            },
        );
    });
