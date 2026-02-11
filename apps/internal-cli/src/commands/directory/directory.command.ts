import { Command, CommandRunner } from 'nest-commander';
import { CreateSubCommand } from './create.subcommand';
import { ListSubCommand } from './list.subcommand';
import { UpdateSubCommand } from './update.subcommand';
import { SubmitItemSubCommand } from './submit-item.subcommand';
import { RemoveItemSubCommand } from './remove-item.subcommand';
import { RegenerateMarkdownSubCommand } from './regenerate-markdown.subcommand';
import { UpdateWebsiteSubCommand } from './update-website.subcommand';
import { DeploySubCommand } from './deploy.subcommand';
import { DeleteSubCommand } from './delete.subcommand';
import { GenerateSubCommand } from './generate.subcommand';

@Command({
    name: 'directory',
    description: 'Directory management commands',
    subCommands: [
        CreateSubCommand,
        ListSubCommand,
        UpdateSubCommand,
        SubmitItemSubCommand,
        RemoveItemSubCommand,
        RegenerateMarkdownSubCommand,
        UpdateWebsiteSubCommand,
        DeploySubCommand,
        DeleteSubCommand,
        GenerateSubCommand,
    ],
})
export class DirectoryCommand extends CommandRunner {
    async run(): Promise<void> {
        console.log('Available directory commands:');
        console.log('  create              - Create a new directory');
        console.log('  list                - List all directories');
        console.log(
            '  generate            - Generate data and create a repository for a directory',
        );
        console.log('  update              - Update a directory and its repository');
        console.log('  submit-item         - Submit an item to a directory');
        console.log('  remove-item         - Remove an item from a directory');
        console.log('  regenerate-markdown - Regenerate readme markdown file for a directory');
        console.log('  update-website      - Update the website repository for a directory');
        console.log('  deploy              - Deploy the website for a directory');
        console.log('  delete              - Delete a directory and its repositories');
        console.log('\nUse "directory <command> --help" for more information about a command.');
    }
}
