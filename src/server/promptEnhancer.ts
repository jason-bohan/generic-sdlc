/**
 * Prompt enhancer — injects few-shot examples and anti-pattern constraints
 * into agent spawn prompts to improve code quality from local models.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

// ─── Anti-pattern constraints ────────────────────────────────────────────

const ROLE_CONSTRAINTS: Record<string, string[]> = {
  backend: [
    'Do NOT create new API endpoints or route handlers unless the task explicitly asks for an endpoint.',
    'Do NOT modify existing route files (routes/, controllers/, handlers/) unless the task specifically refers to them.',
    'Do NOT add dependencies to package.json without being told to.',
    'Create standalone files in the locations specified by the task — do not embed logic inside existing functions.',
  ],
  frontend: [
    'Do NOT modify configuration files (webpack.config, tsconfig, vite.config, etc.) unless explicitly requested.',
    'Do NOT add new npm dependencies without being told to.',
    'Keep changes scoped to the component or file the task mentions.',
  ],
  qa: [
    'Do NOT test files that were not changed in this story.',
    'Write assertions that verify behavior, not implementation details.',
  ],
  reviewer: [
    'Review only the code changed in this PR. Do not request changes on pre-existing code outside the diff.',
    'Each review comment must reference a specific line or block in the diff — avoid vague general feedback.',
    'If the code is functionally correct and follows the project conventions, approve it.',
  ],
  devops: [
    'Do NOT modify application source code. Only modify CI config, pipeline files, and deployment manifests.',
  ],
};

/**
 * Generic constraints applied to every agent role.
 */
const GENERIC_CONSTRAINTS = [
  'Read the task carefully. Produce exactly what is asked — no more, no less.',
  'If the task asks for a new file, create it. Do not try to reuse or modify existing files to dodge the task.',
  'Keep diffs minimal. Change only what is needed to satisfy the task.',
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
