"use strict";

/**
 * extractor.js — LLM-powered extraction of tasks, decisions, and questions
 * from meeting transcript chunks.
 *
 * All calls go through the Mesh router at MESH_API so the same model ladder
 * (sdlc-tuned → qwen3:8b → stronger fallbacks) handles routing.
 */

const axios = require("axios");

const MESH_API   = process.env.MESH_API  || "http://localhost:9337/v1";
const MODEL      = process.env.EXTRACTION_MODEL || "qwen3:8b";
const CONFIDENCE = parseFloat(process.env.CONFIDENCE_THRESHOLD || "0.65");

// ─── Prompts ──────────────────────────────────────────────────────────────────

const TASK_PROMPT = (context, text) => `\
You are an engineering assistant analyzing a software team meeting.

Recent conversation context:
${context}

New message: "${text}"

Does this message contain a concrete coding task, bug fix, refactor, or feature request?
If yes, output a JSON object:
{"task": "short imperative description", "confidence": 0.0-1.0, "cluster": "null_ref|async_await|type_error|refactor|feature|other"}

If no actionable task is present, output: {"task": null, "confidence": 0.0, "cluster": null}

Output ONLY valid JSON, no explanation.`;

const DECISION_PROMPT = (context, text) => `\
You are an engineering assistant analyzing a software team meeting.

Recent conversation context:
${context}

New message: "${text}"

Does this message record an architectural or product decision (not a task, but a choice the team has made)?
Examples: "we decided to use X", "let's move Y to Z", "we agreed to deprecate W"

If yes, output: {"decision": "concise statement of the decision", "confidence": 0.0-1.0}
If no decision: {"decision": null, "confidence": 0.0}

Output ONLY valid JSON.`;

const QUESTION_PROMPT = (context, text) => `\
You are an engineering assistant analyzing a software team meeting.

Recent conversation context:
${context}

New message: "${text}"

Does this message raise an unresolved technical question that needs follow-up?

If yes: {"question": "the question", "confidence": 0.0-1.0}
If no:  {"question": null, "confidence": 0.0}

Output ONLY valid JSON.`;

// ─── LLM call ────────────────────────────────────────────────────────────────

async function callMesh(prompt) {
  const resp = await axios.post(`${MESH_API}/chat/completions`, {
    model:    MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.0,
    max_tokens:  128,
  }, { timeout: 15_000 });
  return resp.data.choices[0].message.content.trim();
}

function parseJson(raw) {
  try {
    // Strip markdown code fences if present
    const cleaned = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract a coding task from a message, given recent transcript context.
 * Returns { task, confidence, cluster } or null if nothing found / below threshold.
 */
async function extractTask(text, transcriptContext = "") {
  try {
    const raw    = await callMesh(TASK_PROMPT(transcriptContext, text));
    const parsed = parseJson(raw);
    if (!parsed || !parsed.task || parsed.confidence < CONFIDENCE) return null;
    return {
      task:       parsed.task,
      confidence: parsed.confidence,
      cluster:    parsed.cluster || "other",
    };
  } catch (err) {
    console.error("[extractor] task extraction failed:", err.message);
    return null;
  }
}

/**
 * Extract an architectural decision from a message.
 * Returns { decision, confidence } or null.
 */
async function extractDecision(text, transcriptContext = "") {
  try {
    const raw    = await callMesh(DECISION_PROMPT(transcriptContext, text));
    const parsed = parseJson(raw);
    if (!parsed || !parsed.decision || parsed.confidence < CONFIDENCE) return null;
    return { decision: parsed.decision, confidence: parsed.confidence };
  } catch (err) {
    console.error("[extractor] decision extraction failed:", err.message);
    return null;
  }
}

/**
 * Extract an unresolved question from a message.
 * Returns { question, confidence } or null.
 */
async function extractQuestion(text, transcriptContext = "") {
  try {
    const raw    = await callMesh(QUESTION_PROMPT(transcriptContext, text));
    const parsed = parseJson(raw);
    if (!parsed || !parsed.question || parsed.confidence < CONFIDENCE) return null;
    return { question: parsed.question, confidence: parsed.confidence };
  } catch (err) {
    console.error("[extractor] question extraction failed:", err.message);
    return null;
  }
}

/**
 * Run all three extractors in parallel on a single message.
 * Returns { task, decision, question } — each null if nothing found.
 */
async function extractAll(text, transcriptContext = "") {
  const [task, decision, question] = await Promise.all([
    extractTask(text, transcriptContext),
    extractDecision(text, transcriptContext),
    extractQuestion(text, transcriptContext),
  ]);
  return { task, decision, question };
}

module.exports = { extractTask, extractDecision, extractQuestion, extractAll };
