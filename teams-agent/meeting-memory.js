"use strict";

/**
 * meeting-memory.js — Per-meeting context: rolling transcript, decisions, tasks.
 *
 * Keyed by Teams conversation/meeting ID so multiple concurrent meetings
 * each have independent memory.
 */

const WINDOW_SIZE = parseInt(process.env.MEMORY_WINDOW || "20", 10);

class MeetingMemory {
  constructor() {
    /** @type {Map<string, MeetingContext>} */
    this._meetings = new Map();
  }

  /** Get or create a context for this conversation/meeting ID. */
  get(meetingId) {
    if (!this._meetings.has(meetingId)) {
      this._meetings.set(meetingId, {
        id:         meetingId,
        transcript: [],   // rolling window of {speaker, text, ts}
        decisions:  [],   // extracted architectural/product decisions
        tasks:      [],   // extracted coding tasks (sent to pipeline)
        questions:  [],   // unresolved questions flagged for follow-up
        startedAt:  new Date().toISOString(),
        updatedAt:  new Date().toISOString(),
      });
    }
    return this._meetings.get(meetingId);
  }

  /** Add a transcript entry and trim the rolling window. */
  addUtterance(meetingId, speaker, text) {
    const ctx = this.get(meetingId);
    ctx.transcript.push({ speaker, text, ts: new Date().toISOString() });
    if (ctx.transcript.length > WINDOW_SIZE) {
      ctx.transcript = ctx.transcript.slice(-WINDOW_SIZE);
    }
    ctx.updatedAt = new Date().toISOString();
  }

  addDecision(meetingId, decision) {
    const ctx = this.get(meetingId);
    ctx.decisions.push({ text: decision, ts: new Date().toISOString() });
  }

  addTask(meetingId, task) {
    const ctx = this.get(meetingId);
    ctx.tasks.push({ text: task, ts: new Date().toISOString(), sent: false });
  }

  addQuestion(meetingId, question) {
    const ctx = this.get(meetingId);
    ctx.questions.push({ text: question, ts: new Date().toISOString() });
  }

  markTaskSent(meetingId, taskText) {
    const ctx = this.get(meetingId);
    const t = ctx.tasks.find(t => t.text === taskText);
    if (t) t.sent = true;
  }

  /** Return last N transcript lines as a single string for LLM context. */
  getTranscriptContext(meetingId, n = 10) {
    const ctx = this.get(meetingId);
    return ctx.transcript
      .slice(-n)
      .map(u => `${u.speaker}: ${u.text}`)
      .join("\n");
  }

  /** Summary of what's been captured in this meeting so far. */
  getSummary(meetingId) {
    const ctx = this.get(meetingId);
    return {
      id:               ctx.id,
      utterances:       ctx.transcript.length,
      decisions:        ctx.decisions.length,
      tasks:            ctx.tasks.length,
      unsentTasks:      ctx.tasks.filter(t => !t.sent).length,
      questions:        ctx.questions.length,
      startedAt:        ctx.startedAt,
      updatedAt:        ctx.updatedAt,
    };
  }

  /** All meetings currently tracked. */
  allSummaries() {
    return Array.from(this._meetings.keys()).map(id => this.getSummary(id));
  }
}

module.exports = new MeetingMemory(); // singleton
