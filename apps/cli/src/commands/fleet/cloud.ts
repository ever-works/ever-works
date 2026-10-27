import { Command } from 'commander';
import chalk from 'chalk';
import {
    FLEET_CLOUD_IDLE_MAX_HOURS,
    FLEET_CLOUD_IDLE_MIN_HOURS,
    FLEET_CLOUD_IDLE_POLICY_MODES,
    FLEET_CLOUD_SOFTWARE_IDS,
    formatFleetCloudMoney,
    isFleetCloudIdlePolicyMode,
    isFleetCloudName,
    isFleetCloudSoftwareId,
    type FleetCloudCreateResponse,
    type FleetCloudListView,
    type FleetCloudOperationResponse,
    type FleetCloudOptionsView,
    type FleetCloudProvidersView,
    type FleetCloudUsageView,
    type FleetConfirmArgs,
    type FleetNodeView,
} from '@ever-works/contracts';
import { resolveFleetNodeId, runFleetVerb } from './fleet-client';
import { fleetConfirmFields, type FleetConfirmFlags } from './fleet-confirm';
import { fleetTable, fleetUsage } from './fleet-output';

/**
 * Cloud computers from a shell (FL-17 P3, T-31, CONTRACTS §11.3) — the `cloud`
 * family over the same routes the web uses, with the verbs the fleet tool
 * catalogue gives it:
 *
 *   ever-works fleet cloud providers
 *   ever-works fleet cloud options <provider>
 *   ever-works fleet cloud list
 *   ever-works fleet cloud create <name> --provider <id> --region <id> --size <id> --acknowledge-price <cents>
 *                                 [--software docker,node,claude-code,codex] [--yes]
 *   ever-works fleet cloud power <computer> <on|off> [--yes]
 *   ever-works fleet cloud destroy <computer> --confirm-name <name>
 *   ever-works fleet cloud usage [<computer>]
 *   ever-works fleet cloud idle-policy <computer> <nothing|tell-me|power-off> [--after <hours>]
 *
 * `--acknowledge-price` is REQUIRED on create (spec FR-34): the monthly price in
 * cents `options` printed — a create without it exits 2 before any call, and a
 * stale one is refused `invalid` with the current price. Every verb takes
 * `--json` (`{ ok, data }` — the API's own DTOs) and exits `0 / 1 / 2`; a
 * missing confirmation exits 2 with the price sentence (asked on a terminal).
 * The overlay-VPN key is never accepted here: a shell history is a place a
 * secret stays (spec FR-32 — the web dialog takes it once).
 */

type Flags = FleetConfirmFlags & { json?: boolean };

function confirmOf(flags: Flags): FleetConfirmArgs {
    return fleetConfirmFields({ yes: flags.yes, confirmName: flags.confirmName });
}

function withJson(command: Command): Command {
    return command.option('--json', 'Machine-readable output');
}

function withConfirm(command: Command, destructive = false): Command {
    command.option('--yes', 'Confirm (class confirm)').option('--json', 'Machine-readable output');
    if (destructive)
        command.option(
            '--confirm-name <name>',
            "Type the cloud computer's exact name (class confirm-destructive)",
        );
    return command;
}

const usd = (cents: number, currency?: string) => formatFleetCloudMoney(cents, { currency });
const perHour = (cents: number, currency?: string) =>
    formatFleetCloudMoney(cents, { currency, perHour: true });

/** `--software docker,node` → the ids, or a usage error naming the unknown one. */
export function parseCloudSoftware(json: boolean, raw: string | undefined): string[] | undefined {
    if (raw === undefined) return undefined;
    const ids = raw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    const unknown = ids.find((id) => !isFleetCloudSoftwareId(id) || id === 'overlay-vpn');
    if (unknown) {
        fleetUsage(
            json,
            `--software takes ${FLEET_CLOUD_SOFTWARE_IDS.filter((id) => id !== 'overlay-vpn').join(', ')}`,
            'software',
        );
    }
    return ids;
}

