import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { completionScript, completionTable, completionTree } from '../completion';

/** FL-19 T-21 — completion scripts are generated from the registered command tree. */
function program(): Command {
    const services = new Command('services')
        .alias('service')
        .addCommand(
            new Command('action').option('--on <computer>', 'computer').option('--yes', 'confirm'),
        );
    const fleet = new Command('fleet')
        .addCommand(new Command('status').option('--json', 'json'))
        .addCommand(services);
    return new Command('ever-works').addCommand(fleet);
}

describe('completion', () => {
    it('lists what may follow every command path, aliases included', () => {
        const table = completionTable(completionTree(program()));
        expect(table.get('')).toEqual(expect.arrayContaining(['fleet', '--help']));
        expect(table.get('fleet')).toEqual(
            expect.arrayContaining(['status', 'services', 'service']),
        );
        expect(table.get('fleet service action')).toEqual(
            expect.arrayContaining(['--on', '--yes']),
        );
        expect(table.get('fleet services action')).toEqual(table.get('fleet service action'));
    });

    it('prints a bash script with one entry per path and the complete hook', () => {
        const script = completionScript('bash', completionTree(program()));
        expect(script).toContain("__ever_works_complete_words['fleet services']='action --help'");
        expect(script).toContain('complete -F __ever_works_complete ever-works');
    });

    it('wraps the bash script for zsh', () => {
        const script = completionScript('zsh', completionTree(program()));
        expect(script.startsWith('#compdef ever-works')).toBe(true);
        expect(script).toContain('bashcompinit');
    });

    it('prints fish completions per level', () => {
        const script = completionScript('fish', completionTree(program()));
        expect(script).toContain("complete -c ever-works -f -n '__fish_use_subcommand' -a 'fleet'");
        expect(script).toContain(
            "complete -c ever-works -f -n '__fish_seen_subcommand_from fleet' -a 'services'",
        );
        expect(script).toContain(
            "complete -c ever-works -n '__fish_seen_subcommand_from action' -l 'yes'",
        );
    });
});
