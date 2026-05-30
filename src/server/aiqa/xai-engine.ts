import { existsSync } from 'fs';
import { resolve } from 'path';
import { spawn } from 'child_process';
import { getActiveProject } from '../project-config';

export interface XaiProfile {
  id?: string | number;
  [key: string]: unknown;
}

export interface XaiConfig {
  featureNames?: string[];
  nSamples?: number;
  decisionFn: string | Array<{ feature: string; op: string; value: number }>;
}

export interface ReasonCode {
  code: string;
  feature: string;
  reason: string;
}

export interface XaiExplanation {
  profileIndex: number;
  profileId: string | number | undefined;
  prediction: boolean;
  baseValue: number;
  topContributors: Array<{
    feature: string;
    shapValue: number;
    featureValue: number;
    impact: string;
    magnitude: number;
  }>;
  reasonCodes: ReasonCode[];
}

export interface XaiFeatureImportance {
  [feature: string]: number;
}

export interface XaiResult {
  status: 'ok' | 'missing_dependency' | 'error';
  error?: string;
  missingPackage?: string;
  modelType?: string;
  featureNames?: string[];
  featureImportance?: XaiFeatureImportance;
  baseValue?: number;
  explanations?: XaiExplanation[];
  reasonCodeMap?: Record<string, string>;
  nProfiles?: number;
  nExplained?: number;
}

export interface XaiOptions {
  scriptPath?: string;
  timeoutMs?: number;
}

const DEFAULT_OPTIONS: Required<XaiOptions> = {
  scriptPath: 'scripts/xai-explainer.py',
  timeoutMs: 60000,
};

export async function runXaiExplainer(
  profiles: XaiProfile[],
  config: XaiConfig,
  options?: XaiOptions,
): Promise<XaiResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const script = resolve(process.cwd(), opts.scriptPath);

  if (!existsSync(script)) {
    return {
      status: 'error',
      error: `XAI script not found at ${script}. Ensure scripts/xai-explainer.py exists.`,
    };
  }

  const input = JSON.stringify({
    profiles,
    featureNames: config.featureNames ?? [],
    decisionFn: config.decisionFn,
    nSamples: config.nSamples ?? 100,
  });

  const python = process.platform === 'win32' ? 'python' : 'python3';

  return new Promise((resolvePromise) => {
    const child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];

    const timeout = setTimeout(() => {
      child.kill();
      resolvePromise({
        status: 'error',
        error: `XAI script timed out after ${opts.timeoutMs}ms`,
      });
    }, opts.timeoutMs);

    child.stdout?.on('data', (data: Buffer) => chunks.push(data));
    child.stderr?.on('data', (data: Buffer) => errorChunks.push(data));

    child.on('close', (code) => {
      clearTimeout(timeout);
      const stdout = Buffer.concat(chunks).toString();
      const stderr = Buffer.concat(errorChunks).toString();

      if (code !== 0 && !stdout.trim()) {
        resolvePromise({
          status: 'error',
          error: `XAI script exited code ${code}: ${stderr || 'Unknown error'}`,
        });
        return;
      }

      try {
        const result = JSON.parse(stdout) as XaiResult;
        resolvePromise(result);
      } catch {
        resolvePromise({
          status: 'error',
          error: `Failed to parse XAI script output: ${stdout.slice(0, 500)}${stderr ? `\nStderr: ${stderr.slice(0, 500)}` : ''}`,
        });
      }
    });

    child.stdin?.write(input);
    child.stdin?.end();
  });
}

export function generateSyntheticProfiles(
  baseProfile: Record<string, number>,
  variations: number = 10,
  featureToVary?: string,
  varyRange?: [number, number],
): XaiProfile[] {
  const profiles: XaiProfile[] = [];
  for (let i = 0; i < variations; i++) {
    const profile: Record<string, number> = { ...baseProfile, id: i };
    if (featureToVary && varyRange) {
      const step = (varyRange[1] - varyRange[0]) / Math.max(1, variations - 1);
      profile[featureToVary] = varyRange[0] + step * i;
    }
    profiles.push(profile);
  }
  return profiles;
}

export function checkShapAvailability(): { available: boolean; detail: string } {
  const script = resolve(process.cwd(), 'scripts/xai-explainer.py');
  if (!existsSync(script)) {
    return { available: false, detail: 'scripts/xai-explainer.py not found' };
  }
  return { available: true, detail: 'XAI script found at scripts/xai-explainer.py. Python + SHAP must be installed (pip install -r scripts/requirements-xai.txt).' };
}
