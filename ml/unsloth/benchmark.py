"""
Benchmark: Base qwen3:8b vs Unsloth fine-tuned model on Meitheal agent tasks.
Measures: response quality (scored), latency, and tokens/second.
Requires Ollama running with both models available.
"""

import json
import time
import sys
from pathlib import Path

try:
    import requests
except ImportError:
    import urllib.request
    import urllib.error

    class requests:
        @staticmethod
        def post(url, json=None, timeout=None):
            data = json_module.dumps(json).encode() if json else None
            req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
            try:
                resp = urllib.request.urlopen(req, timeout=timeout)
                return type("Resp", (), {"ok": True, "json": lambda: json_module.loads(resp.read())})()
            except urllib.error.HTTPError as e:
                return type("Resp", (), {"ok": False, "status_code": e.code})()

import json as json_module

OLLAMA_HOST = "http://localhost:11434"
BASE_MODEL = "qwen3:8b"
TUNED_MODEL = "meitheal-tuned:latest"
CUSTOM_MODEL = "meitheal-local:latest"
OUTPUT_DIR = Path(__file__).parent / "output"

BENCHMARK_PROMPTS = [
    {
        "category": "story_generation",
        "system": "You are a product owner AI that generates Agility story fields as HTML. Return a SINGLE JSON object with keys: description, acceptanceCriteria, frontend, backend, qa. JSON ONLY.",
        "prompt": "Story: Add error boundary component to catch React rendering crashes\nContext files: src/components/ErrorBoundary.tsx, src/app/App.tsx, src/services/ErrorReporter.ts",
        "quality_checks": ["description", "acceptanceCriteria", "frontend", "qa", "<ul>", "<li>"],
    },
    {
        "category": "story_generation",
        "system": "You are a product owner AI that generates Agility story fields as HTML. Return a SINGLE JSON object with keys: description, acceptanceCriteria, frontend, backend, qa. JSON ONLY.",
        "prompt": "Story: Implement retry logic for failed API calls with exponential backoff\nContext files: src/utils/apiClient.ts, src/hooks/useFetch.ts",
        "quality_checks": ["description", "acceptanceCriteria", "backend", "<ul>", "<li>", "exponential"],
    },
    {
        "category": "code_generation",
        "system": "You are a senior frontend engineer. Return only code, no explanations unless asked.",
        "prompt": "Write a TypeScript function that deep-merges two objects, with the second object taking priority. Handle arrays by replacing (not concatenating).",
        "quality_checks": ["function", "typeof", "return", "object", "Object"],
    },
    {
        "category": "code_generation",
        "system": "You are a senior frontend engineer. Return only code, no explanations unless asked.",
        "prompt": "Write a React hook called useInterval that calls a callback at a specified interval, properly handling cleanup and callback changes.",
        "quality_checks": ["useEffect", "useRef", "setInterval", "clearInterval", "callback"],
    },
    {
        "category": "test_writing",
        "system": "You are a senior frontend engineer. Return only code, no explanations unless asked.",
        "prompt": "Write Vitest tests for a function slugify(text: string) that converts text to URL-safe slugs. Test spaces, special characters, unicode, and empty string.",
        "quality_checks": ["describe", "it(", "expect", "slugify", "toBe"],
    },
    {
        "category": "review_summary",
        "system": "You are a code reviewer. Provide a concise PR review summary with findings categorized as: Critical, Warning, Suggestion.",
        "prompt": "Review this diff:\n```diff\n+app.get('/api/users/:id', (req, res) => {\n+  const user = users.find(u => u.id == req.params.id);\n+  res.json(user);\n+});\n```",
        "quality_checks": ["Critical", "Warning", "Suggestion", "null", "undefined"],
    },
]


def call_ollama(model: str, system: str, prompt: str, timeout: int = 120) -> dict:
    """Call Ollama generate API and return response with timing."""
    payload = {
        "model": model,
        "system": system,
        "prompt": prompt,
        "stream": False,
        "options": {"num_predict": 1500, "temperature": 0.1},
    }

    t0 = time.time()
    try:
        if hasattr(requests, "post") and callable(requests.post):
            resp = requests.post(f"{OLLAMA_HOST}/api/generate", json=payload, timeout=timeout)
        else:
            data = json_module.dumps(payload).encode()
            import urllib.request
            req = urllib.request.Request(
                f"{OLLAMA_HOST}/api/generate",
                data=data,
                headers={"Content-Type": "application/json"},
            )
            resp_raw = urllib.request.urlopen(req, timeout=timeout)
            resp = type("R", (), {"ok": True, "json": lambda: json_module.loads(resp_raw.read())})()

        elapsed = time.time() - t0
        if not resp.ok:
            return {"error": f"HTTP {resp.status_code}", "elapsed": elapsed}
        data = resp.json()
        return {
            "response": data.get("response", ""),
            "elapsed": elapsed,
            "eval_count": data.get("eval_count", 0),
            "prompt_eval_count": data.get("prompt_eval_count", 0),
            "tokens_per_sec": data.get("eval_count", 0) / elapsed if elapsed > 0 else 0,
        }
    except Exception as e:
        return {"error": str(e), "elapsed": time.time() - t0}


def score_response(response: str, quality_checks: list[str]) -> dict:
    """Score a response based on expected content markers."""
    if not response:
        return {"score": 0, "hits": 0, "total": len(quality_checks), "details": []}

    hits = []
    for check in quality_checks:
        found = check.lower() in response.lower()
        hits.append({"check": check, "found": found})

    hit_count = sum(1 for h in hits if h["found"])
    return {
        "score": round(hit_count / len(quality_checks), 2),
        "hits": hit_count,
        "total": len(quality_checks),
        "details": hits,
    }