/** `--acknowledge-price 2400` → 2400, or a usage error (exit 2) — it is required (FR-34). */
export function parseAcknowledgedPrice(json: boolean, raw: string | undefined): number {
    const value = raw === undefined ? NaN : Number(raw);
    if (raw === undefined || raw.trim() === '' || !Number.isFinite(value) || value <= 0) {
        fleetUsage(
            json,
            '--acknowledge-price <cents> is required: the monthly price in cents that `fleet cloud options` printed',
            'acknowledgedPriceCents',
        );
    }
    return value;
}

/** `--after 3` → 3, defaulting to 3; a usage error outside 1–72 whole hours. */
export function parseIdleHours(json: boolean, raw: string | undefined): number {
    if (raw === undefined) return 3;
    const value = Number(raw);
    if (
        !Number.isInteger(value) ||
        value < FLEET_CLOUD_IDLE_MIN_HOURS ||
        value > FLEET_CLOUD_IDLE_MAX_HOURS
    ) {
        fleetUsage(
            json,
            `--after is a whole number of hours from ${FLEET_CLOUD_IDLE_MIN_HOURS} to ${FLEET_CLOUD_IDLE_MAX_HOURS}`,
            'afterHours',
        );
    }
    return value;
}

function cloudRow(node: FleetNodeView): string[] {
    const cloud = node.cloud;
    if (!cloud) return [node.id, node.name, '—', '—', '—', node.status, '—'];
    const state =
        cloud.pending ??
        (cloud.phase === 'failed'
            ? 'failed'
            : node.status === 'enrolling'
              ? cloud.phase
              : cloud.powerState);
    return [
        node.id,
        node.name,
        `${cloud.providerName} · ${cloud.regionId}`,
        cloud.sizeLabel,
        `${perHour(cloud.hourlyRateCents, cloud.currency)}/h`,
        state,
        usd(cloud.cost.monthToDateCents, cloud.currency),
    ];
}

const providers = withJson(
    new Command('providers').description('The machine providers enabled for you'),
).action(async (flags: Flags) => {
    await runFleetVerb<FleetCloudProvidersView>(
        flags.json === true,
        { method: 'GET', path: '/fleet/providers' },
        (data) => {
            const rows = [['PROVIDER', 'PLUGIN', 'CONNECTED', 'ACCOUNT', 'SIGN IN']];
            for (const p of data.providers) {
                rows.push([
                    p.providerName,
                    p.pluginId,
                    p.configured ? chalk.green('yes') : 'no',
                    p.account ?? '—',
                    p.oauthAvailable ? 'yes' : '—',
                ]);
            }
            console.log(
                rows.length === 1
                    ? chalk.yellow('No machine provider is enabled. Enable one under Plugins.')
                    : fleetTable(rows),
            );
        },
    );
});

const options = withJson(
    new Command('options')
        .description(
            'Regions and sizes with the provider’s current list prices (the price create needs)',
        )
        .argument('<provider>', 'The provider plugin id (see `fleet cloud providers`)'),
).action(async (provider: string, flags: Flags) => {
    await runFleetVerb<FleetCloudOptionsView>(
        flags.json === true,
        { method: 'GET', path: `/fleet/providers/${encodeURIComponent(provider)}/options` },
        (data) => {
            console.log(
                chalk.bold(
                    `${data.providerName} · ${data.account.label} · ${data.limits.used}/${data.limits.maxPerOwner} cloud computers`,
                ),
            );
            console.log(
                `Regions: ${data.regions
                    .filter((r) => r.available)
                    .map((r) => `${r.id} (${r.label})`)
                    .join(', ')}`,
            );
            const rows = [
                ['SIZE', 'CPU', 'MEMORY', 'DISK', 'PER MONTH', 'PER HOUR', '--acknowledge-price'],
            ];
            for (const size of data.sizes) {
                rows.push([
                    size.id,
                    String(size.vcpus),
                    `${Math.round((size.memoryMiB / 1024) * 10) / 10} GB`,
                    `${size.diskGiB} GB`,
                    usd(size.priceMonthlyCents, data.currency),
                    perHour(size.priceHourlyCents, data.currency),
                    String(size.priceMonthlyCents),
                ]);
            }
            console.log(fleetTable(rows));
            console.log(chalk.gray('List prices; your bill may differ.'));
        },
    );
});

