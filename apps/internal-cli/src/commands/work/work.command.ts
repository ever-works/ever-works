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
    name: 'work',
    description: 'Work management commands',
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
export class WorkCommand extends CommandRunner {
    async run(): Promise<void> {
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
        console.log('  delete              - Delete a work and its repositories');
        console.log('\nUse "work <command> --help" for more information about a command.');
    }
}
