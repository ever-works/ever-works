import { program } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { authCommand } from './commands/auth';
import { workCommand } from './commands/work';
import { pluginsCommand } from './commands/plugins';
import { registerKbCommands } from './commands/kb';
import { registerFleetCommands } from './commands/fleet';

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
registerKbCommands(program);
// Commands on computers (FL-12): `ever-works fleet commands run --on a,b -- <cmd>`.
registerFleetCommands(program);

// Parse arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
    program.outputHelp();
    process.exit(0);
}
