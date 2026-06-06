import { Command } from 'commander';
import { listCommand } from './list';
import { getCommand } from './get';
import { uploadCommand } from './upload';
import { lockCommand, unlockCommand } from './lock';

/**
 * `ever works kb` subcommand group — EW-643 Phase 3 slice 3.
 *
 * Wires the per-Work Knowledge Base REST surface
 * (`/api/works/:id/kb/...`) to a commander subtree so operators can
 * drive list / get / upload / lock / unlock from the terminal without
 * round-tripping through the web UI or hand-rolling `curl`.
 *
 * The group is mounted under the existing `works` command in
 * `apps/cli/src/main.ts` via {@link registerKbCommands} so other
 * subcommand groups can reuse the same registration pattern (mirrors
 * the `pluginsCommand` group already mounted on `workCommand`).
 */
export const kbCommand = new Command('kb')
    .description('Knowledge Base commands (list, get, upload, lock, unlock)')
    .addCommand(listCommand)
    .addCommand(getCommand)
    .addCommand(uploadCommand)
    .addCommand(lockCommand)
    .addCommand(unlockCommand);

/**
 * Register the `kb` subcommand group on the supplied commander
 * program / parent command. Mirrors the registration helper pattern
 * already used by the work + plugins groups.
 */
export function registerKbCommands(program: Command): void {
    program.addCommand(kbCommand);
}
