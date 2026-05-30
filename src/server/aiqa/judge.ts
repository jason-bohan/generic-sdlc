export interface JudgeConfig {
  endpoint: string;
  model: string;
  timeoutMs: number;
}

export interface JudgeCriterion {
  name: string;
  description: string;
  weight: number;
}

export interface JudgeEvaluation {
  criteriaScores: Record<string, number>;
  overallScore: number;
  passed: boolean;
  reasoning: string;
  rawResponse: string;
  fallbackActivated: boolean;
}

const DEFAULT_CONFIG: JudgeConfig = {
  endpoint: 'http://localhost:11434/api/chat',
  model: 'qwen3:8b',
  timeoutMs: 30000,
};

function buildJudgePrompt(
  agentOutput: string,
  expectedBehavior: string,
  criteria: JudgeCriterion[],
): string {
  return `You are an AI quality judge evaluating an agent's response.

## Expected behavior
${expectedBehavior}

## Actual agent output
${agentOutput}

## Evaluation criteria (score each 0-100)
${criteria.map((c, i) => `${i + 1}. ${c.name} (weight ${c.weight}): ${c.description}`).join('\n')}

Respond with ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "criteriaScores": { "${criteria[0]?.name ?? ''}": 75 },
  "overallScore": 75,
  "reasoning": "Brief justification for the scores"
}`;
}

function parseJudgeResponse(raw: string): { criteriaScores: Record<string, number>; overallScore: number; reasoning: string } | null {
  try {
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && 'overallScore' in parsed) {
      return {
        criteriaScores: parsed.criteriaScores ?? {},
        overallScore: parsed.overallScore,
        reasoning: parsed.reasoning ?? '',
      };
    }
    return null;
  } catch {
    return null;
  }
}

export class LlmJudge {
  private config: JudgeConfig;
  private fallbackUsed = false;

  constructor(config?: Partial<JudgeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get fallbackActivated(): boolean {
    return this.fallbackUsed;
  }

  async evaluate(
    agentOutput: string,
    expectedBehavior: string,
    criteria: JudgeCriterion[] = [],
  ): Promise<JudgeEvaluation> {
    const baseCriteria: JudgeCriterion[] = criteria.length > 0 ? criteria : [
      { name: 'correctness', description: 'Is the response factually correct?', weight: 0.4 },
      { name: 'completeness', description: 'Does the response cover all required aspects?', weight: 0.3 },
      { name: 'clarity', description: 'Is the response clear and well-structured?', weight: 0.2 },
      { name: 'conciseness', description: 'Is the response appropriately concise?', weight: 0.1 },
    ];

    const result = await this.callLlm(agentOutput, expectedBehavior, baseCriteria);
    if (result) {
      this.fallbackUsed = false;
      return {
        ...result,
        passed: result.overallScore >= 60,
        rawResponse: result.rawResponse,
        fallbackActivated: false,
      };
    }

    this.fallbackUsed = true;
    const fb = this.fallbackEvaluation(agentOutput, expectedBehavior, baseCriteria);
    return { ...fb, fallbackActivated: true };
  }

  private async callLlm(
    agentOutput: string,
    expectedBehavior: string,
    criteria: JudgeCriterion[],
  ): Promise<(JudgeEvaluation & { rawResponse: string }) | null> {
    const prompt = buildJudgePrompt(agentOutput, expectedBehavior, criteria);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: 'system', content: prompt }],
          stream: false,
          format: 'json',
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) return null;

      const body = await response.json() as { message?: { content?: string } };
      const raw = body.message?.content ?? '';
      if (!raw) return null;

      const parsed = parseJudgeResponse(raw);
      if (!parsed) return null;

      return { ...parsed, rawResponse: raw, passed: parsed.overallScore >= 60, fallbackActivated: false };
    } catch {
      return null;
    }
  }

  private fallbackEvaluation(
    agentOutput: string,
    expectedBehavior: string,
    criteria: JudgeCriterion[],
  ): JudgeEvaluation {
    const expWords = new Set(expectedBehavior.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    const actLower = agentOutput.toLowerCase();
    let matched = 0;
    for (const word of expWords) {
      if (actLower.includes(word)) matched++;
    }
    const keywordScore = expWords.size > 0 ? (matched / expWords.size) * 100 : 50;

    const agentLines = agentOutput.split('\n').filter((l) => l.trim().length > 0);
    const completenessScore = Math.min(100, (agentLines.length / Math.max(3, Math.ceil(expectedBehavior.length / 200))) * 100);

    const avgLength = agentLines.reduce((sum, l) => sum + l.split(/\s+/).length, 0) / Math.max(1, agentLines.length);
    const concisenessScore = avgLength > 50 && agentLines.length > 20 ? Math.max(0, 100 - (agentLines.length - 10) * 2) : 80;

    const criteriaScores: Record<string, number> = {};
    for (const c of criteria) {
      if (c.name === 'correctness') criteriaScores[c.name] = keywordScore;
      else if (c.name === 'completeness') criteriaScores[c.name] = completenessScore;
      else if (c.name === 'conciseness') criteriaScores[c.name] = concisenessScore;
      else criteriaScores[c.name] = (keywordScore + completenessScore) / 2;
    }

    const overallScore = criteria.reduce((sum, c) => sum + (criteriaScores[c.name] ?? 50) * c.weight, 0);
    const normalizedScore = Math.round(overallScore);

    const detail = `Fallback evaluation (LLM unavailable): keywordMatch=${Math.round(keywordScore)}%, completeness=${Math.round(completenessScore)}%, conciseness=${Math.round(concisenessScore)}%`;

    return {
      criteriaScores,
      overallScore: normalizedScore,
      passed: normalizedScore >= 60,
      reasoning: detail,
      rawResponse: detail,
      fallbackActivated: true,
    };
  }
}

export async function evaluateWithJudge(
  agentOutput: string,
  expectedBehavior: string,
  criteria?: JudgeCriterion[],
  config?: Partial<JudgeConfig>,
): Promise<JudgeEvaluation> {
  const judge = new LlmJudge(config);
  return judge.evaluate(agentOutput, expectedBehavior, criteria ?? []);
}
