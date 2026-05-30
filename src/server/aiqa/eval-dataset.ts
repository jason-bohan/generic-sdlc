import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export type EvalCategory =
  | 'phase-transition'
  | 'task-quality'
  | 'tool-usage'
  | 'token-efficiency'
  | 'financial-control'
  | 'log-health'
  | 'response-quality'
  | 'hallucination'
  | 'adversarial';

export interface EvalInput {
  agentId: string;
  currentPhase: string;
  isRunning: boolean;
  tasks: Array<{ name?: string; status?: string; hours?: number; category?: string; priority?: string }>;
  requests: Array<{ id: string; status?: string; summary?: string; type?: string; severity?: string }>;
  prs: Array<{ id: number; title: string; status: string }>;
  events: Array<{ type: string; message: string; timestamp: string }>;
  tokens: Record<string, { input: number; output: number }>;
  logSnippets: string[];
}

export interface EvalExpectation {
  qualityScoreMin?: number;
  mustFindFindings?: number;
  mustNotFindFindings?: boolean;
  expectedFindingCounts?: Record<string, number>;
  expectedSeverityCounts?: Record<string, number>;
  description: string;
}

export interface EvalExample {
  id: string;
  category: EvalCategory;
  name: string;
  description: string;
  input: EvalInput;
  expected: EvalExpectation;
  tags: string[];
}

export interface EvalDataset {
  id: string;
  name: string;
  description: string;
  examples: EvalExample[];
}

function makeTasks(n: number, overrides: Partial<EvalInput['tasks'][0]> = {}): EvalInput['tasks'] {
  return Array.from({ length: n }, (_, i) => ({
    name: `Task ${i + 1}`,
    status: 'completed',
    hours: 1,
    category: 'Implementation',
    priority: 'medium',
    ...overrides,
  }));
}

function makeTokens(input: number, output: number, localInput = 0, localOutput = 0): EvalInput['tokens'] {
  return {
    cloud: { input, output },
    meshllm: { input: 0, output: 0 },
    ollama: { input: localInput, output: localOutput },
    mlx: { input: 0, output: 0 },
  };
}

const NOW = new Date().toISOString();
const STALE = new Date(Date.now() - 60 * 60_000).toISOString();

