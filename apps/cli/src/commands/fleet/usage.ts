import { Command } from 'commander';
import chalk from 'chalk';
import {
    FLEET_USAGE_DEFAULT_PERIOD,
    FLEET_USAGE_PERIODS,
    fleetUsageCsv,
    formatFleetUsageCents,
    formatFleetUsageTokens,
    isFleetUsagePeriodDays,
    totalFleetUsageTokens,
    type FleetUsageView,
} from '@ever-works/contracts';
import { resolveFleetNodeId, runFleetVerb } from './fleet-client';
import { emitFleetError, fleetTable } from './fleet-output';

/**
 * `ever-works fleet usage [--days 1|7|30|90] [--on <computer>] [--model <id>] [--json]`
 * (FL-20, plan §9, spec S6, FR-19) — what the model work on my computers would
 * cost at LIST price: the same object the hub's Usage tab and `fleet_usage_get`
 * render, read-only. `--json` prints `{ ok: true, data: FleetUsageView }` with
 * the payer sentence in `data.note`.
 */

function money(cents: number | null): string {
    return formatFleetUsageCents(cents) ?? 'tokens only';
}

function lastScan(at: string | null, now: number): string {
    if (!at) return 'no scan yet';
    const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
    if (minutes < 60) return `scanned ${minutes} min ago`;
    if (minutes < 48 * 60) return `scanned ${Math.round(minutes / 60)} h ago`;
    return `scanned ${Math.round(minutes / (24 * 60))} d ago`;
}

/** The human rendering, as lines (pure — the spec drives it). */
export function renderFleetUsage(view: FleetUsageView, now: number = Date.now()): string[] {
    const lines: string[] = [];
    const tokens = totalFleetUsageTokens(view.totals.tokens);
    lines.push(
        chalk.bold(
            `${money(view.totals.costCents)} at list price · ${formatFleetUsageTokens(tokens)} tokens · ${view.totals.requests} requests${
                view.totals.topModel ? ` · top model ${view.totals.topModel}` : ''
            }`,
        ) + chalk.gray(`  (last ${view.days} day${view.days === 1 ? '' : 's'})`),
    );
    lines.push(chalk.gray(view.note));
    if (view.unknownModels.requests > 0) {
        lines.push(
            chalk.yellow(
                `Excludes ${view.unknownModels.requests} request${view.unknownModels.requests === 1 ? '' : 's'} on unknown models (${view.unknownModels.models.join(', ')}) — tokens only.`,
            ),
        );
    }
    if (view.catchingUp) {
        lines.push(chalk.gray(`Catching up · ${view.catchingUp.scannedPct} % scanned on ${view.catchingUp.nodeName}`));
    }
    if (view.byModel.length > 0) {
        lines.push('');
        const rows = [['MODEL', 'REQUESTS', 'TOKENS', 'COST']];
        for (const line of view.byModel) {
            rows.push([line.model, String(line.requests), formatFleetUsageTokens(totalFleetUsageTokens(line.tokens)), money(line.costCents)]);
        }
        lines.push(fleetTable(rows));
    }
    if (view.byNode.length > 0) {
        lines.push('');
        const rows = [['COMPUTER', 'COST', 'SCAN']];
        for (const node of view.byNode) {
            const scan =
                node.scan.state === 'on'
                    ? `${node.scan.online ? '' : 'offline · '}${lastScan(node.scan.lastScanAt, now)}`
                    : (node.scan.hint ?? node.scan.state);
            rows.push([node.name, node.scan.state === 'on' ? money(node.costCents) : '—', scan]);
        }
        lines.push(fleetTable(rows));
    }
    if (view.busiestCheckouts.length > 0) {
        lines.push('');
        lines.push(
            `Busiest checkouts  ${view.busiestCheckouts
                .map((line) => `${line.path ?? 'other folders'} on ${line.nodeName} ${money(line.costCents)}`)
                .join(' · ')}`,
        );
    }
    const sessions = view.sessions;
    const parts = sessions.agents.map((agent) => `${agent.name ?? agent.agentId} ${agent.sessions}`);
    if (sessions.owner.sessions > 0) parts.push(`owner sessions ${sessions.owner.sessions}`);
    if (sessions.other) parts.push(`other (not started from Ever Works) ${sessions.other.sessions}`);
    if (parts.length > 0) lines.push(`Sessions  ${parts.join(' · ')}`);
    if (view.excluded.nodes > 0 || view.excluded.otherHidden) {
        lines.push(
            chalk.gray(
                `Not shown: ${[
                    view.excluded.nodes > 0 ? `${view.excluded.nodes} computer(s) you may not see` : null,
                    view.excluded.otherHidden ? 'sessions not started from Ever Works on computers you do not own' : null,
                ]
                    .filter(Boolean)
                    .join('; ')}`,
            ),
        );
    }
    lines.push(chalk.gray(`Priced at model list prices v${view.priceList.version} (in effect since ${view.priceList.effectiveFrom}).`));
    return lines;
}

export function printFleetUsage(view: FleetUsageView): void {
    for (const line of renderFleetUsage(view)) console.log(line);
}

/** `--days` as the API takes it, or null when it is not one of the periods. */
export function parseFleetUsageDays(raw: string | undefined): number | null {
    if (raw === undefined) return FLEET_USAGE_DEFAULT_PERIOD;
    const days = Number(raw);
    return isFleetUsagePeriodDays(days) ? days : null;
}

export const usageCommand = new Command('usage')
    .description('What the model work on my computers would cost at list price (read-only)')
    .option('--days <days>', `The period: ${FLEET_USAGE_PERIODS.join(', ')} (default ${FLEET_USAGE_DEFAULT_PERIOD})`)
    .option('--on <computer>', 'Only this computer (its name or id)')
    .option('--model <model>', 'Only this model id')
    .option('--json', 'Machine-readable output: { ok, data }')
    .option('--csv', 'The same figures as CSV (one row per model, computer, checkout and Agent)')
    .action(async (options: { days?: string; on?: string; model?: string; json?: boolean; csv?: boolean }) => {
        const json = options.json === true;
        const days = parseFleetUsageDays(options.days);
        if (days === null) {
            return emitFleetError(json, {
                code: 'invalid',
                hint: `--days must be one of ${FLEET_USAGE_PERIODS.join(', ')}`,
                details: { field: 'days' },
            });
        }
        const node = options.on ? await resolveFleetNodeId(json, options.on) : undefined;
        await runFleetVerb<FleetUsageView>(
            json,
            { method: 'GET', path: '/fleet/usage', query: { days, node, model: options.model } },
            options.csv === true && !json ? (view) => process.stdout.write(fleetUsageCsv(view)) : printFleetUsage,
        );
    });
