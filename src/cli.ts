#!/usr/bin/env node
/**
 * StackMod CLI — Mutation compiler for existing codebases
 *
 * Commands:
 *   stackmod add <mutation>        — Apply a mutation to the current project
 *   stackmod rollback <id>         — Roll back a previously applied mutation
 *   stackmod history               — List all applied mutations
 */

import { Command } from 'commander';
import chalk from 'chalk';
import prompts from 'prompts';
import * as path from 'path';

import { scanProject } from './engine/scan';
import { loadMutationSpec, buildPatchPlan } from './engine/planner';
import { applyPatchPlan } from './engine/patcher';
import { recordMutation, findAppliedMutation, listEntries } from './engine/ledger';
import { rollbackMutation } from './engine/rollback';

// ─── CLI setup ────────────────────────────────────────────────────────────────

const SAFE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const { version } = require('../package.json') as { version: string };

const program = new Command();

program
    .name('stackmod')
    .description('Injext by StackMod — mutate Replit and Express codebases safely')
    .version(version);

// ─── stackmod add <mutation> ──────────────────────────────────────────────────

program
    .command('add <mutation> [name]')
    .description('Apply a named mutation. Pass [name] for parameterized mutations, e.g. stackmod add route users')
    .option('--yes', 'Skip confirmation prompt and apply immediately')
    .option('--dry-run', 'Print the patch plan without applying')
    .action(async (mutationName: string, nameArg: string | undefined, options: { yes?: boolean; dryRun?: boolean }) => {
        const rootDir = process.cwd();

        try {
            if (!SAFE_NAME_RE.test(mutationName)) {
                throw new Error('Mutation names must start with a letter and contain only lowercase letters, numbers, or hyphens.');
            }
            if (nameArg && !SAFE_NAME_RE.test(nameArg)) {
                throw new Error('Parameterized names must start with a letter and contain only lowercase letters, numbers, or hyphens.');
            }

            // ── 1. Scan ──────────────────────────────────────────────────────────
            process.stdout.write(chalk.dim('\n  Scanning project...  '));
            const profile = await scanProject(rootDir);
            process.stdout.write(chalk.green('✓\n'));

            console.log(chalk.dim(`  Framework : `) + chalk.white(profile.framework));
            console.log(chalk.dim(`  Language  : `) + chalk.white(profile.language));
            console.log(chalk.dim(`  Entry     : `) + chalk.white(path.relative(rootDir, profile.entryFile)));

            // ── 2. Load spec (do this first to get canonical spec.id) ────────────
            let spec;
            try {
                spec = loadMutationSpec(mutationName);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(chalk.red(`\n  ✗  ${msg}\n`));
                process.exit(1);
            }

            // Build params from the optional [name] arg.
            // Convention: the extra arg is available as both `name` and `<mutationSuffix>Name`
            // e.g. `stackmod add route users` → params = { name: 'users', routeName: 'users' }
            const params: Record<string, string> = {};
            if (nameArg) {
                params['name'] = nameArg;
                // Derive a camelCase key: "route" → "routeName", "page" → "pageName"
                const camelKey = `${mutationName.replace(/[^a-zA-Z0-9]/g, '')}Name`;
                params[camelKey] = nameArg;
            }

            // ── 3. Check idempotency (per mutation + name combination) ───────────
            // Idempotency key = spec.id + optional name, so you can add multiple routes
            const idempotencyKey = nameArg ? `${spec.id}:${nameArg}` : spec.id;
            const existing = findAppliedMutation(rootDir, idempotencyKey);
            if (existing) {
                console.log(
                    chalk.yellow(`\n  ⚠  "${idempotencyKey}" has already been applied.`) +
                    chalk.dim(`\n     Applied at : ${existing.applied_at}`) +
                    chalk.dim(`\n     Rollback ID: ${existing.id}\n`)
                );
                process.exit(0);
            }

            // ── 4. Build plan ─────────────────────────────────────────────────────
            const plan = buildPatchPlan(spec, profile, params);


            // ── 5. Print plan ─────────────────────────────────────────────────────
            printPlan(plan, profile.framework);

            if (options.dryRun) {
                console.log(chalk.yellow('\n  Dry run — no changes made.\n'));
                process.exit(0);
            }

            // ── 6. Confirm ────────────────────────────────────────────────────────
            if (!options.yes) {
                const answer = await prompts({
                    type: 'confirm',
                    name: 'apply',
                    message: 'Apply mutation?',
                    initial: true,
                });

                if (!answer.apply) {
                    console.log(chalk.dim('\n  Aborted.\n'));
                    process.exit(0);
                }
            }

            // ── 7. Apply ──────────────────────────────────────────────────────────
            console.log('');
            process.stdout.write(chalk.dim('  Applying patch...    '));

            // Generate the rollback ID up front so backup dir and ledger entry share the same ID
            const rollbackId = nameArg
                ? `${plan.mutationId}-${nameArg}-${Date.now()}`
                : `${plan.mutationId}-${Date.now()}`;
            const result = await applyPatchPlan(plan, profile, rollbackId);
            process.stdout.write(chalk.green('✓\n'));

            // ── 8. Record ledger ──────────────────────────────────────────────────
            // Use idempotencyKey as the ledger mutation ID so history shows add-route:users etc.
            const entry = recordMutation(
                rootDir,
                idempotencyKey,
                plan.version,
                result.filesCreated,
                result.filesModified,
                result.backupDir,
                rollbackId
            );

            // ── 9. Success output ─────────────────────────────────────────────────
            printSuccess(entry.id, plan, rootDir);


        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(chalk.red(`\n  ✗  ${msg}\n`));
            process.exit(1);
        }
    });

