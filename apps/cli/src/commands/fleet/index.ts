import { Command } from 'commander';
import { checkoutsCommand } from './checkout';
import { commandsCommand } from './command';
import { attachCommand } from './session/attach';
import { listCommand } from './session/list';
import { answerCommand } from './session/answer';
import { questionCommand } from './session/question';
import { fleetNodesCommand, sessionStartCommand } from './task-handoff';

/**
 * `ever-works fleet` (FL-04 P2, plan §9) — your computers from the terminal.
 * This epic ships `fleet session list` and `fleet session attach`; FL-19 adds
 * the rest of `ever-works fleet session <verb>`.
 */
export const fleetSessionCommand = new Command('session')
    .description('Sessions on your computers (list, attach, question, answer)')
    .addCommand(listCommand)
    .addCommand(attachCommand)
    // FL-05 P2: what a session waits for, and answering it.
    .addCommand(questionCommand)
    .addCommand(answerCommand)
    // FL-15 P3: hand a Task to an Agent session on a computer.
    .addCommand(sessionStartCommand);

/**
 * `ever-works fleet commands run` (FL-12, CONTRACTS §11.3) — one command on
 * several computers (alias `fleet command`).
 */
export const fleetCommand = new Command('fleet')
    .description('Your computers')
    .addCommand(fleetSessionCommand)
    .addCommand(commandsCommand)
    // Checkouts on computers (FL-14): `fleet checkouts list|get|create|sync|archive|delete` (alias `fleet checkout`).
    .addCommand(checkoutsCommand)
    // Tasks on computers (FL-15 P3): `fleet nodes git-identity <nodeId> [--set [--confirm]]`.
    .addCommand(fleetNodesCommand);
