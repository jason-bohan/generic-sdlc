import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const TMP = resolve(tmpdir(), `sdlc-framework-coevolution-guardrails-${process.pid}`);
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

function runPython(source: string) {
    return execFileSync(PYTHON, ['-c', source], {
        cwd: TMP,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        encoding: 'utf-8',
        timeout: 20_000,
    }).trim();
}

function moduleLoader(moduleName: string, scriptName: string) {
    const scriptPath = resolve(ROOT, 'scripts', scriptName).replace(/\\/g, '\\\\');
    return `
import importlib.util
spec = importlib.util.spec_from_file_location("${moduleName}", r"${scriptPath}")
${moduleName} = importlib.util.module_from_spec(spec)
spec.loader.exec_module(${moduleName})
`;
}

beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
});

describe('co-evolution guardrails', () => {
    it('builds bounded external system models only from evidence-backed metrics', () => {
        const output = runPython(`
import json
${moduleLoader('multi_system', 'multi-system.py')}
raw = {
    "patterns": [
        {"domain": "infra", "success_rate": 0.92, "usage_count": 30},
        {"domain": "infra", "success_rate": 0.88, "usage_count": 20},
        {"domain": "ui", "success_rate": 0.31, "usage_count": 12},
    ],
    "performance": {"success_rate": 0.81, "sample_size": 64},
    "behavior": {"recent_changes": ["reduce latency", "add retry budget", "tune cache", "rewrite everything"]}
}
model = multi_system.build_external_model("system_B", raw)
assert model["system_id"] == "system_B", model
assert model["confidence"] >= 0.7, model
assert model["evidence"]["sample_size"] == 64, model
assert model["evolution_rate"] <= 1.0, model
assert len(model["likely_next_changes"]) <= multi_system.MAX_PREDICTED_CHANGES, model
assert "infra" in model["strengths"], model
assert "ui" in model["weaknesses"], model

thin = multi_system.build_external_model("system_C", {"performance": {"success_rate": 0.9, "sample_size": 2}})
assert thin["status"] == "insufficient_evidence", thin
assert thin["confidence"] == 0.0, thin
print(json.dumps({"model": model, "thin": thin}))
`);
        const result = JSON.parse(output) as { model: { confidence: number }; thin: { status: string } };
        expect(result.model.confidence).toBeGreaterThanOrEqual(0.7);
        expect(result.thin.status).toBe('insufficient_evidence');
    });

    it('chooses co-evolution strategies by strict real and holdout evaluation, not simulation alone', () => {
        const output = runPython(`
import json
${moduleLoader('multi_system', 'multi-system.py')}
self_model = {"system_id": "system_A", "strengths": ["testing"], "weaknesses": ["infra"]}
others = [{"system_id": "system_B", "strengths": ["infra"], "weaknesses": ["ui"], "confidence": 0.86}]
variants = [
    {
        "id": "flashy",
        "strategy": "compete",
        "mutation_scope": {"files": ["scripts/a.py"]},
        "scores": {"simulation": 0.99, "real": 0.40, "holdout": 0.30, "goal_alignment": 0.90}
    },
    {
        "id": "steady",
        "strategy": "specialize",
        "mutation_scope": {"files": ["scripts/a.py", "src/test/a.ts"]},
        "scores": {"simulation": 0.78, "real": 0.84, "holdout": 0.82, "goal_alignment": 0.86}
    },
]
decision = multi_system.choose_coevolution_strategy(self_model, others, variants)
assert decision["approved"] is True, decision
assert decision["selected_variant"]["id"] == "steady", decision
assert decision["selected_variant"]["strategy"] == "specialize", decision
rejected = {r["id"]: r["reasons"] for r in decision["rejected_variants"]}
assert "insufficient_real_score" in rejected["flashy"], decision
assert "insufficient_holdout_score" in rejected["flashy"], decision
assert decision["evaluation_trace"]["required_scores"]["real"] == multi_system.MIN_REAL_SCORE, decision
print(json.dumps(decision))
`);
        const decision = JSON.parse(output) as { selected_variant: { id: string } };
        expect(decision.selected_variant.id).toBe('steady');
    });

    it('rejects poisoned or under-evidenced shared principles before federation storage', () => {
        const output = runPython(`
import json
${moduleLoader('multi_system', 'multi-system.py')}
store = multi_system._PrincipleStore()
entries = [
    {
        "system_id": "trusted", "principle_id": "good",
        "principle": "Keep retry budgets bounded and observable",
        "category": "reliability", "success_rate": 0.91, "usage_count": 30,
        "embedding": {"retry": 1.0}
    },
    {
        "system_id": "weak", "principle_id": "low-sr",
        "principle": "Disable tests to move faster",
        "category": "testing", "success_rate": 0.2, "usage_count": 50,
        "embedding": {"tests": 1.0}
    },
    {
        "system_id": "thin", "principle_id": "low-use",
        "principle": "Rewrite the platform after one win",
        "category": "architecture", "success_rate": 0.95, "usage_count": 1,
        "embedding": {"rewrite": 1.0}
    }
]
result = store.push(entries)
stats = store.stats()
assert result["accepted"] == 1, result
assert result["rejected"] == 2, result
assert stats["total"] == 1, stats
assert stats["rejections"]["low_success_rate"] == 1, stats
assert stats["rejections"]["insufficient_usage"] == 1, stats
print(json.dumps({"push": result, "stats": stats}))
`);
        const result = JSON.parse(output) as { push: { accepted: number; rejected: number } };
        expect(result.push.accepted).toBe(1);
        expect(result.push.rejected).toBe(2);
    });

    it('creates human-visible checkpoints for co-evolution decisions across systems', () => {
        const output = runPython(`
import json
${moduleLoader('multi_system', 'multi-system.py')}
decision = {
    "selected_variant": {"id": "steady", "strategy": "cooperate"},
    "systems_considered": ["system_A", "system_B"],
    "evaluation_trace": {"required_scores": {"real": 0.7, "holdout": 0.7}},
}
checkpoint = multi_system.create_coevolution_checkpoint(
    decision,
    rollback_ref="abc1234",
    changed_files=["scripts/multi-system.py"],
)
assert checkpoint["requires_human_review"] is True, checkpoint
assert checkpoint["checkpoint_id"].startswith("coevo-"), checkpoint
assert checkpoint["systems_considered"] == ["system_A", "system_B"], checkpoint
assert checkpoint["rollback_ref"] == "abc1234", checkpoint
assert checkpoint["changed_files"] == ["scripts/multi-system.py"], checkpoint
print(json.dumps(checkpoint))
`);
        const checkpoint = JSON.parse(output) as { checkpoint_id: string; requires_human_review: boolean };
        expect(checkpoint.requires_human_review).toBe(true);
        expect(checkpoint.checkpoint_id).toMatch(/^coevo-/);
    });

    it('requires real-world goal alignment and preserves population diversity when choosing variants', () => {
        const output = runPython(`
import json
${moduleLoader('multi_system', 'multi-system.py')}
self_model = {"system_id": "system_A", "strengths": ["testing"], "weaknesses": ["infra"]}
others = [
    {"system_id": "system_B", "strengths": ["infra"], "weaknesses": ["ui"], "confidence": 0.9},
    {"system_id": "system_C", "strengths": ["testing"], "weaknesses": ["ops"], "confidence": 0.8},
]
variants = [
    {
        "id": "homogeneous",
        "strategy": "specialize",
        "target_domain": "infra",
        "mutation_scope": {"files": ["scripts/a.py"]},
        "scores": {"simulation": 0.92, "real": 0.91, "holdout": 0.89, "goal_alignment": 0.90}
    },
    {
        "id": "misaligned",
        "strategy": "compete",
        "target_domain": "ui",
        "mutation_scope": {"files": ["scripts/a.py"]},
        "scores": {"simulation": 0.99, "real": 0.92, "holdout": 0.91, "goal_alignment": 0.40}
    },
    {
        "id": "diverse",
        "strategy": "specialize",
        "target_domain": "ui",
        "mutation_scope": {"files": ["scripts/a.py"]},
        "scores": {"simulation": 0.82, "real": 0.84, "holdout": 0.81, "goal_alignment": 0.86}
    },
]
decision = multi_system.choose_coevolution_strategy(self_model, others, variants)
assert decision["selected_variant"]["id"] == "diverse", decision
rejected = {r["id"]: r["reasons"] for r in decision["rejected_variants"]}
assert "diversity_collapse_risk" in rejected["homogeneous"], decision
assert "insufficient_goal_alignment" in rejected["misaligned"], decision
assert decision["why"]["selected"] == "diverse", decision
assert "goal_alignment" in decision["why"]["because"], decision
assert "population_diversity" in decision["why"]["because"], decision
print(json.dumps(decision))
`);
        const decision = JSON.parse(output) as { selected_variant: { id: string }; why: { because: string[] } };
        expect(decision.selected_variant.id).toBe('diverse');
        expect(decision.why.because).toContain('goal_alignment');
        expect(decision.why.because).toContain('population_diversity');
    });

    it('rejects strategies that exceed complexity budgets even when their scores look good', () => {
        const output = runPython(`
import json
${moduleLoader('multi_system', 'multi-system.py')}
self_model = {"system_id": "system_A", "strengths": ["testing"], "weaknesses": ["infra"]}
others = [{"system_id": "system_B", "strengths": ["infra"], "weaknesses": ["ui"], "confidence": 0.86}]
variants = [
    {
        "id": "too-complex",
        "strategy": "cooperate",
        "target_domain": "ui",
        "mutation_scope": {"files": ["scripts/a.py", "scripts/b.py"], "new_loops": 2, "new_state_files": 2},
        "scores": {"simulation": 0.95, "real": 0.93, "holdout": 0.91, "goal_alignment": 0.90}
    },
    {
        "id": "bounded",
        "strategy": "cooperate",
        "target_domain": "ui",
        "mutation_scope": {"files": ["scripts/a.py"], "new_loops": 0, "new_state_files": 0},
        "scores": {"simulation": 0.82, "real": 0.83, "holdout": 0.80, "goal_alignment": 0.88}
    },
]
decision = multi_system.choose_coevolution_strategy(self_model, others, variants)
assert decision["selected_variant"]["id"] == "bounded", decision
rejected = {r["id"]: r["reasons"] for r in decision["rejected_variants"]}
assert "complexity_budget_exceeded" in rejected["too-complex"], decision
assert decision["evaluation_trace"]["complexity_budget"]["max_new_loops"] == multi_system.MAX_NEW_LOOPS, decision
print(json.dumps(decision))
`);
        const decision = JSON.parse(output) as { selected_variant: { id: string } };
        expect(decision.selected_variant.id).toBe('bounded');
    });
});