const list = withJson(
    new Command('list').description('Your cloud computers and what they cost'),
).action(async (flags: Flags) => {
    await runFleetVerb<FleetCloudListView>(
        flags.json === true,
        { method: 'GET', path: '/fleet/cloud' },
        (data) => {
            const rows = [['ID', 'NAME', 'WHERE', 'SIZE', 'RATE', 'STATE', 'THIS MONTH']];
            for (const node of data.machines) rows.push(cloudRow(node));
            console.log(rows.length === 1 ? chalk.yellow('No cloud computers.') : fleetTable(rows));
            console.log(
                chalk.gray(
                    `now ${perHour(data.usage.hourlyCents, data.usage.currency)}/h · this month ${usd(data.usage.monthToDateCents, data.usage.currency)} · projected ${usd(data.usage.projectedMonthCents, data.usage.currency)} (list prices)`,
                ),
            );
        },
    );
});

const create = withConfirm(
    new Command('create')
        .description('Create a cloud computer on your provider account (it bills until destroyed)')
        .argument('<name>', '2–39 lower-case letters, digits and hyphens')
        .requiredOption('--provider <id>', 'The provider plugin id (see `fleet cloud providers`)')
        .requiredOption('--region <id>', 'A region id from `fleet cloud options`')
        .requiredOption('--size <id>', 'A size id from `fleet cloud options`')
        .option(
            '--acknowledge-price <cents>',
            'REQUIRED: the monthly price in cents `fleet cloud options` printed',
        )
        .option(
            '--software <ids>',
            'Comma-separated: docker,node,claude-code,codex (default: all four)',
        ),
).action(
    async (
        name: string,
        flags: Flags & {
            provider: string;
            region: string;
            size: string;
            acknowledgePrice?: string;
            software?: string;
        },
    ) => {
        const json = flags.json === true;
        if (!isFleetCloudName(name))
            fleetUsage(json, '<name> is 2–39 lower-case letters, digits and hyphens', 'name');
        const acknowledgedPriceCents = parseAcknowledgedPrice(json, flags.acknowledgePrice);
        const software = parseCloudSoftware(json, flags.software);
        await runFleetVerb<FleetCloudCreateResponse>(
            json,
            {
                method: 'POST',
                path: '/fleet/cloud',
                body: {
                    providerPluginId: flags.provider,
                    name,
                    regionId: flags.region,
                    sizeId: flags.size,
                    acknowledgedPriceCents,
                    ...(software ? { software } : {}),
                },
            },
            (data) => {
                console.log(chalk.green(`✓ creating ${name} (${data.nodeId})`));
                console.log(
                    chalk.gray(
                        'It enrols itself in a few minutes; watch it with: ever-works fleet cloud list',
                    ),
                );
            },
            confirmOf(flags),
        );
    },
);

const power = withConfirm(
    new Command('power')
        .description('Power a cloud computer on or off (off: the provider may still bill it)')
        .argument('<computer>', 'The cloud computer (id or name)')
        .argument('<action>', 'on | off'),
).action(async (ref: string, action: string, flags: Flags) => {
    const json = flags.json === true;
    if (action !== 'on' && action !== 'off') fleetUsage(json, '<action> is on or off', 'action');
    const id = await resolveFleetNodeId(json, ref);
    await runFleetVerb<FleetCloudOperationResponse>(
        json,
        { method: 'POST', path: `/fleet/cloud/${id}/power`, body: { action } },
        () => console.log(chalk.green(`✓ powering ${action} ${ref}`)),
        confirmOf(flags),
    );
});

