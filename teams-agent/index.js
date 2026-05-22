"use strict";

require("dotenv").config();

const restify = require("restify");
const { ActivityHandler, BotFrameworkAdapter, TurnContext } = require("botbuilder");
const axios   = require("axios");

const { extractAll } = require("./extractor");
const memory         = require("./meeting-memory");

const BRIDGE_URL = process.env.BRIDGE_URL || "http://localhost:9338";
const PORT       = parseInt(process.env.PORT || "3978", 10);

// ─── Bot ──────────────────────────────────────────────────────────────────────

class MeetingAgent extends ActivityHandler {
  constructor() {
    super();

    this.onMembersAdded(async (context, next) => {
      for (const member of context.activity.membersAdded) {
        if (member.id !== context.activity.recipient.id) {
          await context.sendActivity(
            "SDLC Framework meeting agent active. I'll track decisions, extract coding tasks, " +
            "and route them to the autonomous pipeline automatically."
          );
        }
      }
      await next();
    });

    this.onMessage(async (context, next) => {
      await this._handleMessage(context);
      await next();
    });

    // Handle meeting transcript events from Graph API subscription (optional)
    this.onEvent(async (context, next) => {
      if (context.activity.name === "application/vnd.microsoft.meetingTranscription") {
        await this._handleTranscriptEvent(context);
      }
      await next();
    });
  }

  // ─── Core message handler ────────────────────────────────────────────────

  async _handleMessage(context) {
    const activity   = context.activity;
    const meetingId  = activity.conversation?.id || "default";
    const speaker    = activity.from?.name || "Unknown";
    const text       = (activity.text || "").trim();

    if (!text || text.length < 5) return;

    // Record in rolling transcript
    memory.addUtterance(meetingId, speaker, text);
    const transcriptCtx = memory.getTranscriptContext(meetingId, 8);

    console.log(`[${meetingId.slice(-8)}] ${speaker}: ${text.slice(0, 80)}`);

    // Run all extractors in parallel
    const { task, decision, question } = await extractAll(text, transcriptCtx);

    const replies = [];

    if (task) {
      console.log(`  -> TASK (${task.confidence.toFixed(2)}): ${task.task}`);
      memory.addTask(meetingId, task.task);

      const sent = await this._sendToPipeline({
        task:       task.task,
        cluster:    task.cluster,
        confidence: task.confidence,
        meeting_id: meetingId,
        speaker,
        context:    transcriptCtx,
      });

      if (sent) {
        memory.markTaskSent(meetingId, task.task);
        replies.push(
          `✅ **Task queued** (confidence ${(task.confidence * 100).toFixed(0)}%): ` +
          `*${task.task}*`
        );
      } else {
        replies.push(
          `⚠️ **Task detected** but pipeline unavailable: *${task.task}*\n` +
          `Run \`manager-agent.py queue --add "${task.task}"\` manually.`
        );
      }
    }

    if (decision) {
      console.log(`  -> DECISION (${decision.confidence.toFixed(2)}): ${decision.decision}`);
      memory.addDecision(meetingId, decision.decision);
      replies.push(
        `📌 **Decision recorded**: *${decision.decision}*`
      );
    }

    if (question) {
      console.log(`  -> QUESTION (${question.confidence.toFixed(2)}): ${question.question}`);
      memory.addQuestion(meetingId, question.question);
      replies.push(
        `❓ **Open question**: *${question.question}*`
      );
    }

    if (replies.length > 0) {
      await context.sendActivity(replies.join("\n\n"));
    }
  }

  // ─── Graph API transcript events ─────────────────────────────────────────

  async _handleTranscriptEvent(context) {
    const payload = context.activity.value || {};
    const entries = payload.transcriptItems || [];
    const meetingId = context.activity.conversation?.id || "default";

    for (const entry of entries) {
      const speaker = entry.speakerDisplayName || "Unknown";
      const text    = entry.text || "";
      if (!text.trim()) continue;

      memory.addUtterance(meetingId, speaker, text);
      const transcriptCtx = memory.getTranscriptContext(meetingId, 6);
      const { task, decision, question } = await extractAll(text, transcriptCtx);

      if (task) {
        memory.addTask(meetingId, task.task);
        await this._sendToPipeline({
          task:       task.task,
          cluster:    task.cluster,
          confidence: task.confidence,
          meeting_id: meetingId,
          speaker,
          context:    transcriptCtx,
        });
        console.log(`[transcript] TASK: ${task.task}`);
      }
      if (decision) {
        memory.addDecision(meetingId, decision.decision);
        console.log(`[transcript] DECISION: ${decision.decision}`);
      }
      if (question) {
        memory.addQuestion(meetingId, question.question);
      }
    }
  }

  // ─── Pipeline bridge ──────────────────────────────────────────────────────

  async _sendToPipeline(payload) {
    try {
      await axios.post(`${BRIDGE_URL}/task`, payload, { timeout: 5_000 });
      return true;
    } catch (err) {
      console.error("[bridge] POST failed:", err.message);
      return false;
    }
  }
}

// ─── Status endpoint ──────────────────────────────────────────────────────────

function addStatusRoute(server) {
  server.get("/status", (req, res, next) => {
    res.json({
      status:   "ok",
      meetings: memory.allSummaries(),
      bridge:   BRIDGE_URL,
      mesh:     process.env.MESH_API,
    });
    next();
  });

  // Manual task injection (for testing without Teams)
  server.post("/inject", restify.plugins.bodyParser(), async (req, res, next) => {
    const { text, speaker = "manual", meeting_id = "test" } = req.body || {};
    if (!text) {
      res.json(400, { error: "text required" });
      return next();
    }
    memory.addUtterance(meeting_id, speaker, text);
    const ctx = memory.getTranscriptContext(meeting_id, 6);
    const extracted = await extractAll(text, ctx);
    res.json({ extracted, memory: memory.getSummary(meeting_id) });
    next();
  });
}

// ─── Server bootstrap ─────────────────────────────────────────────────────────

const adapter = new BotFrameworkAdapter({
  appId:       process.env.MicrosoftAppId,
  appPassword: process.env.MicrosoftAppPassword,
});

adapter.onTurnError = async (context, err) => {
  console.error("[adapter error]", err);
  await context.sendActivity("I encountered an error — please check the pipeline logs.");
};

const bot    = new MeetingAgent();
const server = restify.createServer({ name: "sdlc-framework-teams-agent" });
server.use(restify.plugins.queryParser());

server.post("/api/messages", (req, res) => {
  adapter.processActivity(req, res, async (context) => {
    await bot.run(context);
  });
});

addStatusRoute(server);

server.listen(PORT, () => {
  console.log(`SDLC Framework Teams agent listening on http://localhost:${PORT}`);
  console.log(`  Mesh API : ${process.env.MESH_API || "http://localhost:9337/v1"}`);
  console.log(`  Bridge   : ${BRIDGE_URL}`);
  console.log(`  Status   : http://localhost:${PORT}/status`);
  console.log(`  Inject   : POST http://localhost:${PORT}/inject  { text, speaker, meeting_id }`);
});
