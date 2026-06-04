/**
 * Named, color-coded loggers for each SDLC Framework subsystem.
 * Import the relevant logger rather than calling console.log directly.
 */

import chalk, { type ChalkInstance } from 'chalk';

function ts() {
    return chalk.dim(new Date().toTimeString().slice(0, 8));
}

function makeLogger(emoji: string, label: string, labelColor: ChalkInstance) {
    const tag = () => labelColor(`${emoji} [${label}]`);
    return {
        info:    (msg: string) => console.log(`${ts()} ${tag()} ${msg}`),
        success: (msg: string) => console.log(`${ts()} ${tag()} ${chalk.green(msg)}`),
        warn:    (msg: string) => console.warn(`${ts()} ${tag()} ${chalk.yellow(msg)}`),
        error:   (msg: string) => console.error(`${ts()} ${tag()} ${chalk.red(msg)}`),
    };
}

export const serverLog = makeLogger('🤖', 'server',     chalk.magenta);
export const ollamaLog = makeLogger('🦙', 'ollama',     chalk.cyan);
export const meshllmLog = makeLogger('🕸️', 'meshllm',   chalk.hex('#a78bfa'));
export const adoLog    = makeLogger('🔗', 'platform', chalk.blue);
export const ragLog    = makeLogger('🔍', 'rag',        chalk.green);
export const dbLog     = makeLogger('🗄️', 'db',         chalk.yellow);
export const mlxLog    = makeLogger('🍎', 'mlx',        chalk.hex('#ff9f1c'));
