# Local AI & Ollama

SDLC Framework uses Ollama for local inference. On server start, the **Ollama Manager** (`src/server/ollamaManager.ts`) runs a boot sequence and then re-checks every 6 hours:

1. Pull the base model and compare the digest before/after — if the digest changes, the dashboard shows a green **↑ Updated** badge on the Ollama node in the Org Chart.
2. Pull `nomic-embed-text` (the RAG embedding model) if not already present.
3. Create `sdlc-local:latest` from the `Modelfile` in the project root (if it exists).

## Model Selection

The inference model is resolved in priority order:

1. `sdlc-tuned:latest` (QLoRA fine-tuned model, if present — see [Fine-Tuning](#fine-tuning))
2. `sdlc-local:latest` (custom Modelfile model, if created successfully)
3. `LOCAL_LLM_MODEL` env var override
4. `qwen3:8b` (default — 8B is the safe limit; 14B can exhaust GPU memory)

## Custom Modelfile

`Modelfile` at the project root defines a custom model baked with a system prompt tuned for Agility story generation:

```
FROM qwen3:8b
SYSTEM """
You are a product owner AI that generates Agility story fields as HTML.
[rules, exact JSON format, example output]
"""
PARAMETER temperature 0.1
PARAMETER repeat_penalty 1.1
PARAMETER num_predict 1500
PARAMETER num_ctx 4096
```

Run `ollama create sdlc-local:latest -f Modelfile` to build manually, or let the Ollama Manager create it on boot.

## RAG (Retrieval-Augmented Generation)

The RAG indexer (`src/server/ragIndex.ts`) builds a semantic vector index of the workspace at story-creation time:

- Chunks TypeScript/JS files on export boundaries (~800 chars per chunk)
- Embeds each chunk with `nomic-embed-text` via Ollama
- Caches the index at `.sdlc-framework/rag-{hash}.json` (24-hour TTL, per workspace)
- At story creation, the query is embedded and top-5 chunks are retrieved by cosine similarity and injected into the enrichment prompt

The dashboard shows a purple **RAG** badge on the Ollama node when the embedding model is ready.

To force a re-index: `POST /api/ollama/reindex` with `{ "workspaceDir": "..." }`.

## MeshLLM

SDLC Framework has server-side wiring for MeshLLM and an optional Docker Compose service for a local Mesh-LLM client node. You can also run MeshLLM yourself, or join an existing mesh, then point SDLC Framework at it with `MESHLLM_HOST`.

On server startup, SDLC Framework probes MeshLLM at `MESHLLM_HOST` (default `http://localhost:9337`). If that OpenAI-compatible service responds, these routes are available:

- `GET /api/meshllm/health`
- `GET /api/meshllm/models`
- `POST /api/meshllm/generate`

If MeshLLM is unavailable, `/api/meshllm/generate` falls back to local Ollama unless execution mode skips local fallback. MeshLLM token usage is tracked separately from `cloud` and `ollama` as `meshllm`.

### Docker setup

Start the optional Compose service:

```powershell
docker compose --profile meshllm up -d meshllm
```

That service builds the upstream Mesh-LLM client image from `Mesh-LLM/mesh-llm`, runs it in `APP_MODE=console`, exposes the OpenAI-compatible API at `http://localhost:9337/v1`, and exposes the Mesh-LLM console at `http://localhost:3131`.

The AI Command Room MeshLLM card uses the same Compose service for its **Start MeshLLM** button when Docker is available. If you install Mesh-LLM some other way, set `MESHLLM_START_COMMAND` before starting SDLC Framework.

### Manual setup

1. Install and run MeshLLM on the machine or mesh with the GPU capacity you want to use.
2. Set `MESHLLM_HOST` before starting the SDLC Framework API server:

```powershell
$env:MESHLLM_HOST = "http://your-gpu-box:9337"
npm run server
```

3. Confirm with `GET /api/meshllm/health`, or watch server logs for the MeshLLM detected line.

Short version: you can use more VRAM than this PC by running MeshLLM on a stronger machine, or on a distributed mesh, and setting `MESHLLM_HOST`. Local Ollama alone is still capped by this machine's GPU.

### Limits to be aware of

- The Compose service is a local Mesh-LLM client node; remote GPU capacity and mesh membership are still Mesh-LLM-side configuration.
- The dashboard can start the configured local service, but it does not provision remote GPUs or schedule MeshLLM workers.
- Help chat and many agent flows still use Ollama or cloud CLI paths unless that specific feature is wired through `meshllmGenerate`; the current integration is centered on `/api/meshllm/*`.
- Remote MeshLLM use requires network reachability and sensible security. Use a firewall or VPN, and do not expose port `9337` on the public internet without authentication.
- SDLC Framework does not verify your exact MeshLLM version, mesh membership, or which models your peers expose. That is MeshLLM-side configuration.
- `bin/import-unsloth-model.ps1` imports a fine-tuned model into local Ollama; it does not publish that model into a remote MeshLLM mesh.

## Inference Parameters (8B Tuning)

8B models work best with conservative settings to improve JSON reliability:

| Parameter      | Value | Reason |
|----------------|-------|--------|
| `temperature`  | 0.1   | Reduces hallucinations in structured output |
| `repeat_penalty`| 1.1  | Prevents repetition loops |
| `num_predict`  | 1500  | Caps output length |
| `num_ctx`      | 4096  | Fits within 8B context window |

## Fine-Tuning

The `ml/unsloth/` directory contains a QLoRA fine-tuning pipeline that produces a domain-adapted `sdlc-tuned:latest` model for story field generation. Once deployed to Ollama, it becomes the highest-priority inference model.

**What it learns:** 36 examples of `(story title + context files) → structured JSON` with HTML-formatted `description`, `acceptanceCriteria`, `frontend`, `backend`, and `qa` fields.

**Requirements:** NVIDIA GPU with ≥8 GB VRAM, CUDA 12.6, Python 3.12.

**One-time setup:**

```powershell
cd ml\unsloth
.\setup-env.ps1          # creates venv, installs deps, sets HF_HOME + output junction
```

`setup-env.ps1` creates two shared, persistent paths outside the repo so large model files survive worktree deletion and are never duplicated:

| Path | Contents | Size |
|------|----------|------|
| `C:\ml\hf_cache` | HuggingFace model cache (base Qwen3-8B weights) | ~16 GB |
| `C:\ml\models\sdlc-framework\output` | LoRA adapter, merged weights, GGUF | ~25 GB |

`ml\unsloth\output\` is a **junction** pointing to `C:\ml\models\sdlc-framework\output`. All worktrees share the same junction target — re-running `setup-env.ps1` from any worktree will create the junction there too without re-downloading or re-moving the files.

**Training and export:**

```powershell
.\.venv\Scripts\Activate.ps1
python train.py           # ~16 min on RTX 3500 Ada, produces output\lora-adapter\
python export_gguf.py     # merges LoRA + converts to GGUF (downloads ~16 GB base model once)
ollama create sdlc-tuned -f Modelfile.tuned
```

The base model download is cached to `HF_HOME` and is not repeated on subsequent exports.

**Expanding the dataset:**

Add examples to `ml/unsloth/data/train.jsonl` in ShareGPT format:

```jsonl
{"conversations": [
  {"role": "system", "content": "You are a product owner AI..."},
  {"role": "user",   "content": "Story: <title>\nContext files: <paths>"},
  {"role": "assistant", "content": "{\"description\": \"...\", ...}"}
]}
```

Target 100–200 examples for better generalization. Re-run `train.py` then `export_gguf.py` to update the model.

**Tests:**

```powershell
python -m pytest tests/   # 15 unit tests, no GPU required
```

See `ml/unsloth/REPORT.md` for full training metrics and benchmark results.

---

## Local Mock Integrations

Plain `sdlc-framework` runs in live mode. Use `sdlc-framework --test` to run the TUI with local mock Agility, Azure DevOps, and Teams integrations, or set `"externalMode": "mock"` / `SDLC_EXTERNAL_MODE=mock` for other entry points such as the web dashboard. Mock state is stored in `.sdlc-framework/mock/state.json`; story pickup, task creation, PR creation, pipeline runs, and notifications stay local.

When the dashboard server is running, mock mode also exposes a VersionOne-compatible local API for MCP testing:

```
AGILITY_BASE_URL=http://localhost:3847/mock-v1
AGILITY_API_KEY=mock-token
```

The bundled Agility MCP then calls `http://localhost:3847/mock-v1/rest-1.v1/Data/...` with the same paths it uses for live Agility, backed by `.sdlc-framework/mock/state.json`.