export const BUILTIN_DATASETS: EvalDataset[] = [
  {
    id: 'phase-transitions',
    name: 'Phase Transition Health',
    description: 'Tests that detect invalid or stuck phase transitions in agent workflows.',
    examples: [
      {
        id: 'phase-error',
        category: 'phase-transition',
        name: 'Agent stuck in error phase',
        description: 'Agent is in error phase and not running.',
        input: {
          agentId: 'backend',
          currentPhase: 'error',
          isRunning: false,
          tasks: makeTasks(3),
          requests: [],
          prs: [],
          events: [{ type: 'error', message: 'Build failed', timestamp: NOW }],
          tokens: makeTokens(5000, 15000),
          logSnippets: ['[error] Failed running npm build', '[error] Module not found'],
        },
        expected: { qualityScoreMin: 60, mustFindFindings: 1, description: 'Should flag error phase agent' },
        tags: ['error', 'stuck'],
      },
      {
        id: 'phase-stopped-mid',
        category: 'phase-transition',
        name: 'Agent stopped mid-workflow',
        description: 'Agent has an assigned story but is not running.',
        input: {
          agentId: 'frontend',
          currentPhase: 'analyzing',
          isRunning: false,
          tasks: makeTasks(2, { status: 'in_progress' }),
          requests: [{ id: 'req-1', status: 'open', summary: 'Review component design', type: 'review' }],
          prs: [],
          events: [],
          tokens: makeTokens(8000, 12000),
          logSnippets: [],
        },
        expected: { qualityScoreMin: 70, mustFindFindings: 1, description: 'Should flag stopped agent' },
        tags: ['stalled', 'handoff'],
      },
      {
        id: 'phase-healthy',
        category: 'phase-transition',
        name: 'Agent running normally',
        description: 'Agent is actively running with no issues.',
        input: {
          agentId: 'backend',
          currentPhase: 'generating-code',
          isRunning: true,
          tasks: makeTasks(5),
          requests: [],
          prs: [{ id: 42, title: 'Implement payment flow', status: 'active' }],
          events: [{ type: 'phase', message: 'Transitioned to generating-code', timestamp: NOW }],
          tokens: makeTokens(15000, 25000),
          logSnippets: ['[tool] create_file src/api/payments.ts', '[tool] edit_file src/api/payments.ts'],
        },
        expected: { mustNotFindFindings: true, description: 'Should not flag healthy agent' },
        tags: ['healthy', 'baseline'],
      },
    ],
  },
  {
    id: 'task-quality',
    name: 'Task Definition Quality',
    description: 'Tests that evaluate task definition quality and completion status.',
    examples: [
      {
        id: 'failed-tasks',
        category: 'task-quality',
        name: 'Multiple failed tasks need triage',
        description: 'Agent has several failed tasks.',
        input: {
          agentId: 'qa',
          currentPhase: 'running-cypress',
          isRunning: true,
          tasks: [
            ...makeTasks(2),
            { name: 'Run Cypress tests', status: 'failed', hours: 2, category: 'QA', priority: 'high' },
            { name: 'Validate form inputs', status: 'failed', hours: 1, category: 'QA', priority: 'medium' },
          ],
          requests: [],
          prs: [],
          events: [],
          tokens: makeTokens(3000, 8000),
          logSnippets: [],
        },
        expected: { mustFindFindings: 1, description: 'Should flag failed tasks' },
        tags: ['failure', 'tasks'],
      },
      {
        id: 'high-token-burn',
        category: 'task-quality',
        name: 'Excessive token usage',
        description: 'Agent is burning excessive tokens relative to peers.',
        input: {
          agentId: 'frontend',
          currentPhase: 'analyzing',
          isRunning: true,
          tasks: makeTasks(1),
          requests: [],
          prs: [],
          events: [],
          tokens: makeTokens(120000, 200000),
          logSnippets: [],
        },
        expected: { qualityScoreMin: 50, mustFindFindings: 1, description: 'Should flag excessive token burn' },
        tags: ['tokens', 'efficiency'],
      },
    ],
  },
  {
    id: 'tool-usage',
    name: 'Tool Call Quality',
    description: 'Tests that detect tool-call parsing failures and retry loops.',
    examples: [
      {
        id: 'tool-parse-failures',
        category: 'tool-usage',
        name: 'Tool-call parsing failures',
        description: 'Agent logs show repeated tool-call parsing errors.',
        input: {
          agentId: 'reviewer',
          currentPhase: 'reviewing',
          isRunning: false,
          tasks: makeTasks(1),
          requests: [],
          prs: [],
          events: [],
          tokens: makeTokens(2000, 5000),
          logSnippets: [
            '[tool] review_pr --id=42\n[tool-call] parse error: unexpected token',
            '[tool] review_pr --id=42\n[tool-call] parse error: unexpected token',
            '[tool] review_pr --id=42\nERROR: Failed running tool',
            '[tool] review_pr --id=42\n[tool-call] parse error: unexpected token',
          ],
        },
        expected: { mustFindFindings: 1, description: 'Should flag tool-call parse failures' },
        tags: ['tool', 'parse', 'errors'],
      },
      {
        id: 'repeated-phase-complete',
        category: 'tool-usage',
        name: 'Repeated phase completion attempts',
        description: 'Agent is retrying complete_phase excessively.',
        input: {
          agentId: 'backend',
          currentPhase: 'generating-code',
          isRunning: true,
          tasks: makeTasks(3, { status: 'completed' }),
          requests: [],
          prs: [],
          events: [],
          tokens: makeTokens(10000, 30000),
          logSnippets: [
            '[tool] complete_phase', '[tool] complete_phase',
            '[tool] complete_phase', '[tool] complete_phase',
            '[tool] complete_phase', '[tool] complete_phase',
            '[tool] complete_phase', '[tool] complete_phase',
            '[tool] complete_phase', '[tool] complete_phase',
          ],
        },
        expected: { mustFindFindings: 1, description: 'Should flag repeated complete_phase calls' },
        tags: ['retry', 'stuck'],
      },
    ],
  },
  {
    id: 'sessions',
    name: 'Session Health',
    description: 'Tests that detect stale, failed, or orphaned sessions.',
    examples: [
      {
        id: 'stale-session',
        category: 'log-health',
        name: 'Stale running session',
        description: 'A session has been running for over 30 minutes with no updates.',
        input: {
          agentId: 'frontend',
          currentPhase: 'generating-code',
          isRunning: true,
          tasks: makeTasks(2),
          requests: [],
          prs: [],
          events: [{ type: 'info', message: 'Session started', timestamp: STALE }],
          tokens: makeTokens(50000, 100000),
          logSnippets: [],
        },
        expected: { mustFindFindings: 1, description: 'Should flag stale sessions' },
        tags: ['session', 'stale', 'timeout'],
      },
      {
        id: 'failed-session',
        category: 'log-health',
        name: 'Session ended in failure',
        description: 'Recent session ended with failed status.',
        input: {
          agentId: 'backend',
          currentPhase: 'validating',
          isRunning: false,
          tasks: makeTasks(1, { status: 'failed' }),
          requests: [],
          prs: [],
          events: [{ type: 'error', message: 'Session ended with status=failed', timestamp: NOW }],
          tokens: makeTokens(15000, 35000),
          logSnippets: ['[error] Build failed: test errors', '[error] Session terminated'],
        },
        expected: { mustFindFindings: 1, description: 'Should flag failed sessions' },
        tags: ['session', 'failure'],
      },
    ],
  },
  {
    id: 'financial-controls',
    name: 'Financial Control Compliance',
    description: 'Tests that detect financial control gaps in agent outputs.',
    examples: [
      {
        id: 'money-path-no-tests',
        category: 'financial-control',
        name: 'Money path without test evidence',
        description: 'Agent references payment terms but no test/audit evidence.',
        input: {
          agentId: 'backend',
          currentPhase: 'generating-code',
          isRunning: true,
          tasks: makeTasks(2, { name: 'Implement payment processing', status: 'in_progress', category: 'Backend' }),
          requests: [],
          prs: [{ id: 7, title: 'Add payment reconciliation', status: 'active' }],
          events: [],
          tokens: makeTokens(12000, 28000),
          logSnippets: ['Implementing balance transfer logic in ledger service', 'Adding billing invoice generation'],
        },
        expected: { mustFindFindings: 1, description: 'Should flag missing test evidence for money path' },
        tags: ['financial', 'compliance', 'money-path'],
      },
      {
        id: 'regulated-data-leak',
        category: 'financial-control',
        name: 'Regulated data exposure in logs',
        description: 'Agent logs contain potential PII or regulated data terms.',
        input: {
          agentId: 'frontend',
          currentPhase: 'generating-code',
          isRunning: true,
          tasks: makeTasks(1, { name: 'Add customer profile form', status: 'in_progress' }),
          requests: [],
          prs: [],
          events: [],
          tokens: makeTokens(8000, 15000),
          logSnippets: ['Reading customer SSN from profile', 'Displaying masked PAN: ****1234'],
        },
        expected: { mustFindFindings: 1, description: 'Should flag regulated data exposure' },
        tags: ['financial', 'pii', 'regulated-data'],
      },
    ],
  },
  {
    id: 'golden-baselines',
    name: 'Golden Baseline - Healthy Agents',
    description: 'Golden test cases for what healthy, well-behaved agents look like.',
    examples: [
      {
        id: 'healthy-complete-workflow',
        category: 'response-quality',
        name: 'Complete healthy workflow',
        description: 'All agents completed their workflows successfully.',
        input: {
          agentId: 'backend',
          currentPhase: 'complete',
          isRunning: false,
          tasks: [
            { name: 'Implement API endpoint in payments service', status: 'completed', hours: 3, category: 'Backend', priority: 'high' },
            { name: 'Write unit tests for payment validation module', status: 'completed', hours: 2, category: 'QA', priority: 'medium' },
            { name: 'Add OpenAPI docs for auth service routes', status: 'completed', hours: 1, category: 'Backend', priority: 'low' },
          ],
          requests: [{ id: 'req-1', status: 'resolved', summary: 'Review implementation', type: 'review' }],
          prs: [{ id: 100, title: 'Add payments endpoint', status: 'completed' }],
          events: [
            { type: 'phase', message: 'Transitioned to complete', timestamp: NOW },
            { type: 'success', message: 'All tasks completed successfully', timestamp: NOW },
          ],
          tokens: makeTokens(8000, 12000, 2000, 3000),
          logSnippets: [
            '[tool] create_file src/api/payments.ts',
            '[tool] edit_file src/tests/payments.test.ts',
            '[tool] complete_phase',
          ],
        },
        expected: { mustNotFindFindings: true, description: 'Should not flag a clean completed workflow' },
        tags: ['golden', 'baseline', 'healthy'],
      },
      {
        id: 'healthy-active-work',
        category: 'response-quality',
        name: 'Actively working agent',
        description: 'Agent is actively making progress with reasonable metrics.',
        input: {
          agentId: 'frontend',
          currentPhase: 'generating-code',
          isRunning: true,
          tasks: [
            { name: 'Build checkout page component', status: 'in_progress', hours: 4, category: 'Frontend', priority: 'high' },
            { name: 'Add form validation service', status: 'pending', hours: 2, category: 'Frontend', priority: 'medium' },
          ],
          requests: [],
          prs: [],
          events: [{ type: 'phase', message: 'Started generating-code', timestamp: NOW }],
          tokens: makeTokens(10000, 12000, 3000, 2000),
          logSnippets: ['[tool] create_file src/components/checkout.tsx', '[tool] edit_file src/styles/checkout.css'],
        },
        expected: { mustNotFindFindings: true, description: 'Should not flag a healthy active agent' },
        tags: ['golden', 'baseline', 'active'],
      },
    ],
  },
  {
    id: 'adversarial',
    name: 'Adversarial & Edge Cases',
    description: 'Tests that stress-test the AIQA system itself with edge cases.',
    examples: [
      {
        id: 'empty-agent',
        category: 'adversarial',
        name: 'Empty agent status',
        description: 'Agent status file is empty or has minimal data.',
        input: {
          agentId: 'devops',
          currentPhase: 'idle',
          isRunning: false,
          tasks: [],
          requests: [],
          prs: [],
          events: [],
          tokens: makeTokens(0, 0),
          logSnippets: [],
        },
        expected: { mustNotFindFindings: true, description: 'Should not error on empty data' },
        tags: ['edge-case', 'empty', 'resilience'],
      },
      {
        id: 'extreme-token-count',
        category: 'adversarial',
        name: 'Extreme token counts',
        description: 'Agent has unrealistically high token counts.',
        input: {
          agentId: 'backend',
          currentPhase: 'analyzing',
          isRunning: true,
          tasks: makeTasks(1),
          requests: [],
          prs: [],
          events: [],
          tokens: makeTokens(10000000, 20000000),
          logSnippets: ['analyzing codebase'],
        },
        expected: { mustFindFindings: 1, description: 'Should flag extreme token usage' },
        tags: ['edge-case', 'tokens', 'extreme'],
      },
      {
        id: 'conflicting-status',
        category: 'adversarial',
        name: 'Conflicting agent status signals',
        description: 'Agent reports both running and completed in conflicting ways.',
        input: {
          agentId: 'frontend',
          currentPhase: 'complete',
          isRunning: true,
          tasks: makeTasks(1, { status: 'in_progress' }),
          requests: [{ id: 'req-1', status: 'open', summary: 'Review needed', type: 'review' }],
          prs: [{ id: 1, title: 'WIP PR', status: 'draft' }],
          events: [],
          tokens: makeTokens(30000, 60000),
          logSnippets: [],
        },
        expected: { qualityScoreMin: 70, mustFindFindings: 1, description: 'Should flag conflicting state signals' },
        tags: ['edge-case', 'conflict', 'state'],
      },
      {
        id: 'rapid-phase-cycling',
        category: 'adversarial',
        name: 'Rapid phase cycling',
        description: 'Agent cycles through phases too quickly, suggesting a loop.',
        input: {
          agentId: 'backend',
          currentPhase: 'analyzing',
          isRunning: true,
          tasks: makeTasks(1),
          requests: [],
          prs: [],
          events: [
            { type: 'phase', message: 'starting generating-code', timestamp: NOW },
            { type: 'phase', message: 'back to analyzing', timestamp: NOW },
            { type: 'phase', message: 'starting generating-code', timestamp: NOW },
            { type: 'phase', message: 'back to analyzing', timestamp: NOW },
          ],
          tokens: makeTokens(80000, 150000),
          logSnippets: ['complete_phase', 'transitioning to analyzing', 'complete_phase'],
        },
        expected: { mustFindFindings: 2, description: 'Should flag rapid phase cycling and high token burn' },
        tags: ['edge-case', 'looping', 'instability'],
      },
    ],
  },
];

export function getDataset(id: string): EvalDataset | undefined {
  return BUILTIN_DATASETS.find((d) => d.id === id);
}

export function listDatasetIds(): string[] {
  return BUILTIN_DATASETS.map((d) => d.id);
}

export function getAllExamples(): EvalExample[] {
  return BUILTIN_DATASETS.flatMap((d) => d.examples);
}

export function loadExternalDataset(filePath: string): EvalDataset | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as EvalDataset;
  } catch {
    return null;
  }
}
