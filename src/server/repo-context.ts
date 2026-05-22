import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { resolve, relative, extname, basename } from 'path';
import { parseJsonUtf8File } from './json-file';

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.angular',
    'coverage', '.nyc_output', '.cache', '.turbo', '.parcel-cache',
    '__pycache__', '.venv', 'venv', '.agent-output', '.sdlc-framework',
]);

const INTERESTING_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte',
    '.cs', '.java', '.py', '.go', '.rs',
    '.html', '.scss', '.css',
]);

const MAX_CONTEXT_CHARS = 3000;
const MAX_TREE_DEPTH = 4;
const MAX_FILES_SAMPLED = 10;

interface RepoInfo {
    tree: string;
    techStack: string;
    keyExports: string;
    patterns: string;
}

function buildTree(dir: string, baseDir: string, depth = 0, maxDepth = MAX_TREE_DEPTH): string[] {
    if (depth > maxDepth) return [];
    const lines: string[] = [];
    let entries: string[];
    try {
        entries = readdirSync(dir).sort();
    } catch { return []; }

    const dirs: string[] = [];
    const files: string[] = [];

    for (const entry of entries) {
        if (entry.startsWith('.') && depth === 0 && entry !== '.env.example') continue;
        const full = resolve(dir, entry);
        let stat;
        try { stat = statSync(full); } catch { continue; }
        if (stat.isDirectory()) {
            if (!SKIP_DIRS.has(entry)) dirs.push(entry);
        } else {
            files.push(entry);
        }
    }

    const indent = '  '.repeat(depth);
    for (const d of dirs) {
        lines.push(`${indent}${d}/`);
        const sub = buildTree(resolve(dir, d), baseDir, depth + 1, maxDepth);
        lines.push(...sub);
    }
    for (const f of files) {
        if (depth === 0 || INTERESTING_EXTENSIONS.has(extname(f))) {
            lines.push(`${indent}${f}`);
        }
    }
    return lines;
}

function detectTechStack(dir: string): string {
    const pkgPath = resolve(dir, 'package.json');
    if (!existsSync(pkgPath)) return 'No package.json found.';

    try {
        const pkg = parseJsonUtf8File(pkgPath);
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        const parts: string[] = [];

        if (allDeps['@angular/core']) parts.push(`Angular ${allDeps['@angular/core']}`);
        if (allDeps['react']) parts.push(`React ${allDeps['react']}`);
        if (allDeps['vue']) parts.push(`Vue ${allDeps['vue']}`);
        if (allDeps['next']) parts.push(`Next.js ${allDeps['next']}`);
        if (allDeps['svelte']) parts.push(`Svelte ${allDeps['svelte']}`);

        if (allDeps['primeng']) parts.push('PrimeNG');
        if (allDeps['@primeng/themes']) parts.push('PrimeNG Themes');
        if (allDeps['rxjs']) parts.push('RxJS');
        if (allDeps['ngrx'] || allDeps['@ngrx/store']) parts.push('NgRx');
        if (allDeps['express']) parts.push('Express');
        if (allDeps['fastify']) parts.push('Fastify');
        if (allDeps['tailwindcss']) parts.push('Tailwind CSS');
        if (allDeps['vitest']) parts.push('Vitest');
        if (allDeps['jest']) parts.push('Jest');
        if (allDeps['cypress']) parts.push('Cypress');
        if (allDeps['playwright'] || allDeps['@playwright/test']) parts.push('Playwright');
        if (allDeps['typeorm']) parts.push('TypeORM');
        if (allDeps['prisma'] || allDeps['@prisma/client']) parts.push('Prisma');
        if (allDeps['typescript']) parts.push('TypeScript');
        if (allDeps['vite']) parts.push('Vite');

        const name = pkg.name || 'unnamed';
        const desc = pkg.description ? ` — ${pkg.description}` : '';
        return `Project: ${name}${desc}\nStack: ${parts.join(', ') || 'plain JS/TS'}`;
    } catch {
        return 'package.json exists but could not be parsed.';
    }
}

function findKeyFiles(dir: string): string[] {
    const priorities = [
        'src/app/app.component.ts',
        'src/app/app.module.ts',
        'src/app/app.routes.ts',
        'src/app/app.config.ts',
        'src/main.ts',
        'src/index.ts',
        'src/index.tsx',
        'src/App.tsx',
        'src/routes.ts',
        'src/router.ts',
        'pages/index.tsx',
        'pages/_app.tsx',
        'app/layout.tsx',
        'app/page.tsx',
        'src/server/index.ts',
        'server/index.ts',
        'api/index.ts',
    ];

    const found: string[] = [];
    for (const p of priorities) {
        if (existsSync(resolve(dir, p))) found.push(p);
        if (found.length >= 3) break;
    }

    const srcDir = resolve(dir, 'src');
    if (existsSync(srcDir)) {
        try {
            collectInterestingFiles(srcDir, dir, found, 0);
        } catch { /* best effort */ }
    }

    return found.slice(0, MAX_FILES_SAMPLED);
}