// ─── stackmod rollback <id> ───────────────────────────────────────────────────

program
    .command('rollback <id>')
    .description('Roll back a previously applied mutation by its rollback ID')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (rollbackId: string, options: { yes?: boolean }) => {
        const rootDir = process.cwd();

        try {
            if (!options.yes) {
                console.log(chalk.yellow(`\n  Rolling back: ${chalk.white(rollbackId)}`));
                const answer = await prompts({
                    type: 'confirm',
                    name: 'confirm',
                    message: 'This will delete created files and restore modified files. Continue?',
                    initial: false,
                });

                if (!answer.confirm) {
                    console.log(chalk.dim('\n  Aborted.\n'));
                    process.exit(0);
                }
            }

            process.stdout.write(chalk.dim('\n  Rolling back...      '));
            await rollbackMutation(rootDir, rollbackId);
            process.stdout.write(chalk.green('✓\n'));

            console.log(
                chalk.green('\n  ✔  Rollback complete.\n') +
                chalk.dim('     Ledger entry removed.\n')
            );

        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(chalk.red(`\n  ✗  ${msg}\n`));
            process.exit(1);
        }
    });

// ─── stackmod history ─────────────────────────────────────────────────────────

program
    .command('history')
    .description('List all applied mutations and their rollback IDs')
    .action(() => {
        const rootDir = process.cwd();
        const entries = listEntries(rootDir);

        if (entries.length === 0) {
            console.log(chalk.dim('\n  No mutations have been applied to this project.\n'));
            return;
        }

        console.log(chalk.bold('\n  Applied Mutations\n  ' + '─'.repeat(50)));
        for (const e of entries) {
            console.log(
                `\n  ${chalk.cyan(e.mutation)}  ${chalk.dim('v' + e.version)}` +
                `\n    Applied : ${chalk.dim(e.applied_at)}` +
                `\n    ID      : ${chalk.yellow(e.id)}` +
                `\n    Files   : ${e.files_created.length} created, ${e.files_modified.length} modified`
            );
        }
        console.log('');
    });

// ─── stackmod scan ────────────────────────────────────────────────────────────

program
    .command('scan')
    .description('Scan the current project and display its profile')
    .action(async () => {
        const rootDir = process.cwd();
        try {
            const profile = await scanProject(rootDir);
            console.log(chalk.bold('\n  Project Profile\n  ' + '─'.repeat(40)));
            console.log(`  ${chalk.dim('Framework :')} ${chalk.white(profile.framework)}`);
            console.log(`  ${chalk.dim('Language  :')} ${chalk.white(profile.language)}`);
            console.log(`  ${chalk.dim('Entry file:')} ${chalk.white(path.relative(rootDir, profile.entryFile))}`);
            console.log(`  ${chalk.dim('Root dir  :')} ${chalk.white(profile.rootDir)}`);
            console.log('');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(chalk.red(`\n  ✗  ${msg}\n`));
            process.exit(1);
        }
    });

// ─── Output helpers ───────────────────────────────────────────────────────────

function printPlan(
    plan: ReturnType<typeof buildPatchPlan>,
    framework: string
): void {
    const divider = chalk.dim('─'.repeat(50));

    console.log(chalk.bold(`\n  Injext Mutation Plan — ${chalk.cyan(plan.mutationId)} v${plan.version}`));
    console.log('  ' + divider);

    if (plan.filesToCreate.length > 0) {
        console.log(chalk.bold('\n  Create:'));
        for (const f of plan.filesToCreate) {
            console.log(`    ${chalk.green('+')} ${f}`);
        }
    }

    if (plan.filesToModify.length > 0) {
        console.log(chalk.bold('\n  Modify:'));
        for (const f of plan.filesToModify) {
            console.log(`    ${chalk.yellow('~')} ${f}`);
        }
    }

    if (plan.depsToAdd.length > 0) {
        console.log(chalk.bold('\n  Dependencies (added to package.json):'));
        for (const d of plan.depsToAdd) {
            console.log(`    ${chalk.blue('+')} ${d}`);
        }
        console.log(chalk.dim('\n    ⚠  Run npm install after applying to install these packages.'));
    }

    if (plan.envToAdd.length > 0) {
        console.log(chalk.bold('\n  Environment Variables (added to .env.example):'));
        for (const e of plan.envToAdd) {
            console.log(`    ${chalk.magenta('+')} ${e}`);
        }
    }

    console.log('\n  ' + divider);
}

function printSuccess(
    rollbackId: string,
    plan: ReturnType<typeof buildPatchPlan>,
    rootDir: string
): void {
    console.log(chalk.green('\n  ✔  Mutation applied successfully!\n'));

    if (plan.filesToCreate.length > 0) {
        console.log(chalk.dim('  Files created:'));
        for (const f of plan.filesToCreate) {
            console.log(chalk.dim(`    ${f}`));
        }
    }

    if (plan.filesToModify.length > 0) {
        console.log(chalk.dim('\n  Files modified:'));
        for (const f of plan.filesToModify) {
            console.log(chalk.dim(`    ${f}`));
        }
    }

    console.log(
        chalk.dim('\n  Next steps:') +
        chalk.white('\n    1. npm install') +
        chalk.white('\n    2. cp .env.example .env  (then set JWT_SECRET)') +
        chalk.white('\n    3. Restart your dev server')
    );

    console.log(
        chalk.dim('\n  To roll back:') +
        chalk.yellow(`\n    stackmod rollback ${rollbackId}\n`)
    );
}

// ─── Run ──────────────────────────────────────────────────────────────────────

program.parse(process.argv);

// Show help if no command given
if (process.argv.length < 3) {
    program.help();
}
