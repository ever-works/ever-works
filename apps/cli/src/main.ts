import { program } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { authCommand } from './commands/auth';
import { directoryCommand } from './commands/directory';

// Load environment variables
dotenv.config({ debug: false, quiet: true });

// Get package version
const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../package.json'), { encoding: 'utf-8' }),
);

program
    .name('ever-works')
    .description('Ever Works CLI - Open Directory Builder Platform')
    .version(packageJson.version);

// commands
program.addCommand(authCommand);
program.addCommand(directoryCommand);

// Parse arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
    program.outputHelp();
    process.exit(0);
}
