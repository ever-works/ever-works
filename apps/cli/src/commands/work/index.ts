import { Command } from 'commander';
import { createCommand } from './create';
import { listCommand } from './list';
import { generateCommand } from './generate';
import { updateCommand } from './update';
import { submitItemCommand } from './submit-item';
import { removeItemCommand } from './remove-item';
import { regenerateMarkdownCommand } from './regenerate-markdown';
import { updateWebsiteCommand } from './update-website';
import { deployCommand } from './deploy';
import { deleteCommand } from './delete';
import { statusCommand } from './status';
import { pluginsCommand } from './plugins';
import { registerCommand } from './register';

export const workCommand = new Command('work')
    .description('Work management commands')
    .addCommand(createCommand)
    .addCommand(listCommand)
    .addCommand(generateCommand)
    .addCommand(updateCommand)
    .addCommand(submitItemCommand)
    .addCommand(removeItemCommand)
    .addCommand(regenerateMarkdownCommand)
    .addCommand(updateWebsiteCommand)
    .addCommand(deployCommand)
    .addCommand(deleteCommand)
    .addCommand(statusCommand)
    .addCommand(pluginsCommand)
    .addCommand(registerCommand)
    .action(() => {
        console.log('Available work commands:');
        console.log('  create              - Create a new work');
        console.log('  list                - List all works');
        console.log('  generate            - Generate data and create a repository for a work');
        console.log('  update              - Update a work and its repository');
        console.log('  submit-item         - Submit an item to a work');
        console.log('  remove-item         - Remove an item from a work');
        console.log('  regenerate-markdown - Regenerate readme markdown file for a work');
        console.log('  update-website      - Update the website repository for a work');
        console.log('  deploy              - Deploy the website for a work');
        console.log('  delete              - Delete a work');
        console.log('  status              - Check the status of a work');
        console.log('  plugins             - Manage plugins for a work');
        console.log(
            '  register            - Zero-friction registration from a .works/works.yml repo',
        );
        console.log('\nUse "work <command> --help" for more information about a command.');
    });
