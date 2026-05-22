/**
 * Plan Generator for SDLC Framework agents
 *
 * Takes an Agility story (as JSON from MCP) and produces a structured task breakdown.
 * Can use Ollama for initial analysis or accept a pre-built plan from the agent.
 *
 * Usage:
 *   npx tsx src/scripts/plan-generator.ts --story <json> [--use-ollama]
 *   npx tsx src/scripts/plan-generator.ts --story-file <path> [--use-ollama]
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface StoryInput {
    number: string;
    name: string;
    description?: string;
    acceptanceCriteria?: string;
    frontend?: string;
    backend?: string;
}

type TaskComplexity = 'complex' | 'lightweight';
type TaskCategory = 'Frontend' | 'QA' | 'Planning';

interface PlannedTask {
    name: string;
    description: string;
    complexity: TaskComplexity;
    category: TaskCategory;
    estimateHours: number;
    dependsOn: string[];
    ollamaPrompt?: string;
}

interface Plan {
    storyNumber: string;
    storyName: string;
    tasks: PlannedTask[];
    totalHours: number;
    complexCount: number;
    lightweightCount: number;
}

function classifyTask(name: string, description: string): TaskComplexity {
    const lightweightPatterns = [
        /model|interface|type/i,
        /boilerplate|scaffold/i,
        /lint|format/i,
        /simple.*test/i,
        /rename|move/i,
        /add.*import/i,
        /update.*style/i,
    ];

    const complexPatterns = [
        /service.*logic/i,
        /business.*rule/i,
        /routing|guard|resolver/i,
        /state.*management/i,
        /graphql|mutation|query/i,
        /shared.*module/i,
        /architecture|refactor/i,
        /security|auth/i,
    ];

    const text = `${name} ${description}`;

    const complexScore = complexPatterns.filter((p) => p.test(text)).length;
    const lightweightScore = lightweightPatterns.filter((p) => p.test(text)).length;

    return complexScore > lightweightScore ? 'complex' : 'lightweight';
}

function estimateHours(complexity: TaskComplexity, description: string): number {
    const base = complexity === 'complex' ? 3 : 1.5;
    const length = description.length;

    if (length > 500) return Math.min(base + 1, 4);
    if (length < 100) return Math.max(base - 0.5, 1);
    return base;
}

function generatePlanFromStory(story: StoryInput): Plan {
    const tasks: PlannedTask[] = [];

    if (story.acceptanceCriteria) {
        const criteria = story.acceptanceCriteria
            .replace(/<[^>]+>/g, '')
            .split(/\n|<br>|<li>|\d+\.\s/)
            .map((s) => s.trim())
            .filter((s) => s.length > 10);

        for (const criterion of criteria) {
            const complexity = classifyTask(criterion, story.description ?? '');
            const hours = estimateHours(complexity, criterion);

            tasks.push({
                name: criterion.slice(0, 80),
                description: criterion,
                complexity,
                category: 'Frontend',
                estimateHours: hours,
                dependsOn: [],
                ...(complexity === 'lightweight'
                    ? { ollamaPrompt: 'boilerplate.md' }
                    : {}),
            });
        }
    }

    if (tasks.length === 0) {
        tasks.push({
            name: `Implement ${story.name}`,
            description: story.description ?? story.name,
            complexity: 'complex',
            category: 'Frontend',
            estimateHours: 3,
            dependsOn: [],
        });
    }

    const hasTests = tasks.some((t) => /test/i.test(t.name));
    if (!hasTests) {
        tasks.push({
            name: 'Write unit tests',
            description: `Unit tests for all components and services created in ${story.number}`,
            complexity: 'lightweight',
            category: 'QA',
            estimateHours: 2,
            dependsOn: tasks.map((t) => t.name),
            ollamaPrompt: 'simple-test.md',
        });
    }

    const totalHours = tasks.reduce((sum, t) => sum + t.estimateHours, 0);

    return {
        storyNumber: story.number,
        storyName: story.name,
        tasks,
        totalHours,
        complexCount: tasks.filter((t) => t.complexity === 'complex').length,
        lightweightCount: tasks.filter((t) => t.complexity === 'lightweight').length,
    };
}

const args = process.argv.slice(2);

if (args.includes('--help') || args.length === 0) {
    console.log(`
SDLC Framework Plan Generator

Usage:
  npx tsx src/scripts/plan-generator.ts --story '<json>'
  npx tsx src/scripts/plan-generator.ts --story-file <path>

Options:
  --story <json>       Story JSON (from Agility MCP get_story)
  --story-file <path>  Path to story JSON file
  --help               Show this help

Output:
  JSON plan with tasks, complexity classifications, and hour estimates
`);
    process.exit(0);
}

let story: StoryInput | null = null;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--story' && i + 1 < args.length) {
        try {
            story = JSON.parse(args[++i]) as StoryInput;
        } catch (err) {
            console.error('Invalid --story JSON:', err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    } else if (args[i] === '--story-file' && i + 1 < args.length) {
        const filePath = resolve(process.cwd(), args[++i]);
        if (!existsSync(filePath)) {
            console.error(`File not found: ${filePath}`);
            process.exit(1);
        }
        try {
            story = JSON.parse(readFileSync(filePath, 'utf-8')) as StoryInput;
        } catch (err) {
            console.error('Invalid story file JSON:', err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    }
}

if (!story) {
    console.error('No story provided. Use --story or --story-file.');
    process.exit(1);
}

const plan = generatePlanFromStory(story);
console.log(JSON.stringify(plan, null, 2));