def check_json_valid(response: str) -> bool:
    """Check if a response is valid JSON (for story generation tasks)."""
    try:
        text = response.strip()
        if text.startswith("```"):
            lines = text.split("\n")
            text = "\n".join(lines[1:-1]) if lines[-1].strip() == "```" else "\n".join(lines[1:])
        json_module.loads(text)
        return True
    except (json_module.JSONDecodeError, ValueError):
        return False


def run_benchmark(models: list[str]) -> dict:
    """Run all benchmark prompts against all models."""
    results = {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"), "models": {}}

    for model in models:
        print(f"\n{'='*50}")
        print(f"  Benchmarking: {model}")
        print(f"{'='*50}")

        model_results = {"prompts": [], "summary": {}}
        total_score = 0
        total_latency = 0
        total_tps = 0
        valid_json_count = 0
        json_prompts = 0

        for i, bench in enumerate(BENCHMARK_PROMPTS):
            print(f"  [{i+1}/{len(BENCHMARK_PROMPTS)}] {bench['category']}...", end=" ", flush=True)

            result = call_ollama(model, bench["system"], bench["prompt"])

            if "error" in result:
                print(f"ERROR: {result['error']}")
                model_results["prompts"].append({
                    "category": bench["category"],
                    "error": result["error"],
                })
                continue

            scoring = score_response(result["response"], bench["quality_checks"])
            is_json_task = bench["category"] == "story_generation"
            json_valid = check_json_valid(result["response"]) if is_json_task else None

            print(f"score={scoring['score']:.0%} latency={result['elapsed']:.1f}s tps={result['tokens_per_sec']:.0f}")

            prompt_result = {
                "category": bench["category"],
                "score": scoring["score"],
                "latency_s": round(result["elapsed"], 2),
                "tokens_per_sec": round(result["tokens_per_sec"], 1),
                "output_tokens": result["eval_count"],
                "json_valid": json_valid,
            }
            model_results["prompts"].append(prompt_result)

            total_score += scoring["score"]
            total_latency += result["elapsed"]
            total_tps += result["tokens_per_sec"]
            if is_json_task:
                json_prompts += 1
                if json_valid:
                    valid_json_count += 1

        n = len([p for p in model_results["prompts"] if "error" not in p])
        model_results["summary"] = {
            "avg_score": round(total_score / n, 3) if n else 0,
            "avg_latency_s": round(total_latency / n, 2) if n else 0,
            "avg_tokens_per_sec": round(total_tps / n, 1) if n else 0,
            "json_validity_rate": round(valid_json_count / json_prompts, 2) if json_prompts else None,
            "prompts_completed": n,
            "prompts_failed": len(BENCHMARK_PROMPTS) - n,
        }

        results["models"][model] = model_results
        print(f"\n  Summary for {model}:")
        print(f"    Avg quality score: {model_results['summary']['avg_score']:.1%}")
        print(f"    Avg latency: {model_results['summary']['avg_latency_s']:.1f}s")
        print(f"    Avg tokens/sec: {model_results['summary']['avg_tokens_per_sec']:.0f}")
        if model_results["summary"]["json_validity_rate"] is not None:
            print(f"    JSON validity: {model_results['summary']['json_validity_rate']:.0%}")

    return results


def main():
    print("Meitheal Model Benchmark")
    print("=" * 60)

    # Check which models are available
    try:
        if hasattr(requests, "post"):
            import urllib.request
            resp = urllib.request.urlopen(f"{OLLAMA_HOST}/api/tags", timeout=5)
            tags = json_module.loads(resp.read())
        else:
            resp = requests.post(f"{OLLAMA_HOST}/api/tags", timeout=5)
            tags = resp.json()
    except Exception as e:
        print(f"ERROR: Cannot reach Ollama at {OLLAMA_HOST}: {e}")
        print("Make sure Ollama is running (ollama serve)")
        sys.exit(1)

    available = [m.get("name", m.get("model", "")) for m in tags.get("models", [])]
    print(f"Available models: {available}")

    models_to_test = []
    for m in [BASE_MODEL, CUSTOM_MODEL, TUNED_MODEL]:
        base = m.split(":")[0]
        if any(base in a for a in available):
            models_to_test.append(m)
            print(f"  [OK] {m}")
        else:
            print(f"  [--] {m} (not found, skipping)")

    if not models_to_test:
        print("ERROR: No models available to benchmark")
        sys.exit(1)

    results = run_benchmark(models_to_test)

    # Save results
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_file = OUTPUT_DIR / "benchmark_results.json"
    with open(output_file, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nResults saved to {output_file}")

    # Print comparison table
    if len(models_to_test) > 1:
        print("\n" + "=" * 60)
        print("COMPARISON TABLE")
        print("=" * 60)
        print(f"{'Model':<30} {'Quality':>8} {'Latency':>8} {'TPS':>6} {'JSON':>6}")
        print("-" * 60)
        for model in models_to_test:
            s = results["models"][model]["summary"]
            json_str = f"{s['json_validity_rate']:.0%}" if s["json_validity_rate"] is not None else "N/A"
            print(f"{model:<30} {s['avg_score']:>7.0%} {s['avg_latency_s']:>7.1f}s {s['avg_tokens_per_sec']:>5.0f} {json_str:>6}")


if __name__ == "__main__":
    main()
