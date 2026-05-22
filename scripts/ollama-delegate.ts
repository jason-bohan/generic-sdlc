import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface OllamaConfig {
    baseUrl: string;
    model: string;
    timeoutMs: number;
    maxRetries: number;
}

interface DelegateOptions {
    promptFile?: string;
    promptText?: string;
    context?: string;
    contextFile?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
}

interface OllamaResponse {
    model: string;
    response: string;
    done: boolean;
    total_duration?: number;
    prompt_eval_count?: number;
    eval_count?: number;
}

interface DelegateResult {
    success: boolean;
    output: string;
    tokens: { input: number; output: number };
    model: string;
    durationMs: number;
    error?: string;
}

const DEFAULT_CONFIG: OllamaConfig = {
    baseUrl: 'http://localhost:11434',
    model: 'deepseek-coder:6.7b',
    timeoutMs: 60000,
    maxRetries: 2,
};

function loadConfig(): OllamaConfig {
    const configPath = resolve(__dirname, '../../config/defaults.json');
    if (existsSync(configPath)) {
        try {
            const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
            const cfg = raw?.ollama;
            if (cfg && typeof cfg.baseUrl === 'string' && typeof cfg.model === 'string') {
                return { ...DEFAULT_CONFIG, ...cfg };
            }
        } catch {
            console.error(`Warning: failed to parse ${configPath}, using defaults`);
        }
    }
    return DEFAULT_CONFIG;
}

function loadPromptTemplate(promptFile: string): string {
    const promptPath = resolve(__dirname, '../../prompts', promptFile);
    if (!existsSync(promptPath)) {
        throw new Error(`Prompt template not found: ${promptPath}`);
    }
    return readFileSync(promptPath, 'utf-8');
}

function buildPrompt(options: DelegateOptions): string {
    let prompt = '';

    if (options.promptFile) {
        prompt = loadPromptTemplate(options.promptFile);
    } else if (options.promptText) {
        prompt = options.promptText;
    } else {
        throw new Error('Either --prompt-file or --prompt-text is required');
    }

    let context = '';
    if (options.contextFile) {
        const ctxPath = resolve(process.cwd(), options.contextFile);
        if (existsSync(ctxPath)) {
            context = readFileSync(ctxPath, 'utf-8');
        }
    } else if (options.context) {
        context = options.context;
    }

    if (context) {
        prompt = prompt.replace('{{CONTEXT}}', context);

        if (!prompt.includes(context)) {
            prompt += `\n\n## Context\n\n\`\`\`\n${context}\n\`\`\``;
        }
    }

    return prompt;
}

async function checkOllamaHealth(baseUrl: string): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
        clearTimeout(timeout);
        return res.ok;
    } catch {
        return false;
    }
}

