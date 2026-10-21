import { Command } from 'commander';
import { checkoutsCommand } from './checkout';
import { commandsCommand } from './command';
import { schedulesCommand } from './schedule';
import { commandsGetCommand, commandsListCommand } from './commands-read';
import { dockerCommand, logsCommand, portsCommand, processesCommand, servicesCommand } from './machine';
import { nodesCommand } from './nodes';
import { operationsCommand } from './operations';
import { attachCommand } from './session/attach';
import { listCommand } from './session/list';
import { readCommand } from './session/read';
import { statusCommand } from './status';
import { toolsCommand } from './tools';
import { answerCommand } from './session/answer';
import { questionCommand } from './session/question';
import { fleetTasksCommand, gitIdentityCommand, sessionStartCommand } from './task-handoff';

/**
 * `ever-works fleet` (FL-04 P2, plan §9) — your computers from the terminal.
 * This epic ships `fleet session list` and `fleet session attach`; FL-19 adds
 * the rest of `ever-works fleet session <verb>`. FL-19 makes the plural the
 * group's name everywhere (`fleet sessions`, CONTRACTS §11.3) — the singular
 * keeps working as the command's own name.
 */
export const fleetSessionCommand = new Command('session')
    .alias('sessions')
    .description('Sessions on your computers (list, read, attach, question, answer)')
    .addCommand(listCommand)
    .addCommand(readCommand)
    .addCommand(attachCommand)
    // FL-05 P2: what a session waits for, and answering it.
    .addCommand(questionCommand)
    .addCommand(answerCommand)
    // FL-15 P3: hand a Task to an Agent session on a computer.
    .addCommand(sessionStartCommand);

// FL-15 P3 — `fleet nodes git-identity <nodeId> [--set [--confirm]]` on FL-19's `fleet nodes`.
nodesCommand.addCommand(gitIdentityCommand);

// FL-19 T-10 — the reads beside FL-12's `fleet commands run`.
commandsCommand.addCommand(commandsListCommand).addCommand(commandsGetCommand);

/**
 * `ever-works fleet <family> <verb> [--json]` (FL-19, CONTRACTS §11.3) — the
 * same routes, shapes and typed refusals as the hub, the Agent tools and the
 * MCP server. `--json` prints `{ ok: true, data }` or `{ ok: false, error }`;
 * exit `0` ok, `1` refused or failed, `2` usage or a missing confirmation,
 * `124` timed out.
 *
 * Groups that have landed: status, nodes, sessions (FL-04), logs (FL-08),
 * services / processes / docker (FL-09), ports (FL-10), commands (FL-12),
 * checkouts (FL-14), operations (FL-02), tools (the catalogue).
 *
 * ── Registration point (families that have not landed yet) ──
 * desktop (FL-07), files (FL-11), schedules (FL-13), tasks (FL-15), virtual
 * (FL-16), cloud (FL-17), runners (FL-18), usage (FL-20): each epic adds its
 * `<family>.ts` beside these and one `.addCommand(...)` line below, using the
 * verbs its `FLEET_TOOL_CATALOGUE` rows name in `cli` (`ever-works fleet tools
 * --planned` lists them) and `runFleetVerb` / `fleet-confirm.ts` for the
 * envelope and the confirmation flags.
 */
export const fleetCommand = new Command('fleet')
    .description('Your computers')
    .addCommand(statusCommand)
    .addCommand(nodesCommand)
    .addCommand(fleetSessionCommand)
    .addCommand(commandsCommand)
    // Checkouts on computers (FL-14): `fleet checkouts list|get|create|sync|archive|delete` (alias `fleet checkout`).
    .addCommand(checkoutsCommand)
    .addCommand(logsCommand)
    .addCommand(servicesCommand)
    .addCommand(processesCommand)
    .addCommand(dockerCommand)
    .addCommand(portsCommand)
    .addCommand(operationsCommand)
    .addCommand(toolsCommand)
    // Schedules on computers (FL-13): `fleet schedules create|list|get|update|run|pause|resume|runs|delete` (alias `fleet schedule`).
    .addCommand(schedulesCommand)
    // Tasks on computers (FL-15 P3): `fleet tasks handoff-options <taskId>`.
    .addCommand(fleetTasksCommand);
