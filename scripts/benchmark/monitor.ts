import { initDb, getDb } from '../../src/server/db';
import path from 'path';

initDb(path.join(__dirname, '../../.data'));
const db = getDb();
import { writeFileSync } from 'fs';

interface AgentActivity {
  workflowItemId: number;
  storyNumber: string;
  storyName: string;
  phases: {
    phase: string;
    agentId: string;
    timestamp: number;
    toolsUsed: string[];
  }[];
  handoffs: {
    fromAgent: string;
    toAgent: string;
    timestamp: number;
  }[];
  tokensUsed: number;
}

/**
 * Monitors agent activity for benchmarked work items.
 * Usage: npx tsx scripts/benchmark/monitor.ts
 */
async function monitorActivity() {
  const activityMap = new Map<number, AgentActivity>();

  // Poll every 5 seconds
  const interval = setInterval(() => {
    const workflowItems = db.prepare(
      'SELECT id, story_number, story_name FROM workflow_items WHERE story_number LIKE ?'
    ).all(['BENCH-%']) as { id: number; story_number: string; story_name: string }[];

    for (const item of workflowItems) {
      if (!activityMap.has(item.id)) {
        activityMap.set(item.id, {
          workflowItemId: item.id,
          storyNumber: item.story_number,
          storyName: item.story_name,
          phases: [],
          handoffs: [],
          tokensUsed: 0
        });
      }

      const activity = activityMap.get(item.id)!;
      const phases = db.prepare(
        'SELECT * FROM phase_events WHERE workflow_item_id = ? ORDER BY created_at ASC'
      ).all([item.id]) as {
        agent_id: string;
        phase: string;
        created_at: number;
        outputs_json: string;
      }[];

      // Update phases and tools
      for (const phase of phases) {
        if (!activity.phases.some(p => p.timestamp === phase.created_at)) {
          const outputs = JSON.parse(phase.outputs_json || '{}');
          const toolsUsed = outputs.toolsUsed || [];
          activity.phases.push({
            phase: phase.phase,
            agentId: phase.agent_id,
            timestamp: phase.created_at,
            toolsUsed
          });
          activity.tokensUsed += outputs.tokensUsed || 0;
        }
      }

      // Detect handoffs (phase transitions between agents)
      for (let i = 1; i < activity.phases.length; i++) {
        const prev = activity.phases[i - 1];
        const curr = activity.phases[i];
        if (prev.agentId !== curr.agentId) {
          activity.handoffs.push({
            fromAgent: prev.agentId,
            toAgent: curr.agentId,
            timestamp: curr.timestamp
          });
        }
      }
    }

    // Write snapshot to file
    const snapshot = Array.from(activityMap.values());
    writeFileSync('scripts/benchmark/activity-snapshot.json', JSON.stringify(snapshot, null, 2));
    console.log(`Monitoring ${workflowItems.length} work items...`);
  }, 5000);

  // Stop after 30 minutes
  setTimeout(() => {
    clearInterval(interval);
    console.log('Monitoring complete. Final snapshot saved.');
  }, 30 * 60 * 1000);
}

monitorActivity().catch(console.error);