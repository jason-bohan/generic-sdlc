#!/usr/bin/env node
// Cross-platform script dispatcher.
// Usage: node bin/run.cjs <script-name> [args...]
// Runs bin/<script-name>.ps1 on Windows, bin/<script-name>.sh on macOS/Linux.
// --foo-bar args are translated to -FooBar for PowerShell.
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const [script, ...args] = process.argv.slice(2);
if (!script) { console.error('Usage: node bin/run.cjs <script-name> [args...]'); process.exit(1); }

const isWin = process.platform === 'win32';

if (isWin) {
    // Translate --foo-bar → -FooBar for PowerShell switch params
    const psArgs = args.map((a) =>
        /^--[a-z]/.test(a)
            ? '-' + a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
            : a
    );
    execFileSync('powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
         path.join(__dirname, `${script}.ps1`), ...psArgs],
        { stdio: 'inherit' });
} else {
    execFileSync('bash', [path.join(__dirname, `${script}.sh`), ...args], { stdio: 'inherit' });
}
