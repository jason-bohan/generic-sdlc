/**
 * Prompt enhancer — injects few-shot examples and anti-pattern constraints
 * into agent spawn prompts to improve code quality from local models.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

// ─── Role guidance: intent + invariants, not procedural "don't" rules ──────
//
// Earlier these were rigid prohibitions ("do NOT modify existing route files";
// "create standalone files"). For a task like "Add GET /api/ping/random" that
// guidance backfired: a weak model obeyed literally — spun up a parallel router
// file and repointed the import — dropping every existing route. Procedural rules
// can't anticipate the task; they mislead weak models and box in strong ones.
//
// Instead, encode the INTENT (extend the module that already owns this concern)
// and the INVARIANTS (don't break what exists; wire in what you add). That guides
// a weak model toward the right shape while leaving a strong model free to act.
// The hard guarantees are enforced by the rails (validation on the real worktree),
// not by hoping the model obeys a prohibition.

const ROLE_CONSTRAINTS: Record<string, string[]> = {
  backend: [
    'To add an endpoint, add the route to the router/module that already serves that path prefix. Do not create a parallel router or repoint imports — extend the existing one.',
    'Whatever you add must stay wired in and must not remove or break existing routes; all current tests must still pass.',
    'Add a dependency only if the task cannot be done with what is already in package.json.',
  ],
  frontend: [
    'Make the change in the component/file the task targets; reuse existing components and styles rather than recreating them.',
    'Touch build/config files (vite, tsconfig, webpack) only when the task genuinely requires it.',
    'Add a dependency only if the task cannot be done with what is already installed.',
  ],
  qa: [
    'Test the behavior this story changed; assert on observable behavior, not implementation details.',
    'Reuse the existing test setup/harness rather than introducing a parallel one.',
  ],
  reviewer: [
    'Review the diff; cite a specific line or block for each comment — no vague general feedback.',
    'Approve when the change is functionally correct, wired in, and follows project conventions; do not request changes on pre-existing code outside the diff.',
  ],
  devops: [
    'Keep changes to CI, pipeline, and deployment config; leave application source to the dev roles.',
  ],
};

/**
 * Generic guidance applied to every agent role — intent + invariants.
 */
const GENERIC_CONSTRAINTS = [
  'Do exactly what the task asks — no more, no less.',
  'Prefer extending the existing module that already owns this concern; create a new file only when none fits. Anything you create must be imported/registered so it actually runs.',
  'Do not break existing behavior: keep the project building and its tests passing.',
  'Keep the diff minimal — change only what the task needs.',
];

/**
 * Appends role-specific anti-pattern constraints to the prompt.
 */
export function addForbiddenPatterns(prompt: string, agentId: string): string {
  const roleConstraints = ROLE_CONSTRAINTS[agentId];
  if (!roleConstraints) return prompt;

  const block = [
    '',
    '## Constraints',
    ...GENERIC_CONSTRAINTS,
    ...roleConstraints.map(c => `- ${c}`),
  ].join('\n');

  return prompt + block;
}

// ─── Few-shot retrieval ──────────────────────────────────────────────────

const TRAINING_DATA_FILES = ['review_training_data.jsonl', 'aider_dataset.jsonl'];

/** Simple stopwords for keyword extraction. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'and', 'but', 'or', 'if', 'because', 'about', 'up', 'just', 'also',
  'this', 'that', 'these', 'those', 'it', 'its', 'read', 'your', 'you',
]);

function extractKeywords(text: string): string[] {
  const words = text.toLowerCase().split(/[^a-z0-9_]+/);
  return [...new Set(words.filter(w => w.length > 2 && !STOPWORDS.has(w)))];
}

function scoreExample(instruction: string, keywords: string[]): number {
  const lower = instruction.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) score += 1;
  }
  return score;
}

interface TrainingExample {
  instruction: string;
  context?: { files?: Record<string, string> };
  response?: string;
}

function loadTrainingData(rootDir: string): TrainingExample[] {
  const examples: TrainingExample[] = [];
  for (const filename of TRAINING_DATA_FILES) {
    const path = resolve(rootDir, filename);
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, 'utf8');
      for (const line of text.trim().split('\n').filter(Boolean)) {
        try {
          const parsed = JSON.parse(line) as TrainingExample;
          if (parsed.instruction) examples.push(parsed);
        } catch { /* skip malformed lines */ }
      }
    } catch { /* skip unreadable files */ }
  }
  return examples;
}

const MAX_FEW_SHOT_EXAMPLES = 2;
const MIN_KEYWORD_MATCHES = 2;
const MAX_EXAMPLE_LENGTH = 2000; // characters per example diff/response

/**
 * Injects few-shot examples from past training data that are relevant
 * to the current task prompt. Searches by keyword overlap.
 */
export function addFewShotExamples(prompt: string, rootDir: string): string {
  const examples = loadTrainingData(resolve(rootDir));
  if (!examples.length) return prompt;

  const keywords = extractKeywords(prompt);
  if (keywords.length < MIN_KEYWORD_MATCHES) return prompt;

  // Score and rank
  const scored = examples
    .map(e => ({ example: e, score: scoreExample(e.instruction, keywords) }))
    .filter(e => e.score >= MIN_KEYWORD_MATCHES)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return prompt;

  const selected = scored.slice(0, MAX_FEW_SHOT_EXAMPLES);
  const blocks: string[] = ['', '## Similar past work (reference these patterns)'];

  for (const { example, score } of selected) {
    const snippet = example.response
      ? example.response.slice(0, MAX_EXAMPLE_LENGTH)
      : '';
    blocks.push('');
    blocks.push(`[relevance score: ${score}] Task: ${example.instruction}`);
    if (snippet) {
      blocks.push('```diff');
      blocks.push(snippet);
      blocks.push('```');
    }
  }

  return prompt + blocks.join('\n');
}

// ─── Combined enhancer ───────────────────────────────────────────────────

/**
 * Apply all enhancements to a spawn prompt.
 */
export function enhancePrompt(prompt: string, agentId: string, rootDir: string): string {
  let enhanced = prompt;
  enhanced = addFewShotExamples(enhanced, rootDir);
  enhanced = addForbiddenPatterns(enhanced, agentId);
  return enhanced;
}
