import { readFileSync, writeFileSync } from 'fs';

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

interface TestCase {
  title: string;
  description: string;
  repo: string;
  expected_phases?: string[];
  expected_tools?: string[];
}

/**
 * Evaluates benchmark results for SDLC agents.
 * Usage: npx tsx scripts/benchmark/evaluate.ts
 */
async function evaluateBenchmark() {
  // Load test cases and activity snapshot
  const testCases: TestCase[] = JSON.parse(readFileSync('scripts/benchmark/test-cases.json', 'utf-8'));
  const activities: AgentActivity[] = JSON.parse(readFileSync('scripts/benchmark/activity-snapshot.json', 'utf-8'));

  // Load agent skill definitions for validation (aligned with skills/SKILL.md)
  const agentSkills: Record<string, { phases: string[]; tools: string[] }> = {
    frontend: {
      phases: [
        'reading-story', 'analyzing', 'generating-code', 'validating', 
        'committing', 'creating-pr', 'watching-reviews', 'addressing-feedback', 
        'running-e2e', 'complete'
      ],
      tools: [
        'read_file', 'edit_file', 'create_pr', 'create_task', 
        'update_task', 'update_story_field', 'analyze' // Goose
      ]
    },
    backend: {
      phases: [
        'reading-story', 'analyzing', 'generating-code', 'validating', 
        'committing', 'creating-pr', 'watching-reviews', 'addressing-feedback', 
        'complete'
      ],
      tools: [
        'read_file', 'edit_file', 'create_pr', 'create_task', 
        'update_task', 'update_story_field', 'analyze' // Goose
      ]
    },
    reviewer: {
      phases: [
        'idle', 'pending-review', 'reviewing', 'commenting', 
        'approved', 'changes-requested', 'watching-build', 'waiting-for-fixes'
      ],
      tools: [
        'repo_get_pull_request_by_id', 'repo_list_pull_request_threads', 
        'repo_create_pull_request_thread', 'repo_vote_pull_request', 'get_story', 
        'analyze' // Goose
      ]
    },
    devops: {
      phases: [
        'idle', 'reading-story', 'analyzing', 'generating-code', 'validating', 
        'creating-pr', 'watching-reviews', 'pending-build', 'monitoring-build', 
        'build-passed', 'build-failed', 'complete'
      ],
      tools: [
        'repo_create_pull_request', 'repo_update_pull_request_reviewers', 
        'repo_get_pull_request_changes', 'repo_vote_pull_request', 
        'trigger_pipeline', 'get_build_status', 'complete_pull_request'
      ]
    },
    qa: {
      phases: [
        'idle', 'running-tests', 'triaging', 'writing-tests', 'complete'
      ],
      tools: [
        'read_file', 'edit_file', 'run_command' // Test runners
      ]
    },
    ux: {
      phases: [
        'idle', 'reading-story', 'analyzing', 'generating-design', 
        'collaborating', 'complete'
      ],
      tools: [
        'read_file', 'write_file', 'analyze' // Goose
      ]
    }
  };

  // Generate report
  let report = '# SDLC Framework Benchmark Report\n\n';
  let totalSuccess = 0;

  for (const testCase of testCases) {
    const activity = activities.find(a => a.storyName === testCase.title);
    if (!activity) {
      report += `## ❌ ${testCase.title}\n- **Status**: No activity recorded\n\n`;
      continue;
    }

    // Check if work item reached 'devops/done'
    const lastPhase = activity.phases[activity.phases.length - 1]?.phase;
    const success = lastPhase === 'devops/done';
    if (success) totalSuccess++;

    report += `## ${success ? '✅' : '❌'} ${testCase.title}\n`;
    report += `- **Story Number**: ${activity.storyNumber}\n`;
    report += `- **Status**: ${lastPhase}\n`;
    report += `- **Tokens Used**: ${activity.tokensUsed}\n`;
    report += `- **Time to Resolution**: ${((activity.phases[activity.phases.length - 1]?.timestamp - activity.phases[0]?.timestamp) / 60000).toFixed(2)} minutes\n`;
    report += `- **Phases**: ${activity.phases.map(p => p.phase).join(' → ')}\n`;
    report += `- **Handoffs**: ${activity.handoffs.length} (${activity.handoffs.map(h => `${h.fromAgent}→${h.toAgent}`).join(', ')})\n`;

    // Validate expected phases
    if (testCase.expected_phases) {
      const actualPhases = activity.phases.map(p => p.phase);
      const missingPhases = testCase.expected_phases.filter(p => !actualPhases.includes(p));
      if (missingPhases.length > 0) {
        report += `- **Phase Validation**: ❌ Missing phases: ${missingPhases.join(', ')}\n`;
      } else {
        report += `- **Phase Validation**: ✅ All expected phases completed\n`;
      }
    }

    // Validate expected tools
    if (testCase.expected_tools) {
      const actualTools = activity.phases.flatMap(p => p.toolsUsed);
      const missingTools = testCase.expected_tools.filter(t => !actualTools.includes(t));
      if (missingTools.length > 0) {
        report += `- **Tool Validation**: ❌ Missing tools: ${missingTools.join(', ')}\n`;
      } else {
        report += `- **Tool Validation**: ✅ All expected tools used\n`;
      }
    }

    // Validate agent skill adherence
    for (const phase of activity.phases) {
      const skill = agentSkills[phase.agentId];
      if (skill && !skill.phases.includes(phase.phase)) {
        report += `- **Skill Validation**: ❌ Agent ${phase.agentId} used phase '${phase.phase}' (not in skill definition)\n`;
      }
      for (const tool of phase.toolsUsed) {
        if (skill && !skill.tools.includes(tool)) {
          report += `- **Skill Validation**: ❌ Agent ${phase.agentId} used tool '${tool}' (not in skill definition)\n`;
        }
      }
    }

    report += '\n';
  }

  // Summary
  report += `## Summary\n`;
  report += `- **Success Rate**: ${totalSuccess}/${testCases.length} (${Math.round((totalSuccess / testCases.length) * 100)}%)\n`;
  report += `- **Average Tokens per Work Item**: ${activities.reduce((sum, a) => sum + a.tokensUsed, 0) / activities.length}\n`;
  report += `- **Average Time to Resolution**: ${(activities.reduce((sum, a) => sum + (a.phases[a.phases.length - 1]?.timestamp - a.phases[0]?.timestamp), 0) / activities.length / 60000).toFixed(2)} minutes\n`;

  // Write report
  writeFileSync('scripts/benchmark/report.md', report);
  console.log('Benchmark report generated: scripts/benchmark/report.md');
}

evaluateBenchmark().catch(console.error);