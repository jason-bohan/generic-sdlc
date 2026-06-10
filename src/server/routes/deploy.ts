// Deploy gate route — ingest a deploy result and close the loop.
//
// POST /api/handoff/deploy-complete  { result, storyNumber?|prId?|commit?, reason?, url? }
//
// The deploy platform's webhook (or a CI step / forwarder) calls this after a deploy. On failure
// the story is requeued for rework; on success it's acknowledged. Mirror of build-complete, but
// for the *post-merge* deploy that the SDLC loop otherwise never sees.

import { execFileSync } from 'child_process';
import { readBody, json, cors } from '../router';
import type { UseFn } from './types';
import { parseJsonUtf8File } from '../json-file';
import { applyDeployResult, parseStoryNumber, type DeployResult } from '../deploy-gate';
import { notify } from '../providers';

function repoFromConfig(configFile: string): string {
  try { return (parseJsonUtf8File(configFile) as { github?: { repo?: string } }).github?.repo ?? ''; }
  catch { return ''; }
}

function gh(args: string[]): string {
  try { return execFileSync('gh', args, { encoding: 'utf8', timeout: 30_000 }).trim(); }
  catch { return ''; }
}

/** Resolve the story number from an explicit value, or by reading a PR title / commit message. */
function resolveStory(body: Record<string, unknown>, repo: string): string | undefined {
  if (typeof body.storyNumber === 'string' && body.storyNumber.trim()) return body.storyNumber.trim();
  if (repo && body.prId !== undefined) {
    const title = gh(['pr', 'view', String(body.prId), '-R', repo, '--json', 'title', '-q', '.title']);
    const sn = parseStoryNumber(title);
    if (sn) return sn;
  }
  if (repo && typeof body.commit === 'string' && body.commit) {
    const msg = gh(['api', `repos/${repo}/commits/${body.commit}`, '-q', '.commit.message']);
    const sn = parseStoryNumber(msg);
    if (sn) return sn;
  }
  return undefined;
}

export function mount(use: UseFn, rootDir: string, configFile: string): void {
  use('/api/handoff/deploy-complete', async (req, res) => {
    cors(res, 'POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { json(res, { error: 'invalid JSON' }, 400); return; }

    const result = body.result as DeployResult;
    if (result !== 'success' && result !== 'failed') { json(res, { error: 'result must be "success" or "failed"' }, 400); return; }

    const repo = repoFromConfig(configFile);
    const storyNumber = resolveStory(body, repo);
    if (!storyNumber) { json(res, { error: 'could not resolve storyNumber (pass storyNumber, prId, or commit)' }, 400); return; }

    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const outcome = applyDeployResult(rootDir, storyNumber, result, reason);

    // Surface it: a failed deploy is loud (prod may be broken); a success is a quiet confirm.
    if (outcome.ok) {
      const url = typeof body.url === 'string' ? ` ${body.url}` : '';
      if (result === 'failed') {
        await notify(rootDir, { title: `🚨 Deploy FAILED: ${storyNumber}`, body: `Deploy failed${reason ? ` — ${reason}` : ''}. Requeued for rework.${url}`, color: 'ef4444' });
      } else {
        await notify(rootDir, { title: `🚀 Deployed: ${storyNumber}`, body: `Deploy succeeded.${url}`, color: '22c55e' });
      }
    }
    json(res, outcome, outcome.ok ? 200 : 404);
  });
}
