export interface SimilarityScorer {
  name: string;
  score(expected: string, actual: string): number;
}

export class TfIdfScorer implements SimilarityScorer {
  name = 'tfidf-cosine';

  private tokenize(text: string): string[] {
    return text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }

  private termFreq(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    const max = Math.max(...tf.values(), 1);
    for (const [k, v] of tf) {
      tf.set(k, v / max);
    }
    return tf;
  }

  score(expected: string, actual: string): number {
    const expTokens = this.tokenize(expected);
    const actTokens = this.tokenize(actual);
    if (expTokens.length === 0 || actTokens.length === 0) return 0;

    const expTf = this.termFreq(expTokens);
    const actTf = this.termFreq(actTokens);

    const allTerms = new Set([...expTf.keys(), ...actTf.keys()]);
    const idf = new Map<string, number>();
    const totalDocs = 2;

    for (const term of allTerms) {
      const docsWith = (expTf.has(term) ? 1 : 0) + (actTf.has(term) ? 1 : 0);
      idf.set(term, Math.log((totalDocs + 1) / (docsWith + 1)) + 1);
    }

    let dot = 0, expMag = 0, actMag = 0;
    for (const term of allTerms) {
      const w = idf.get(term) ?? 1;
      const ev = (expTf.get(term) ?? 0) * w;
      const av = (actTf.get(term) ?? 0) * w;
      dot += ev * av;
      expMag += ev * ev;
      actMag += av * av;
    }

    const mag = Math.sqrt(expMag) * Math.sqrt(actMag);
    return mag === 0 ? 0 : dot / mag;
  }
}

export class NGramOverlapScorer implements SimilarityScorer {
  name = 'ngram-overlap';
  private n: number;

  constructor(n = 3) { this.n = n; }

  private ngrams(text: string): Set<string> {
    const cleaned = text.toLowerCase().replace(/\s+/g, ' ');
    const set = new Set<string>();
    for (let i = 0; i <= cleaned.length - this.n; i++) {
      set.add(cleaned.slice(i, i + this.n));
    }
    return set;
  }

  score(expected: string, actual: string): number {
    const expNgrams = this.ngrams(expected);
    const actNgrams = this.ngrams(actual);
    if (expNgrams.size === 0 || actNgrams.size === 0) return 0;
    const intersection = new Set([...expNgrams].filter((n) => actNgrams.has(n)));
    return (2 * intersection.size) / (expNgrams.size + actNgrams.size);
  }
}

export class WordOrderScorer implements SimilarityScorer {
  name = 'word-order';

  score(expected: string, actual: string): number {
    const expWords = expected.toLowerCase().split(/\s+/).filter(Boolean);
    const actWords = actual.toLowerCase().split(/\s+/).filter(Boolean);
    if (expWords.length === 0 || actWords.length === 0) return 0;

    const expSet = new Set(expWords);
    const actSet = new Set(actWords);
    const common = new Set([...expSet].filter((w) => actSet.has(w)));
    if (common.size === 0) return 0;

    const expOrder = expWords.filter((w) => common.has(w));
    const actOrder = actWords.filter((w) => common.has(w));

    let matches = 0;
    for (let i = 0; i < Math.min(expOrder.length, actOrder.length); i++) {
      if (expOrder[i] === actOrder[i]) matches++;
    }

    return (2 * matches) / (expOrder.length + actOrder.length);
  }
}

export interface SemanticEvalResult {
  similarity: number;
  passed: boolean;
  threshold: number;
  scorer: string;
  detail: string;
}

const DEFAULT_THRESHOLD = 0.7;

const scorers: SimilarityScorer[] = [
  new TfIdfScorer(),
  new NGramOverlapScorer(3),
  new WordOrderScorer(),
];

export function evaluateSemanticSimilarity(
  expected: string,
  actual: string,
  threshold: number = DEFAULT_THRESHOLD,
): SemanticEvalResult {
  const scores = scorers.map((s) => ({ name: s.name, score: s.score(expected, actual) }));
  const bestScore = Math.max(...scores.map((s) => s.score));
  const bestScorer = scores.find((s) => s.score === bestScore)?.name ?? 'unknown';
  const passed = bestScore >= threshold;

  const detail = `Semantic similarity: ${(bestScore * 100).toFixed(1)}% (threshold: ${(threshold * 100).toFixed(0)}%, scorer: ${bestScorer}). `
    + (passed ? 'PASS: Content matches within threshold.' : 'FAIL: Content diverges beyond threshold.');

  return { similarity: bestScore, passed, threshold, scorer: bestScorer, detail };
}

export function evaluateSemanticBatch(
  pairs: Array<{ expected: string; actual: string }>,
  threshold: number = DEFAULT_THRESHOLD,
): SemanticEvalResult[] {
  return pairs.map((p) => evaluateSemanticSimilarity(p.expected, p.actual, threshold));
}
