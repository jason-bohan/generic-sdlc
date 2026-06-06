/**
 * Worker pool — runs 1-bit models (e.g. Bonsai 8B) on cheap tasks so the
 * 8-bit main model saves context for actual code generation.
 *
 * Workers handle: file summarization, validation output summarization, search.
 * The 8-bit model provides the plan and writes code; workers feed it pre-digested input.
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { detectLoopProvider } from './agent-runner/provider';
import { parseJsonUtf8File } from './json-file';

export interface WorkerPoolOptions {
  /** Model ID for lightweight workers (default: Bonsai 8B 1-bit). */
  workerModel?: string;
  /** MLX proxy or direct MLX server base URL. */
  baseUrl?: string;
  /** Max concurrent worker tasks (Apple Silicon memory ceiling ~2). */
  maxConcurrency?: number;
  /** Fall back to stub summaries when MLX is unavailable (dev/test). */
  allowStubFallback?: boolean;
}

interface QueueItem<T> {
  fn: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

const DEFAULT_BASE_URL = 'http://localhost:8084/v1';
const DEFAULT_WORKER_MODEL = 'prism-ml/Bonsai-8B-mlx-1bit';

export class WorkerPool {
  private workerModel: string;
  private baseUrl: string;
  private maxConcurrency: number;
  private allowStub: boolean;
  private queue: QueueItem<unknown>[] = [];
  private active = 0;
  private running = false;

  constructor(opts?: WorkerPoolOptions) {
    this.workerModel = opts?.workerModel ?? DEFAULT_WORKER_MODEL;
    this.baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;
    this.maxConcurrency = opts?.maxConcurrency ?? 2;
    this.allowStub = opts?.allowStubFallback ?? true;
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /** Read a file's content and summarize it through the worker model. */
  async summarizeFile(path: string, content: string): Promise<string> {
    const system = 'You are a code reader. Summarize the given file in 1-3 sentences. List the key exports, types, classes, and functions defined. Be concise — no explanations, no greetings.';
    const prompt = `File: ${path}\n\n\`\`\`\n${content.slice(0, 4000)}\n\`\`\`\n\nSummarize this file: what does it export, what are the key symbols?`;
    return this.generate(prompt, system, 200);
  }

  /** Summarize command output (e.g. failing tests, lint errors) into actionable items. */
  async summarizeOutput(command: string, stdout: string, stderr: string): Promise<string> {
    const system = 'You read tool output and extract the key signal. Return a bullet list of what failed or needs attention. Ignore noise, timestamps, and progress lines.';
    const output = [stdout.slice(0, 3000), stderr.slice(0, 2000)].filter(Boolean).join('\n');
    if (!output.trim()) return '';
    const prompt = `Command: ${command}\n\nOutput:\n${output}\n\nWhat are the actionable failures or warnings?`;
    return this.generate(prompt, system, 300);
  }

  /** Search results summarizer. */
  async searchAndSummarize(query: string, matches: string[]): Promise<string> {
    const system = 'You group related grep/search results and summarize per-file. Return 2-3 bullet points.';
    const prompt = `Search for: ${query}\n\nMatches:\n${matches.join('\n').slice(0, 3000)}\n\nSummarise the relevant files and locations.`;
    return this.generate(prompt, system, 200);
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private async generate(prompt: string, system: string, maxTokens: number): Promise<string> {
    return this.enqueue(async () => {
      const url = `${this.baseUrl}/chat/completions`;
      const body = JSON.stringify({
        model: this.workerModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: maxTokens,
      });

      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(30_000),
        });
        if (!resp.ok) return this.fallback('summarize', `HTTP ${resp.status}`);

        const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const text = data.choices?.[0]?.message?.content?.trim();
        return text && text.length > 0 ? text : this.fallback('summarize', 'empty response');
      } catch (err) {
        return this.fallback('summarize', String(err));
      }
    });
  }

  private fallback(task: string, reason: string): string {
    if (!this.allowStub) throw new Error(`Worker pool: ${task} failed (${reason})`);
    console.warn(`[workerPool] ${task} failed — ${reason}. Using stub.`);
    return '';
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn: fn as () => Promise<unknown>, resolve: resolve as (v: unknown) => void, reject });
      if (!this.running) this.drain();
    });
  }

  private drain(): void {
    this.running = true;
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.active++;
      item.fn()
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
          this.active--;
          if (this.queue.length > 0) this.drain();
          else if (this.active === 0) this.running = false;
        });
    }
    if (this.active === 0) this.running = false;
  }
}

// ─── Config helpers ──────────────────────────────────────────────────────

export function readWorkerPoolConfig(configPath: string): WorkerPoolOptions {
  if (!existsSync(configPath)) return {};
  try {
    const cfg = parseJsonUtf8File(configPath) as Record<string, unknown>;
    const scheduler = cfg.scheduler as Record<string, unknown> | undefined;
    const wp = scheduler?.workerPool as Record<string, unknown> | undefined;
    if (!wp) return {};
    return {
      workerModel: wp.model as string | undefined,
      baseUrl: wp.baseUrl as string | undefined,
      maxConcurrency: wp.maxConcurrency as number | undefined,
      allowStubFallback: wp.allowStubFallback as boolean | undefined,
    };
  } catch {
    return {};
  }
}

/** Build a pool from the SDLC config path, falling back to env vars then defaults. */
export function createWorkerPool(configPath: string): WorkerPool {
  const fromConfig = readWorkerPoolConfig(configPath);
  const envModel = process.env.WORKER_MODEL;
  const envBaseUrl = process.env.WORKER_BASE_URL;
  return new WorkerPool({
    workerModel: fromConfig.workerModel ?? envModel,
    baseUrl: fromConfig.baseUrl ?? envBaseUrl,
    maxConcurrency: fromConfig.maxConcurrency,
    allowStubFallback: fromConfig.allowStubFallback,
  });
}

// ─── Standalone helpers (no pool needed for one-shot use) ────────────────

let _globalPool: WorkerPool | null = null;

export function getWorkerPool(opts?: WorkerPoolOptions): WorkerPool {
  if (!_globalPool) _globalPool = new WorkerPool(opts);
  return _globalPool;
}

/** Reinitialize the global pool with new options (e.g. after config change). */
export function resetWorkerPool(opts?: WorkerPoolOptions): WorkerPool {
  _globalPool = new WorkerPool(opts);
  return _globalPool;
}

/** Quick one-shot: summarize a file through the worker model. */
export async function workerSummarizeFile(path: string, content: string): Promise<string> {
  return getWorkerPool().summarizeFile(path, content);
}

/** Quick one-shot: validate code and summarize errors. */
export async function workerValidate(command: string, args: string[], cwd: string): Promise<{ ok: boolean; summary: string; stdout: string; stderr: string }> {
  try {
    const stdout = execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 30_000 });
    return { ok: true, summary: '', stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const stderr = e.stderr ?? '';
    const stdout = e.stdout ?? '';
    const summary = await getWorkerPool().summarizeOutput(`${command} ${args.join(' ')}`, stdout || '', stderr || '');
    return { ok: false, summary, stdout, stderr };
  }
}