async function generate(config: OllamaConfig, prompt: string, options: DelegateOptions): Promise<DelegateResult> {
    const model = options.model ?? config.model;
    const start = Date.now();

    const body = {
        model,
        prompt,
        stream: false,
        options: {
            temperature: options.temperature ?? 0.2,
            ...(options.maxTokens ? { num_predict: options.maxTokens } : {}),
        },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
        const res = await fetch(`${config.baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
            const text = await res.text();
            return {
                success: false,
                output: '',
                tokens: { input: 0, output: 0 },
                model,
                durationMs: Date.now() - start,
                error: `Ollama returned HTTP ${res.status}: ${text}`,
            };
        }

        const data = (await res.json()) as OllamaResponse;

        return {
            success: true,
            output: data.response,
            tokens: {
                input: data.prompt_eval_count ?? 0,
                output: data.eval_count ?? 0,
            },
            model,
            durationMs: Date.now() - start,
        };
    } catch (err) {
        clearTimeout(timeout);
        const message = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            output: '',
            tokens: { input: 0, output: 0 },
            model,
            durationMs: Date.now() - start,
            error: message.includes('abort') ? 'Request timed out' : message,
        };
    }
}

const DEFAULT_TOKEN_API = 'http://localhost:3847/api/tokens/update';

async function reportTokens(agentId: string, tokens: { input: number; output: number }): Promise<void> {
    if (tokens.input === 0 && tokens.output === 0) return;
    try {
        const res = await fetch(DEFAULT_TOKEN_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId, source: 'ollama', input: tokens.input, output: tokens.output }),
        });
        if (!res.ok) {
            console.error(`[token-report] POST failed (${res.status}): ${await res.text()}`);
        }
    } catch (e: unknown) {
        console.error(`[token-report] Could not reach token API: ${e instanceof Error ? e.message : String(e)}`);
    }
}

async function delegate(options: DelegateOptions, agentId = 'frontend'): Promise<DelegateResult> {
    const config = loadConfig();

    const healthy = await checkOllamaHealth(config.baseUrl);
    if (!healthy) {
        return {
            success: false,
            output: '',
            tokens: { input: 0, output: 0 },
            model: options.model ?? config.model,
            durationMs: 0,
            error: `Ollama not reachable at ${config.baseUrl}. Is it running? (ollama serve)`,
        };
    }

    const prompt = buildPrompt(options);

    let lastResult: DelegateResult | null = null;
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
        lastResult = await generate(config, prompt, options);
        if (lastResult.success) {
            await reportTokens(agentId, lastResult.tokens);
            return lastResult;
        }

        if (attempt < config.maxRetries) {
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
    }

    return lastResult ?? {
        success: false,
        output: '',
        tokens: { input: 0, output: 0 },
        model: options.model ?? config.model,
        durationMs: 0,
        error: 'All retries exhausted',
    };
}

interface ParsedArgs {
    options: DelegateOptions;
    agentId: string;
}

function parseArgs(args: string[]): ParsedArgs {
    const options: DelegateOptions = {};
    let agentId = 'frontend';
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--prompt-file':
                if (i + 1 < args.length) options.promptFile = args[++i];
                break;
            case '--prompt-text':
                if (i + 1 < args.length) options.promptText = args[++i];
                break;
            case '--context':
                if (i + 1 < args.length) options.context = args[++i];
                break;
            case '--context-file':
                if (i + 1 < args.length) options.contextFile = args[++i];
                break;
            case '--model':
                if (i + 1 < args.length) options.model = args[++i];
                break;
            case '--agent-id':
                if (i + 1 < args.length) agentId = args[++i];
                break;
            case '--temperature': {
                if (i + 1 < args.length) {
                    const temp = parseFloat(args[++i]);
                    if (!Number.isNaN(temp)) options.temperature = temp;
                }
                break;
            }
            case '--max-tokens': {
                if (i + 1 < args.length) {
                    const mt = parseInt(args[++i], 10);
                    if (!Number.isNaN(mt)) options.maxTokens = mt;
                }
                break;
            }
        }
    }
    return { options, agentId };
}

async function healthCheck(): Promise<void> {
    const config = loadConfig();
    const healthy = await checkOllamaHealth(config.baseUrl);

    if (!healthy) {
        console.log(JSON.stringify({
            online: false,
            model: config.model,
            models: [],
            updateAvailable: false,
            lastChecked: new Date().toISOString(),
        }, null, 2));
        process.exit(1);
        return;
    }

    try {
        const res = await fetch(`${config.baseUrl}/api/tags`);
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        const models: string[] = (data.models ?? []).map((m) => m.name);
        const currentModel = models.find((m) => m.includes(config.model.split(':')[0])) ?? models[0];

        console.log(JSON.stringify({
            online: true,
            model: currentModel ?? config.model,
            models,
            updateAvailable: false,
            lastChecked: new Date().toISOString(),
        }, null, 2));
    } catch (e) {
        console.log(JSON.stringify({
            online: true,
            model: config.model,
            models: [],
            updateAvailable: false,
            lastChecked: new Date().toISOString(),
            error: e instanceof Error ? e.message : String(e),
        }, null, 2));
    }
}

const cliArgs = process.argv.slice(2);

if (cliArgs.includes('--health')) {
    healthCheck()
        .then(() => process.exit(0))
        .catch((err: unknown) => {
            console.error('Health check failed:', err instanceof Error ? err.message : String(err));
            process.exit(1);
        });
} else if (cliArgs.includes('--help') || cliArgs.length === 0) {
    console.log(`
SDLC Framework Ollama Delegator

Usage:
  npx tsx src/scripts/ollama-delegate.ts [options]

Options:
  --prompt-file <file>    Prompt template from prompts/ directory
  --prompt-text <text>    Inline prompt text
  --context <text>        Context to inject into prompt
  --context-file <path>   File to read as context
  --model <name>          Ollama model (default: from config)
  --temperature <n>       Temperature 0-1 (default: 0.2)
  --max-tokens <n>        Max output tokens
  --agent-id <id>         Agent ID for token tracking (default: frontend)
  --health                Check Ollama health and list models (JSON)
  --help                  Show this help

Output:
  JSON result to stdout with: success, output, tokens, model, durationMs, error
`);
    process.exit(0);
} else {
    const { options, agentId } = parseArgs(cliArgs);
    delegate(options, agentId)
        .then((result) => {
            console.log(JSON.stringify(result, null, 2));
            process.exit(result.success ? 0 : 1);
        })
        .catch((err: unknown) => {
            console.error('Delegate failed:', err instanceof Error ? err.message : String(err));
            process.exit(1);
        });
}
