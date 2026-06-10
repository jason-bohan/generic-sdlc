import { initDb, getDb } from '../../src/server/db';
import path from 'path';

// Initialize the database
initDb(path.join(__dirname, '../../.data'));
const db = getDb();
import { readFileSync } from 'fs';

interface TestCase {
  title: string;
  description: string;
  repo: string;
  expected_phases?: string[];
  expected_tools?: string[];
}

/**
 * Injects test cases into the workflow_items table.
 * Usage: npx tsx scripts/benchmark/inject.ts <test-cases.json>
 */
async function injectTestCases() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: npx tsx scripts/benchmark/inject.ts <test-cases.json>');
    process.exit(1);
  }

  const testCases: TestCase[] = JSON.parse(readFileSync(filePath, 'utf-8'));
  const stmt = db.prepare(
    'INSERT INTO workflow_items (story_number, story_name, status, active_agent_id, active_phase, affected_repo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  for (const [index, testCase] of testCases.entries()) {
    const storyNumber = `BENCH-${Date.now()}-${index}`;
    stmt.run([
      storyNumber,
      testCase.title,
      'active', // status
      'planner', // active_agent_id (planner picks up first)
      'tasking', // active_phase
      testCase.repo, // affected_repo
      Date.now(), // created_at (UNIX timestamp → SQLite datetime)
      Date.now()  // updated_at
    ]);
    console.log(`Injected work item: ${storyNumber} - ${testCase.title}`);
  }
}

injectTestCases().catch(console.error);