#!/usr/bin/env node

// Launcher: runs the CLI via ts-node in dev, or compiled JS in prod
const path = require('path');
const fs = require('fs');

const distEntry = path.join(__dirname, '..', 'dist', 'cli.js');
const srcEntry = path.join(__dirname, '..', 'src', 'cli.ts');

if (fs.existsSync(distEntry)) {
    // Production: compiled output exists
    require(distEntry);
} else if (fs.existsSync(srcEntry)) {
    // Development: run via ts-node
    try {
        require('ts-node').register({
            project: path.join(__dirname, '..', 'tsconfig.json'),
            transpileOnly: true,
        });
        require(srcEntry);
    } catch (e) {
        console.error(
            '❌  Cannot find compiled output (dist/cli.js) or ts-node.\n' +
            '    Run `npm install` then `npm run build`, or install ts-node.\n'
        );
        process.exit(1);
    }
} else {
    console.error('❌  Cannot locate StackMod entry point. Did you run `npm install`?');
    process.exit(1);
}
