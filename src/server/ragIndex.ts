/**
 * Semantic codebase indexer using nomic-embed-text via Ollama.
 * Builds a per-workspace vector index and retrieves relevant code chunks
 * at story-creation time to ground LLM output in real file references.
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { resolve, relative, extname, basename } from 'path';
import { EMBEDDING_MODEL } from './ollamaManager';
import { ragLog as log } from './logger';

// ─── Tunables ────────────────────────────────────────────────────────────────

const MAX_CHUNKS = 400;
const MAX_CHUNK_CHARS = 800;   // ~200 tokens — keeps RAG context within num_ctx budget
const CHUNK_OVERLAP_LINES = 3;
const TOP_K = 5;
const INDEX_TTL_MS = 24 * 60 * 60 * 1000; // rebuild after 24 h

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', '.angular',
    'coverage', '.cache', '.turbo', '__pycache__', '.venv',
    '.agent-output', '.sdlc-framework',
]);

const INDEXABLE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte',
    '.cs', '.java', '.py', '.go', '.rs',
    '.html', '.scss', '.css',
]);

// ─── Types ───────────────────────────────────────────────────────────────────

interface RagChunk {
    path: string;       // relative to workspaceDir
    text: string;       // chunk content (includes path header)
    embedding: number[];
}

interface RagIndex {
    workspaceDir: string;
    builtAt: string;
    embeddingModel: string;
    chunks: RagChunk[];
}

// ─── File collection & chunking ──────────────────────────────────────────────

function collectFiles(dir: string, base: string, result: string[], depth = 0): void {
    if (depth > 5 || result.length > MAX_CHUNKS * 2) return;
    let entries: string[];
    try { entries = readdirSync(dir).sort(); } catch { return; }
    for (const entry of entries) {
        if (entry.startsWith('.') && depth === 0) continue;
        const full = resolve(dir, entry);
        let stat;
        try { stat = statSync(full); } catch { continue; }
        if (stat.isDirectory()) {
            if (!SKIP_DIRS.has(entry)) collectFiles(full, base, result, depth + 1);
        } else if (INDEXABLE_EXTENSIONS.has(extname(entry))) {
            result.push(relative(base, full).replace(/\\/g, '/'));
        }
    }
}

/** Split a TypeScript/JS file into export-boundary chunks. */
function chunkTypeScript(content: string, path: string): string[] {
    const lines = content.split('\n');
    const chunks: string[] = [];
    let current: string[] = [];

    for (const line of lines) {
        const isExportBoundary = /^export\s+(default\s+)?(async\s+)?(?:function|class|const|interface|type|enum|abstract)/.test(line);
        if (isExportBoundary && current.length > 5) {
            const text = current.join('\n').trim();
            if (text.length > 30) chunks.push(`// ${path}\n${text}`);
            current = [line];
        } else {
            current.push(line);
        }
        if (current.length >= 60) {
            // Force flush to avoid huge chunks
            const text = current.join('\n').trim();
            if (text.length > 30) chunks.push(`// ${path}\n${text}`);
            current = current.slice(-CHUNK_OVERLAP_LINES);
        }
    }
    if (current.length > 3) {
        const text = current.join('\n').trim();
        if (text.length > 30) chunks.push(`// ${path}\n${text}`);
    }

    return chunks.map((c) => c.slice(0, MAX_CHUNK_CHARS));
}

function chunkFile(filePath: string, relativePath: string): string[] {
    let content: string;
    try { content = readFileSync(filePath, 'utf-8'); } catch { return []; }

    const ext = extname(filePath);
    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
        return chunkTypeScript(content, relativePath);
    }
    // For other files: one chunk = first MAX_CHUNK_CHARS chars
    const text = content.trim().slice(0, MAX_CHUNK_CHARS);
    return text.length > 30 ? [`// ${relativePath}\n${text}`] : [];
}

// ─── Embedding ───────────────────────────────────────────────────────────────

function normalizeHost(raw: string): string {
    const withProto = (raw.startsWith('http://') || raw.startsWith('https://')) ? raw : `http://${raw}`;
    const normalized = withProto.replace('://0.0.0.0', '://127.0.0.1');
    try {
        const url = new URL(normalized);
        if (!url.port) url.port = '11434';
        return url.origin;
    } catch {
        return 'http://localhost:11434';
    }
}

