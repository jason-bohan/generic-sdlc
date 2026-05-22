import { execFileSync } from 'child_process';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface CypressFailure {
    spec: string;
    test: string;
    error: string;
}

interface CypressRunResult {
    success: boolean;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    failures: CypressFailure[];
    durationMs: number;
    error?: string;
}

interface MochawesomeResult {
    stats: {
        tests: number;
        passes: number;
        failures: number;
        pending: number;
        duration: number;
    };
    results: Array<{
        file: string;
        suites: Array<{
            title: string;
            tests: Array<{
                title: string;
                pass: boolean;
                fail: boolean;
                pending: boolean;
                err?: { message?: string; estack?: string };
            }>;
            suites?: Array<{
                title: string;
                tests: Array<{
                    title: string;
                    pass: boolean;
                    fail: boolean;
                    pending: boolean;
                    err?: { message?: string; estack?: string };
                }>;
            }>;
        }>;
    }>;
}

function findLatestReport(reportDir: string): string | null {
    if (!existsSync(reportDir)) return null;

    const files = readdirSync(reportDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse();

    return files.length > 0 ? resolve(reportDir, files[0]) : null;
}

function extractFailures(data: MochawesomeResult): CypressFailure[] {
    const failures: CypressFailure[] = [];

    for (const result of data.results) {
        const spec = result.file ?? 'unknown';

        function walkSuite(suite: MochawesomeResult['results'][0]['suites'][0]) {
            for (const test of suite.tests) {
                if (test.fail && test.err) {
                    failures.push({
                        spec,
                        test: test.title,
                        error: test.err.message ?? test.err.estack ?? 'Unknown error',
                    });
                }
            }
            if (suite.suites) {
                for (const nested of suite.suites) {
                    walkSuite(nested);
                }
            }
        }

        for (const suite of result.suites) {
            walkSuite(suite);
        }
    }

    return failures;
}

function runCypress(specPattern: string, env: string): CypressRunResult {
    const integrationTestDir = resolve(__dirname, '../../../../integration_test');
    const reportDir = resolve(integrationTestDir, 'build_output/mochawesome/reports/.jsons');
    const start = Date.now();

    try {
        execFileSync('npx', [
            'cypress', 'run',
            '--spec', specPattern,
            '--reporter', 'cypress-mochawesome-reporter',
            '--reporter-options', 'reportDir=build_output/mochawesome/reports/.jsons,json=true,html=false',
        ], {
            cwd: integrationTestDir,
            env: { ...process.env, TESTENV: env },
            stdio: 'pipe',
            timeout: 300_000,
            shell: false,
        });
    } catch (execErr: unknown) {
        const code = (execErr as { status?: number }).status;
        if (code === undefined || code === null) {
            console.error('Cypress process error:', execErr instanceof Error ? execErr.message : String(execErr));
        }
    }

    const durationMs = Date.now() - start;
    const reportFile = findLatestReport(reportDir);

    if (!reportFile) {
        return {
            success: false,
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            failures: [],
            durationMs,
            error: 'No Mochawesome report found after run',
        };
    }

    try {
        const raw = readFileSync(reportFile, 'utf-8');
        const data: MochawesomeResult = JSON.parse(raw);
        const failures = extractFailures(data);

        return {
            success: data.stats.failures === 0,
            total: data.stats.tests,
            passed: data.stats.passes,
            failed: data.stats.failures,
            skipped: data.stats.pending,
            failures,
            durationMs,
        };
    } catch (err) {
        return {
            success: false,
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            failures: [],
            durationMs,
            error: `Failed to parse report: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

function parseArgs(args: string[]): { spec: string; env: string } {
    let spec = './cypress/integration/**/*';
    let env = 'local';

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--spec':
                if (i + 1 < args.length) spec = args[++i];
                break;
            case '--env':
                if (i + 1 < args.length) env = args[++i];
                break;
        }
    }

    return { spec, env };
}

const cliArgs = process.argv.slice(2);

if (cliArgs.includes('--help')) {
    console.log(`
SDLC Framework Cypress Runner

Usage:
  npx tsx src/scripts/cypress-runner.ts [options]

Options:
  --spec <pattern>   Spec file pattern (default: ./cypress/integration/**/*.*)
  --env <name>       Test environment (default: local)
  --help             Show this help

Output:
  JSON result to stdout with: success, total, passed, failed, skipped, failures[], durationMs
`);
    process.exit(0);
}

const { spec, env } = parseArgs(cliArgs);
const result = runCypress(spec, env);
console.log(JSON.stringify(result, null, 2));
process.exit(result.success ? 0 : 1);
