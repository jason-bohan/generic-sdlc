import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface MeshllmLaunchStatus {
    canLaunch: boolean;
    source: 'env' | 'docker' | null;
    command?: string;
    reason?: string;
}

interface ResolveDeps {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    rootDir?: string;
    commandExists?: (name: string) => boolean;
    isDockerRunning?: () => boolean;
}

interface StartDeps extends ResolveDeps {
    spawn?: (command: string, options: Parameters<typeof nodeSpawn>[2]) => { unref?: () => void };
    sleep?: (ms: number) => Promise<void>;
    findDockerDesktop?: () => string | undefined;
    imageExists?: (name: string) => boolean;
}

const MESHLLM_IMAGE = 'sdlc-framework-mesh-llm:client';
const MESHLLM_CUDA_IMAGE = 'sdlc-framework-mesh-llm:cuda';
const MESHLLM_BUILD_CMD =
    'DOCKER_BUILDKIT=0 docker build -t sdlc-framework-mesh-llm:client -f docker/Dockerfile.client --build-arg CMD=console https://github.com/Mesh-LLM/mesh-llm.git#main';

const DOCKER_DESKTOP_PATHS = [
    'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
    'C:\\Program Files (x86)\\Docker\\Docker\\Docker Desktop.exe',
];

const DOCKER_READY_POLL_INTERVAL_MS = 2000;
const DOCKER_READY_TIMEOUT_MS       = 60_000;

function defaultIsDockerRunning(): boolean {
    try {
        execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 4000 });
        return true;
    } catch {
        return false;
    }
}

function defaultCommandExists(name: string): boolean {
    const pathParts = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
    const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
    return pathParts.some((part) => extensions.some((ext) => existsSync(resolve(part, `${name}${ext}`))));
}

function defaultImageExists(name: string): boolean {
    try {
        execFileSync('docker', ['image', 'inspect', name], { stdio: 'ignore', timeout: 4000 });
        return true;
    } catch {
        return false;
    }
}

function meshllmDockerCommand(rootDir: string, env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
    const files = ['docker-compose.yml'];
    if (existsSync(resolve(rootDir, 'docker-compose.gpu.yml'))) {
        files.push('docker-compose.gpu.yml');
    }
    if (env.MESHLLM_MODEL && existsSync(resolve(rootDir, 'docker-compose.meshllm-local.yml'))) {
        files.push('docker-compose.meshllm-local.yml');
    }
    const fileArgs = files.map((file) => `-f ${file}`).join(' ');
    return `docker compose ${fileArgs} --profile meshllm up -d meshllm`;
}

export function resolveMeshllmLaunch(deps: ResolveDeps = {}): MeshllmLaunchStatus {
    const env = deps.env ?? process.env;
    const command = env.MESHLLM_START_COMMAND?.trim();
    if (command) {
        return { canLaunch: true, source: 'env', command };
    }

    const commandExists = deps.commandExists ?? defaultCommandExists;
    const isDockerRunning = deps.isDockerRunning ?? defaultIsDockerRunning;
    const rootDir = deps.rootDir ?? process.cwd();
    const composeFile = resolve(rootDir, 'docker-compose.yml');
    if (commandExists('docker') && existsSync(composeFile)) {
        const compose = readFileSync(composeFile, 'utf8');
        if (/^\s{2}meshllm:\s*$/m.test(compose)) {
            if (!isDockerRunning()) {
                return {
                    canLaunch: false,
                    source: 'docker',
                    reason: 'Docker is installed but the daemon is not running. Start Docker Desktop then try again.',
                };
            }
            return {
                canLaunch: true,
                source: 'docker',
                command: meshllmDockerCommand(rootDir, env),
            };
        }
    }

    if (commandExists('meshllm')) {
        return {
            canLaunch: false,
            source: null,
            reason: 'meshllm is on PATH, but SDLC Framework needs MESHLLM_START_COMMAND so it knows the exact server arguments.',
        };
    }

    return {
        canLaunch: false,
        source: null,
        reason: 'Set MESHLLM_START_COMMAND to the command that starts your MeshLLM OpenAI-compatible server on port 9337.',
    };
}

/**
 * Finds and launches Docker Desktop, then polls until the daemon responds.
 * Returns true if the daemon is ready within the timeout.
 */
export async function ensureDockerRunning(deps: StartDeps = {}): Promise<boolean> {
    const isDockerRunning = deps.isDockerRunning ?? defaultIsDockerRunning;
    const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    if (isDockerRunning()) return true;

    // Default finder only searches for Docker Desktop on Windows; injectable for tests
    const findDockerDesktop =
        deps.findDockerDesktop ??
        (() => (process.platform === 'win32' ? DOCKER_DESKTOP_PATHS.find(existsSync) : undefined));
    const exePath = findDockerDesktop();
    if (!exePath) return false;

    // Launch Docker Desktop detached — it takes time to start the daemon
    const spawnFn = deps.spawn ?? nodeSpawn;
    spawnFn(`"${exePath}"`, { shell: true, detached: true, stdio: 'ignore' }).unref?.();

    // Poll until daemon is ready or timeout
    const deadline = Date.now() + DOCKER_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await sleep(DOCKER_READY_POLL_INTERVAL_MS);
        if (isDockerRunning()) return true;
    }

    return false;
}

export async function startMeshllm(rootDir: string, deps: StartDeps = {}) {
    const isDockerRunning = deps.isDockerRunning ?? defaultIsDockerRunning;

    // If Docker is the source but isn't running, attempt to start Docker Desktop first
    const preCheck = resolveMeshllmLaunch({ ...deps, rootDir });
    if (preCheck.source === 'docker' && !preCheck.canLaunch) {
        const started = await ensureDockerRunning(deps);
        if (!started) {
            return {
                ok: false,
                reason: 'Could not start Docker Desktop automatically. Please start it manually and try again.',
            };
        }
    }

    const status = resolveMeshllmLaunch({ ...deps, rootDir, isDockerRunning: () => true });
    if (!status.canLaunch || !status.command) {
        return { ok: false, status, reason: status.reason };
    }

    // Image must be pre-built on the host via `docker-up.ps1 -MeshLLM`.
    // The server container cannot build it (BuildKit unavailable in docker-cli-compose).
    const imageExistsFn = deps.imageExists ?? defaultImageExists;
    const expectedImage = process.env.MESHLLM_IMAGE || (process.env.MESHLLM_MODEL ? MESHLLM_CUDA_IMAGE : MESHLLM_IMAGE);
    if (status.source === 'docker' && !imageExistsFn(expectedImage)) {
        return {
            ok: false,
            status,
            reason: `MeshLLM image ${expectedImage} not built yet. Run: .\\bin\\docker-up.ps1 -MeshLLM`,
        };
    }
    const launchCmd = status.command;

    const outputDir = resolve(rootDir, '.agent-output');
    mkdirSync(outputDir, { recursive: true });
    const child = (deps.spawn ?? nodeSpawn)(launchCmd, {
        cwd: rootDir,
        detached: true,
        shell: true,
        stdio: 'ignore',
        windowsHide: true,
        env: process.env,
    });
    child.unref?.();

    return {
        ok: true,
        status,
        message: 'MeshLLM launch command started. Health will turn green once /v1/models responds.',
    };
}