async function embed(text: string, ollamaHost: string): Promise<number[] | null> {
    const host = normalizeHost(ollamaHost);
    try {
        const res = await fetch(`${host}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text }),
            signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) return null;
        const data: any = await res.json();
        return data.embedding ?? null;
    } catch { return null; }
}

// ─── Cosine similarity ───────────────────────────────────────────────────────

function cosineSim(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

// ─── Index persistence ───────────────────────────────────────────────────────

function indexPath(workspaceDir: string, sdlc-frameworkDir: string): string {
    const hash = createHash('md5').update(workspaceDir).digest('hex').slice(0, 8);
    return resolve(sdlc-frameworkDir, `.sdlc-framework`, `rag-${hash}.json`);
}

function loadIndex(workspaceDir: string, sdlc-frameworkDir: string): RagIndex | null {
    try {
        const raw = readFileSync(indexPath(workspaceDir, sdlc-frameworkDir), 'utf-8');
        const idx: RagIndex = JSON.parse(raw);
        const age = Date.now() - new Date(idx.builtAt).getTime();
        if (age > INDEX_TTL_MS) return null;   // stale
        if (idx.embeddingModel !== EMBEDDING_MODEL) return null;  // model changed
        return idx;
    } catch { return null; }
}

function saveIndex(idx: RagIndex, sdlc-frameworkDir: string): void {
    try {
        const dir = resolve(sdlc-frameworkDir, '.sdlc-framework');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(indexPath(idx.workspaceDir, sdlc-frameworkDir), JSON.stringify(idx));
    } catch { /* non-fatal */ }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build (or load cached) a vector index for `workspaceDir`.
 * `sdlc-frameworkDir` is the SDLC Framework root (__dirname from vite.config) where .sdlc-framework/ lives.
 */
export async function buildRagIndex(
    workspaceDir: string,
    sdlc-frameworkDir: string,
    ollamaHost: string,
): Promise<RagIndex | null> {
    const cached = loadIndex(workspaceDir, sdlc-frameworkDir);
    if (cached) {
        log.info(`Loaded cached index for ${workspaceDir} (${cached.chunks.length} chunks)`);
        return cached;
    }

    log.info(`Building index for ${workspaceDir}...`);
    const files: string[] = [];
    collectFiles(workspaceDir, workspaceDir, files);

    const chunks: RagChunk[] = [];
    for (const relPath of files) {
        if (chunks.length >= MAX_CHUNKS) break;
        const texts = chunkFile(resolve(workspaceDir, relPath), relPath);
        for (const text of texts) {
            if (chunks.length >= MAX_CHUNKS) break;
            const embedding = await embed(text, ollamaHost);
            if (embedding) chunks.push({ path: relPath, text, embedding });
        }
    }

    if (chunks.length === 0) {
        log.warn('No chunks embedded — nomic-embed-text may be unavailable');
        return null;
    }

    const idx: RagIndex = {
        workspaceDir,
        builtAt: new Date().toISOString(),
        embeddingModel: EMBEDDING_MODEL,
        chunks,
    };
    saveIndex(idx, sdlc-frameworkDir);
    log.info(`Index built: ${chunks.length} chunks from ${files.length} files`);
    return idx;
}

/**
 * Embed a query and return the top-K most relevant chunks as a formatted string.
 * Returns null if RAG is unavailable (embedding model offline, no index, etc.).
 */
export async function ragQuery(
    workspaceDir: string,
    sdlc-frameworkDir: string,
    query: string,
    ollamaHost: string,
    topK = TOP_K,
): Promise<string | null> {
    let idx: RagIndex | null;
    try {
        idx = await buildRagIndex(workspaceDir, sdlc-frameworkDir, ollamaHost);
    } catch { return null; }
    if (!idx || idx.chunks.length === 0) return null;

    const queryEmbedding = await embed(query, ollamaHost);
    if (!queryEmbedding) return null;

    const scored = idx.chunks
        .map((chunk) => ({ chunk, score: cosineSim(queryEmbedding, chunk.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

    const formatted = scored
        .map(({ chunk }) => chunk.text)
        .join('\n\n---\n\n');

    return `## Relevant codebase context (${scored.length} chunks)\n\n${formatted}`;
}