function collectInterestingFiles(dir: string, baseDir: string, result: string[], depth: number): void {
    if (depth > 3 || result.length >= MAX_FILES_SAMPLED) return;
    let entries: string[];
    try { entries = readdirSync(dir).sort(); } catch { return; }

    for (const entry of entries) {
        if (result.length >= MAX_FILES_SAMPLED) return;
        const full = resolve(dir, entry);
        let stat;
        try { stat = statSync(full); } catch { continue; }

        if (stat.isDirectory()) {
            if (!SKIP_DIRS.has(entry) && !entry.startsWith('.')) {
                collectInterestingFiles(full, baseDir, result, depth + 1);
            }
        } else {
            const rel = relative(baseDir, full).replace(/\\/g, '/');
            if (result.includes(rel)) continue;
            const ext = extname(entry);
            const name = basename(entry, ext);
            const isService = /\.(service|controller|resolver|guard|interceptor|middleware|pipe|module|routes?|model|schema|entity|store|reducer|effect|component)$/i.test(name);
            if (isService && INTERESTING_EXTENSIONS.has(ext)) {
                result.push(rel);
            }
        }
    }
}

function extractExports(filePath: string): string[] {
    try {
        const content = readFileSync(filePath, 'utf-8');
        const exports: string[] = [];
        const lines = content.split('\n');
        for (const line of lines) {
            const match = line.match(/^export\s+(?:default\s+)?(?:abstract\s+)?(?:class|function|const|interface|type|enum)\s+(\w+)/);
            if (match) exports.push(match[1]);
            const reExport = line.match(/^export\s+\{([^}]+)\}/);
            if (reExport) {
                exports.push(...reExport[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean));
            }
        }
        return exports;
    } catch { return []; }
}

function detectPatterns(dir: string): string {
    const parts: string[] = [];

    if (existsSync(resolve(dir, 'angular.json'))) parts.push('Angular CLI project');
    if (existsSync(resolve(dir, 'next.config.js')) || existsSync(resolve(dir, 'next.config.ts'))) parts.push('Next.js project');
    if (existsSync(resolve(dir, 'nuxt.config.ts'))) parts.push('Nuxt project');
    if (existsSync(resolve(dir, 'vite.config.ts'))) parts.push('Vite build');

    const tsconfig = resolve(dir, 'tsconfig.json');
    if (existsSync(tsconfig)) {
        try {
            const tc = parseJsonUtf8File(tsconfig);
            const paths = tc.compilerOptions?.paths;
            if (paths) {
                const aliases = Object.keys(paths).slice(0, 5).join(', ');
                parts.push(`Path aliases: ${aliases}`);
            }
            if (tc.compilerOptions?.strict) parts.push('Strict TypeScript');
        } catch { /* skip */ }
    }

    if (existsSync(resolve(dir, 'cypress'))) parts.push('Cypress test suite');
    if (existsSync(resolve(dir, 'e2e'))) parts.push('E2E test folder');

    return parts.join(' | ');
}

export async function buildRepoContext(workspaceDir: string): Promise<string> {
    const sections: string[] = [];

    const techStack = detectTechStack(workspaceDir);
    if (techStack) sections.push(`### Tech Stack\n${techStack}`);

    const patterns = detectPatterns(workspaceDir);
    if (patterns) sections.push(`### Patterns\n${patterns}`);

    const treeLines = buildTree(workspaceDir, workspaceDir);
    if (treeLines.length > 0) {
        const truncatedTree = treeLines.slice(0, 60).join('\n');
        sections.push(`### Directory Structure\n${truncatedTree}${treeLines.length > 60 ? '\n... (truncated)' : ''}`);
    }

    const keyFiles = findKeyFiles(workspaceDir);
    if (keyFiles.length > 0) {
        const exportLines: string[] = [];
        for (const f of keyFiles) {
            const exports = extractExports(resolve(workspaceDir, f));
            if (exports.length > 0) {
                exportLines.push(`${f}: ${exports.join(', ')}`);
            } else {
                exportLines.push(f);
            }
        }
        sections.push(`### Key Files & Exports\n${exportLines.join('\n')}`);
    }

    let result = sections.join('\n\n');
    if (result.length > MAX_CONTEXT_CHARS) {
        result = result.slice(0, MAX_CONTEXT_CHARS - 20) + '\n... (truncated)';
    }
    return result;
}
