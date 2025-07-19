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

export const directoryCommand = new Command('directory')
    .description('Directory management commands')
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
    .action(() => {
        console.log('Available directory commands:');
        console.log('  create              - Create a new directory');
        console.log('  list                - List all directories');
        console.log('  generate            - Generate data and create a GitHub repository for a directory');
        console.log('  update              - Update a directory and its GitHub repository');
        console.log('  submit-item         - Submit an item to a directory');
        console.log('  remove-item         - Remove an item from a directory');
        console.log('  regenerate-markdown - Regenerate readme markdown file for a directory');
        console.log('  update-website      - Update the website repository for a directory');
        console.log('  deploy              - Deploy the website for a directory');
        console.log('  delete              - Delete a directory');
        console.log('\nUse "directory <command> --help" for more information about a command.');
    });
