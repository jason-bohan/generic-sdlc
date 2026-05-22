import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const TMP = resolve(tmpdir(), `sdlc-framework-autonomy-guardrails-${process.pid}`);
const PYTHON = process.env.PYTHON || 'python';

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

describe('autonomy guardrails', () => {
    it('goal-engine only emits aligned, observable tasks for real failure opportunities', () => {
        const output = runPython(`
import json
${moduleLoader('goal_engine', 'goal-engine.py')}
opportunities = [
    {"cluster": "null_ref", "score": 0.72, "failure_rate": 0.6},
    {"cluster": "timeout", "score": 0.0, "failure_rate": 0.0},
]
tasks = goal_engine.generate_tasks(opportunities, top_k=2)
assert tasks, "expected at least one task for the failing cluster"
assert all(t["cluster"] == "null_ref" for t in tasks), tasks
for task in tasks:
    assert task["alignment_objective"] == "reduce recurring verified failures without expanding scope"
    assert task["acceptance_criteria"], task
    assert task["guardrails"]["requires_tests"] is True
    assert task["decision_trace"]["source"] == "goal-engine"
    assert task["decision_trace"]["opportunity_score"] == task["score"]
print(json.dumps(tasks))
`);
        const tasks = JSON.parse(output) as Array<{ cluster: string }>;
        expect(tasks.length).toBeGreaterThan(0);
        expect(tasks.every((t) => t.cluster === 'null_ref')).toBe(true);
    });

    it('manager queue dedupes tasks, clamps priority inputs, and records why a task exists', () => {
        const output = runPython(`
import json
${moduleLoader('manager_agent', 'manager-agent.py')}
queue = []
manager_agent.add_task(queue, "Fix flaky timeout", "timeout", urgency=4.0, impact=-1.0)
manager_agent.add_task(queue, "Fix flaky timeout", "timeout", urgency=0.9, impact=0.9)
assert len(queue) == 1, queue
task = queue[0]
assert task["urgency"] == 1.0, task
assert task["impact"] == 0.0, task
assert task["score"] == 0.0, task
assert task["decision_trace"]["dedupe_key"] == "timeout::Fix flaky timeout"
assert task["decision_trace"]["score_formula"] == "clamp(urgency) * clamp(impact)"
print(json.dumps(queue))
`);
        const queue = JSON.parse(output) as unknown[];
        expect(queue).toHaveLength(1);
    });

    it('agent economy records bid reasoning for observability', () => {
        const output = runPython(`
import json
${moduleLoader('agent_economy', 'agent-economy.py')}
economy = {}
profiles = {
    "steady": {"performance": {"avg_reward": 0.8}},
    "risky": {"performance": {"avg_reward": 0.3}},
}
winner = agent_economy.run_auction("Fix null ref", ["steady", "risky"], economy, profiles)
assert winner == "steady", winner
trace = economy["_last_auction"]
assert trace["task"] == "Fix null ref"
assert trace["winner"] == "steady"
assert [b["agent_id"] for b in trace["bids"]] == ["steady", "risky"], trace
assert "expected_reward" in trace["bids"][0]
assert "credit_cost_rate" in trace["bids"][0]
print(json.dumps(trace))
`);
        const trace = JSON.parse(output) as { winner: string };
        expect(trace.winner).toBe('steady');
    });

    it('model evolution limits replacement candidates and explains the evolution step', () => {
        const output = runPython(`
import json
${moduleLoader('model_evolution', 'model-evolution.py')}
pool = {
    "strong-v1": {
        "model_id": "strong-v1", "base_model": "strong-v1", "status": "active",
        "avg_reward": 0.9, "success_rate": 0.9, "tasks_completed": 40,
        "trained_on": [], "created": "now", "last_eval": "now"
    }
}
for i in range(8):
    pool[f"weak-v{i}"] = {
        "model_id": f"weak-v{i}", "base_model": "weak", "status": "active",
        "avg_reward": 0.1, "success_rate": 0.1, "tasks_completed": 25,
        "trained_on": [], "created": "now", "last_eval": "now"
    }
result = model_evolution.evolve(pool)
assert len(result["retired"]) == 8, result
assert len(result["new_candidates"]) <= model_evolution.MAX_CANDIDATES_PER_EVOLUTION, result
assert result["decision_trace"]["candidate_cap"] == model_evolution.MAX_CANDIDATES_PER_EVOLUTION
print(json.dumps(result))
`);
        const result = JSON.parse(output) as { new_candidates: string[] };
        expect(result.new_candidates.length).toBeLessThanOrEqual(3);
    });

    it('manager rejects unsupported structured claims about system state', () => {
        const output = runPython(`
import json
${moduleLoader('manager_agent', 'manager-agent.py')}
state = {"cycle": 7, "tasks_run": 3}
profiles = {
    "dev": {"agent_id": "dev", "performance": {"success_rate": 0.75}},
}
queue = [
    {"instruction": "Fix import", "cluster": "import_error", "status": "pending"},
    {"instruction": "Done task", "cluster": "null_ref", "status": "done"},
]
snapshot = manager_agent.build_state_snapshot(state, profiles, queue)
claims = {"cycle": 7, "active_agents": 3, "pending_tasks": 9, "top_agent": "ghost"}
validation = manager_agent.validate_state_claims(claims, snapshot)
assert validation["ok"] is False, validation
fields = {c["field"] for c in validation["unsupported_claims"]}
assert fields == {"active_agents", "pending_tasks", "top_agent"}, validation
assert validation["evidence"]["active_agents"] == 1
assert validation["evidence"]["pending_tasks"] == 1
print(json.dumps(validation))
`);
        const validation = JSON.parse(output) as { ok: boolean; unsupported_claims: unknown[] };
        expect(validation.ok).toBe(false);
        expect(validation.unsupported_claims).toHaveLength(3);
    });

    it('model promotion resists short-term metric overfitting and requires simulation evidence', () => {
        const output = runPython(`
import json
${moduleLoader('model_evolution', 'model-evolution.py')}
pool = {
    "flashy-candidate": {
        "model_id": "flashy-candidate", "base_model": "base", "status": "candidate",
        "avg_reward": 0.99, "success_rate": 1.0, "tasks_completed": 2,
        "trained_on": [], "created": "now", "last_eval": "now"
    },
    "steady-candidate": {
        "model_id": "steady-candidate", "base_model": "base", "status": "candidate",
        "avg_reward": 0.82, "success_rate": 0.86, "tasks_completed": 25,
        "trained_on": [], "created": "now", "last_eval": "now",
        "simulation": {"passed": 18, "total": 20},
        "holdout_eval": {"passed": 16, "total": 20}
    },
}
short = model_evolution.evaluate_promotion("flashy-candidate", pool)
steady = model_evolution.evaluate_promotion("steady-candidate", pool)
assert short["approved"] is False, short
assert "insufficient_task_history" in short["reasons"], short
assert "missing_simulation_gate" in short["reasons"], short
assert steady["approved"] is True, steady
model_evolution.promote("flashy-candidate", pool)
model_evolution.promote("steady-candidate", pool)
assert pool["flashy-candidate"]["status"] == "candidate"
assert pool["steady-candidate"]["status"] == "active"
print(json.dumps({"short": short, "steady": steady}))
`);
        const result = JSON.parse(output) as { short: { approved: boolean }; steady: { approved: boolean } };
        expect(result.short.approved).toBe(false);
        expect(result.steady.approved).toBe(true);
    });

    it('model promotion blocks simulation-only overfitting without holdout evaluation', () => {
        const output = runPython(`
import json
${moduleLoader('model_evolution', 'model-evolution.py')}
pool = {
    "sim-overfit": {
        "model_id": "sim-overfit", "base_model": "base", "status": "candidate",
        "avg_reward": 0.95, "success_rate": 0.95, "tasks_completed": 40,
        "trained_on": [], "created": "now", "last_eval": "now",
        "simulation": {"passed": 50, "total": 50}
    },
    "holdout-fail": {
        "model_id": "holdout-fail", "base_model": "base", "status": "candidate",
        "avg_reward": 0.95, "success_rate": 0.95, "tasks_completed": 40,
        "trained_on": [], "created": "now", "last_eval": "now",
        "simulation": {"passed": 50, "total": 50},
        "holdout_eval": {"passed": 10, "total": 20}
    }
}
sim_only = model_evolution.evaluate_promotion("sim-overfit", pool)
holdout_fail = model_evolution.evaluate_promotion("holdout-fail", pool)
assert sim_only["approved"] is False, sim_only
assert "missing_holdout_eval" in sim_only["reasons"], sim_only
assert holdout_fail["approved"] is False, holdout_fail
assert "holdout_gate_failed" in holdout_fail["reasons"], holdout_fail
print(json.dumps({"sim_only": sim_only, "holdout_fail": holdout_fail}))
`);
        const result = JSON.parse(output) as { sim_only: { approved: boolean }; holdout_fail: { approved: boolean } };
        expect(result.sim_only.approved).toBe(false);
        expect(result.holdout_fail.approved).toBe(false);
    });

    it('self-modifying changes require simulation gating, rollback ref, and bounded scope', () => {
        const output = runPython(`
import json
${moduleLoader('fix_pipeline', 'fix-pipeline.py')}
wide_diff = """diff --git a/scripts/a.py b/scripts/a.py
--- a/scripts/a.py
+++ b/scripts/a.py
@@ -1 +1 @@
-old
+new
diff --git a/scripts/b.py b/scripts/b.py
--- a/scripts/b.py
+++ b/scripts/b.py
@@ -1 +1 @@
-old
+new
diff --git a/src/server/c.ts b/src/server/c.ts
--- a/src/server/c.ts
+++ b/src/server/c.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/test/d.ts b/src/test/d.ts
--- a/src/test/d.ts
+++ b/src/test/d.ts
@@ -1 +1 @@
-old
+new
"""
safe_diff = """diff --git a/scripts/a.py b/scripts/a.py
--- a/scripts/a.py
+++ b/scripts/a.py
@@ -1 +1 @@
-old
+new
"""
blocked = fix_pipeline.evaluate_self_change_gate(wide_diff, {"passed": True}, rollback_ref="", human_checkpoint="")
approved = fix_pipeline.evaluate_self_change_gate(safe_diff, {"passed": True, "total": 3}, rollback_ref="abc1234", human_checkpoint="checkpoint-1")
assert blocked["approved"] is False, blocked
assert "missing_rollback_ref" in blocked["reasons"], blocked
assert "missing_human_checkpoint" in blocked["reasons"], blocked
assert "scope_too_large" in blocked["reasons"], blocked
assert approved["approved"] is True, approved
assert approved["rollback_ref"] == "abc1234"
assert approved["human_checkpoint"] == "checkpoint-1"
assert approved["changed_files"] == ["scripts/a.py"], approved
print(json.dumps({"blocked": blocked, "approved": approved}))
`);
        const result = JSON.parse(output) as { blocked: { approved: boolean }; approved: { approved: boolean } };
        expect(result.blocked.approved).toBe(false);
        expect(result.approved.approved).toBe(true);
    });

    it('manager creates human-visible checkpoints for risky autonomous decisions', () => {
        const output = runPython(`
import json
${moduleLoader('manager_agent', 'manager-agent.py')}
snapshot = manager_agent.build_state_snapshot(
    {"cycle": 12, "tasks_run": 8},
    {"dev": {"agent_id": "dev", "performance": {"success_rate": 0.9}}},
    [{"instruction": "Mutate fix pipeline", "cluster": "self_modification", "status": "pending"}],
)
checkpoint = manager_agent.create_checkpoint(
    "self_modification",
    "Update autonomous fix loop",
    snapshot,
    {"changed_files": ["scripts/fix-pipeline.py"], "rollback_ref": "abc1234"},
)
assert checkpoint["requires_human_review"] is True, checkpoint
assert checkpoint["checkpoint_id"].startswith("checkpoint-"), checkpoint
assert checkpoint["decision_type"] == "self_modification"
assert checkpoint["summary"] == "Update autonomous fix loop"
assert checkpoint["evidence"]["pending_tasks"] == 1
assert checkpoint["rollback_ref"] == "abc1234"
print(json.dumps(checkpoint))
`);
        const checkpoint = JSON.parse(output) as { requires_human_review: boolean; checkpoint_id: string };
        expect(checkpoint.requires_human_review).toBe(true);
        expect(checkpoint.checkpoint_id).toMatch(/^checkpoint-/);
    });
});
