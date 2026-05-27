import 'dotenv/config';
import { createInterface } from 'readline';

type Provider = 'mlx' | 'ollama' | 'meshllm';

interface Options {
    provider: Provider;
    host?: string;
    model?: string;
    prompt?: string;
    list: boolean;
    maxTokens: number;
    temperature: number;
}

function usage(): never {
    console.log(`Usage: chatllm [options] [message]

Options:
  --provider <name>       mlx, ollama, or meshllm (default: mlx)
  --host <url>            OpenAI-compatible base URL
  --model <id>            Model id/path
  --list                  List models and exit
  --max-tokens <n>        Max output tokens (default: 1024)
  --temperature <n>       Temperature (default: 0.2)
  -h, --help              Show help

Examples:
  chatllm --list
  chatllm "write a small TypeScript parser"
  chatllm --provider mlx --model mlx-community/Qwen2.5-Coder-14B-Instruct-4bit
`);
    process.exit(0);
}

function parseArgs(argv: string[]): Options {
    const opts: Options = { provider: 'mlx', list: false, maxTokens: 1024, temperature: 0.2 };
    const message: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => {
            const value = argv[++i];
            if (!value) throw new Error(`${arg} requires a value`);
            return value;
        };
        if (arg === '-h' || arg === '--help') usage();
        else if (arg === '--list') opts.list = true;
        else if (arg === '--provider') {
            const provider = next() as Provider;
            if (!['mlx', 'ollama', 'meshllm'].includes(provider)) throw new Error(`Unsupported provider: ${provider}`);
            opts.provider = provider;
        } else if (arg === '--host') opts.host = next();
        else if (arg === '--model') opts.model = next();
        else if (arg === '--max-tokens') opts.maxTokens = Number(next());
        else if (arg === '--temperature') opts.temperature = Number(next());
        else message.push(arg);
    }
    if (message.length > 0) opts.prompt = message.join(' ');
    return opts;
}

function providerHost(opts: Options): string {
    if (opts.host) return opts.host;
    if (opts.provider === 'ollama') return process.env.OLLAMA_OPENAI_HOST || 'http://localhost:11434/v1';
    if (opts.provider === 'meshllm') return process.env.MESHLLM_HOST?.endsWith('/v1') ? process.env.MESHLLM_HOST : `${process.env.MESHLLM_HOST || 'http://localhost:9337'}/v1`;
    const mlxHost = process.env.MLX_HOST_14B || process.env.MLX_HOST || 'http://localhost:8083';
    return mlxHost.endsWith('/v1') ? mlxHost : `${mlxHost}/v1`;
}

async function models(baseUrl: string): Promise<string[]> {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`Model list failed: ${res.status} ${res.statusText}`);
    const data = await res.json() as { data?: Array<{ id: string }>; models?: Array<{ id: string } | string> };
    return (data.data ?? data.models ?? [])
        .map(m => typeof m === 'string' ? m : m.id)
        .filter(Boolean);
}

function fallbackModel(opts: Options, available: string[]): string {
    if (opts.model) return opts.model;
    if (available[0]) return available[0];
    if (opts.provider === 'ollama') return process.env.OLLAMA_MODEL || 'qwen2.5-coder:14b';
    if (opts.provider === 'meshllm') return process.env.MESHLLM_MODEL || 'auto';
    return process.env.MLX_MODEL_14B || process.env.MLX_MODEL || 'mlx-community/Qwen2.5-Coder-14B-Instruct-4bit';
}

async function complete(baseUrl: string, model: string, messages: Array<{ role: string; content: string }>, opts: Options): Promise<string> {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages,
            max_tokens: opts.maxTokens,
            temperature: opts.temperature,
        }),
    });
    if (!res.ok) throw new Error(`Chat failed: ${res.status} ${res.statusText}\n${await res.text()}`);
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? '';
}

async function readPipe(): Promise<string | null> {
    if (process.stdin.isTTY) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8').trim();
    return text || null;
}

async function interactive(baseUrl: string, model: string, opts: Options) {
    const history = [{ role: 'system', content: 'You are a concise local coding assistant.' }];
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'chatllm> ' });
    console.log(`chatllm provider=${opts.provider} model=${model}`);
    console.log('Type /exit to quit.');
    rl.prompt();
    rl.on('line', async (line) => {
        const text = line.trim();
        if (!text) { rl.prompt(); return; }
        if (text === '/exit' || text === '/quit') { rl.close(); return; }
        history.push({ role: 'user', content: text });
        try {
            const reply = await complete(baseUrl, model, history, opts);
            history.push({ role: 'assistant', content: reply });
            console.log(reply);
        } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
        }
        rl.prompt();
    });
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const baseUrl = providerHost(opts);
    const available = await models(baseUrl).catch(() => []);
    if (opts.list) {
        if (available.length === 0) {
            console.log(`No models reported by ${baseUrl}`);
            return;
        }
        for (const model of available) console.log(model);
        return;
    }
    const model = fallbackModel(opts, available);
    const prompt = opts.prompt || await readPipe();
    if (!prompt) {
        await interactive(baseUrl, model, opts);
        return;
    }
    console.log(await complete(baseUrl, model, [
        { role: 'system', content: 'You are a concise local coding assistant.' },
        { role: 'user', content: prompt },
    ], opts));
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
