import { program } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { authCommand } from './commands/auth';
import { workCommand } from './commands/work';
import { pluginsCommand } from './commands/plugins';
import { registerKbCommands } from './commands/kb';
import { fleetCommand } from './commands/fleet';
import { completionCommand } from './commands/fleet/completion';

// Load environment variables
dotenv.config({ debug: false, quiet: true });

const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'package.json'), { encoding: 'utf-8' }),
);

program
    .name('ever-works')
    .description('Ever Works CLI - Open Work Builder Platform')
    .version(packageJson.version);

// commands
program.addCommand(authCommand);
program.addCommand(workCommand);
program.addCommand(pluginsCommand);
// `ever-works fleet …`: sessions (FL-04), commands (FL-12, `fleet commands run --on a,b -- <cmd>`) and
// checkouts (FL-14, `fleet checkouts list|get|create|sync|archive|delete`); FL-19 adds status, nodes,
// logs, services, processes, docker, ports, operations and tools, with `--json` and exits 0/1/2/124.
program.addCommand(fleetCommand);
// FL-19 P3: `ever-works completion <bash|zsh|fish>` — generated from the commands registered here.
program.addCommand(completionCommand);
registerKbCommands(program);

// Parse arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
    program.outputHelp();
    process.exit(0);
}