const destroy = withConfirm(
    new Command('destroy')
        .description(
            'Destroy a cloud computer: the machine and its disk at the provider, then its registration (job history is kept)',
        )
        .argument('<computer>', 'The cloud computer (id or name)'),
    true,
).action(async (ref: string, flags: Flags) => {
    const json = flags.json === true;
    const id = await resolveFleetNodeId(json, ref);
    await runFleetVerb<FleetCloudOperationResponse>(
        json,
        { method: 'POST', path: `/fleet/cloud/${id}/destroy` },
        (data) =>
            console.log(
                chalk.green(
                    `✓ destroyed ${ref}${typeof data.costSoFarCents === 'number' ? ` — it cost ${usd(data.costSoFarCents)}` : ''}`,
                ),
            ),
        confirmOf(flags),
    );
});

const usage = withJson(
    new Command('usage')
        .description(
            'What your cloud computers cost: per hour now, this month and projected (list-price estimates)',
        )
        .argument('[computer]', 'One cloud computer (id or name)'),
).action(async (ref: string | undefined, flags: Flags) => {
    const json = flags.json === true;
    const path = ref
        ? `/fleet/cloud/${await resolveFleetNodeId(json, ref)}/usage`
        : '/fleet/cloud/usage';
    await runFleetVerb<FleetCloudUsageView>(json, { method: 'GET', path }, (data) => {
        const rows = [['NAME', 'WHERE', 'RATE', 'THIS MONTH', 'STATE']];
        for (const row of data.machines) {
            rows.push([
                row.destroyedAt
                    ? `${row.name} (destroyed ${row.destroyedAt.slice(0, 10)})`
                    : row.name,
                [row.providerName, row.regionId, row.sizeLabel].filter(Boolean).join(' · '),
                `${perHour(row.hourlyCents, data.currency)}/h`,
                usd(row.monthToDateCents, data.currency),
                row.destroyedAt ? 'destroyed' : row.state,
            ]);
        }
        console.log(
            rows.length === 1 ? chalk.yellow('No cloud computers this month.') : fleetTable(rows),
        );
        console.log(
            `now ${perHour(data.hourlyCents, data.currency)}/h · this month ${usd(data.monthToDateCents, data.currency)} · projected ${usd(data.projectedMonthCents, data.currency)}`,
        );
        for (const figure of data.providerMonthToDate ?? []) {
            console.log(
                `${figure.providerName} reports ${usd(figure.monthToDateCents, data.currency)} this month for the whole account.`,
            );
        }
        console.log(chalk.gray('Estimates from list prices; your bill may differ.'));
    });
});

const idlePolicy = withJson(
    new Command('idle-policy')
        .description(
            'Set when a cloud computer counts as forgotten: nothing, tell me, or power off after N idle hours',
        )
        .argument('<computer>', 'The cloud computer (id or name)')
        .argument('<mode>', FLEET_CLOUD_IDLE_POLICY_MODES.join(' | '))
        .option(
            '--after <hours>',
            `Idle hours before the policy acts (${FLEET_CLOUD_IDLE_MIN_HOURS}–${FLEET_CLOUD_IDLE_MAX_HOURS}, default 3)`,
        ),
).action(async (ref: string, mode: string, flags: Flags & { after?: string }) => {
    const json = flags.json === true;
    if (!isFleetCloudIdlePolicyMode(mode))
        fleetUsage(json, `<mode> is ${FLEET_CLOUD_IDLE_POLICY_MODES.join(', ')}`, 'mode');
    const afterHours = parseIdleHours(json, flags.after);
    const id = await resolveFleetNodeId(json, ref);
    await runFleetVerb<FleetNodeView>(
        json,
        { method: 'PATCH', path: `/fleet/cloud/${id}/idle-policy`, body: { mode, afterHours } },
        () =>
            console.log(
                chalk.green(
                    `✓ ${ref}: ${mode === 'nothing' ? 'no idle policy' : `${mode === 'power-off' ? 'power off' : 'tell me'} after ${afterHours} h idle`}`,
                ),
            ),
    );
});

export const cloudCommand = new Command('cloud')
    .description(
        'Cloud computers on your own provider account: providers, options, list, create, power, destroy, usage, idle-policy',
    )
    .addCommand(providers)
    .addCommand(options)
    .addCommand(list)
    .addCommand(create)
    .addCommand(power)
    .addCommand(destroy)
    .addCommand(usage)
    .addCommand(idlePolicy);
