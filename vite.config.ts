import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { config as loadDotenv } from 'dotenv';
import { readFileSync, statSync } from 'fs';

loadDotenv({ path: resolve(__dirname, '.env') });

const IS_TAURI = !!process.env.TAURI_ENV_PLATFORM;
// SDLC_API_HOST: override when proxying to a container ('server' in Docker Compose)
const API_HOST = process.env.SDLC_API_HOST || 'localhost';

// Derive the API and Vite ports using the same algorithm as worktree-port.ts.
// Reads .sdlc-framework/.dev-port if the server already wrote it; otherwise computes inline.
// This keeps Vite's proxy target and server port in sync across all worktrees.
function _djb2(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) & 0xffff;
    return Math.abs(h);
}
function _devApiPort(): number {
    if (process.env.SDLC_API_PORT) return Number(process.env.SDLC_API_PORT);
    try {
        const stored = readFileSync(resolve(__dirname, '.sdlc-framework/.dev-port'), 'utf-8').trim();
        if (stored) return Number(stored);
    } catch { /* file not written yet */ }
    try {
        const ports = JSON.parse(readFileSync(resolve(__dirname, '.sdlc-framework/docker-ports.json'), 'utf-8')) as { serverPort?: number };
        if (ports.serverPort) return Number(ports.serverPort);
    } catch { /* file not written yet */ }
    try { if (statSync(resolve(__dirname, '.git')).isDirectory()) return 3001; } catch {}
    const name = __dirname.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '';
    return 3100 + (_djb2(name) % 900);
}
const API_PORT = _devApiPort();
const VITE_PORT = process.env.SDLC_VITE_PORT
    ? Number(process.env.SDLC_VITE_PORT)
    : API_PORT === 3001 ? 3847 : API_PORT + 1000;

export default defineConfig({
    plugins: [react()],
    root: __dirname,
    clearScreen: false,
    server: {
        port: VITE_PORT,
        strictPort: true,
        open: !IS_TAURI,
        proxy: {
            '/api': {
                target: `http://${API_HOST}:${API_PORT}`,
                changeOrigin: true,
            },
        },
    },
    envPrefix: ['VITE_', 'TAURI_ENV_*'],
    build: {
        outDir: 'dist',
        target: IS_TAURI ? ['es2021', 'chrome100', 'safari14'] : 'esnext',
        minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
        sourcemap: !!process.env.TAURI_ENV_DEBUG,
        chunkSizeWarningLimit: 1100,
        rollupOptions: {
            output: {
                manualChunks(id: string) {
                    if (id.includes('node_modules/three') || id.includes('node_modules/@react-three')) {
                        return 'vendor-three';
                    }
                    if (
                        id.includes('node_modules/react-dom') ||
                        id.includes('node_modules/react/') ||
                        id.includes('node_modules/react-markdown') ||
                        id.includes('node_modules/remark') ||
                        id.includes('node_modules/rehype') ||
                        id.includes('node_modules/unified') ||
                        id.includes('node_modules/hast') ||
                        id.includes('node_modules/mdast') ||
                        id.includes('node_modules/micromark') ||
                        id.includes('node_modules/vfile') ||
                        id.includes('node_modules/unist')
                    ) {
                        return 'vendor-react';
                    }
                },
            },
        },
    },
    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: [resolve(__dirname, 'src/test/setup.ts')],
        exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**', '**/.sdlc-framework/**'],
    },
});
