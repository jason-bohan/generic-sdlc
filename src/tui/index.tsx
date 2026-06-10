import { Command } from 'commander';
import React from 'react';
import { render } from 'ink';

import App from './App';
import { AssignView } from './AssignView';
import { ChatView } from './ChatView';
import { ApproveView } from './ApproveView';
import { StatusView } from './StatusView';
import { AgentsView } from './AgentsView';
import { InteractiveView } from './InteractiveView';
import { TasksView } from './TasksView';
import { CreateStoryView } from './CreateStoryView';
import { DirectChatView } from './DirectChatView';
import { FleetView } from './FleetView';
import { OrchestrateView } from './OrchestrateView';
import { ProvidersView } from './ProvidersView';

const DEFAULT_DIR = process.env.SDLC_FRAMEWORK_WORKSPACE ?? process.cwd();
const COMMAND_NAME = process.env.SDLC_FRAMEWORK_CLI_NAME ?? 'sdlc-framework';

const program = new Command()
    .name(COMMAND_NAME)
    .description('SDLC Framework agent CLI — manage agents from the terminal')
    .version('0.1.0')
    .option('--dir <path>', 'workspace directory', DEFAULT_DIR)
    .option('--test', 'run with local mock integrations instead of Agility, Azure DevOps, and Teams');

program.hook('preAction', (cmd) => {
    if (cmd.opts().test) {
        process.env.SDLC_EXTERNAL_MODE = 'mock';
    }
});

program
    .command('interactive', { isDefault: true })
    .description('Interactive agent menu (default)')
    .helpGroup('Agent actions:')
    .argument('[agent]', 'agent to start with')
    .action((agent?: string) => {
        const dir = program.opts().dir;
        render(<InteractiveView agent={agent ?? null} dir={dir} />);
    });

program
    .command('dashboard')
    .description('Live agent dashboard with auto-refresh')
    .helpGroup('Monitoring:')
    .action(() => {
        const dir = program.opts().dir;
        render(<App dir={dir} />);
    });

program
    .command('assign <agent>')
    .description('Assign a story to an agent')
    .helpGroup('Agent actions:')
    .argument('[story]', 'story number (shows picker if omitted)')
    .action((agent: string, story?: string) => {
        const dir = program.opts().dir;
        render(<AssignView agent={agent} story={story} dir={dir} />);
    });

program
    .command('chat <agent>')
    .description('Interactive /btw chat session with an agent')
    .helpGroup('Agent actions:')
    .action((agent: string) => {
        const dir = program.opts().dir;
        render(<ChatView agent={agent} dir={dir} />);
    });

program
    .command('chatllm [agent]')
    .description('Direct AI chat with the configured model for an agent')
    .helpGroup('Agent actions:')
    .action((agent?: string) => {
        render(<DirectChatView agent={agent ?? 'frontend'} />);
    });

program
    .command('approve <agent>')
    .description('Approve a pending workflow start')
    .helpGroup('Agent actions:')
    .action((agent: string) => {
        const dir = program.opts().dir;
        render(<ApproveView agent={agent} dir={dir} />);
    });

program
    .command('status [agent]')
    .description('One-shot status dump (no live refresh)')
    .helpGroup('Monitoring:')
    .action((agent?: string) => {
        const dir = program.opts().dir;
        render(<StatusView agent={agent} dir={dir} />);
    });

program
    .command('agents')
    .description('List all agents and their current state')
    .helpGroup('Monitoring:')
    .action(() => {
        const dir = program.opts().dir;
        render(<AgentsView dir={dir} />);
    });

program
    .command('providers')
    .description('View all providers, health, and available models')
    .helpGroup('Monitoring:')
    .action(() => {
        render(<ProvidersView onBack={() => process.exit(0)} />);
    });

program
    .command('fleet')
    .description('Live multi-agent fleet view (streams /api/status/stream)')
    .helpGroup('Monitoring:')
    .action(() => {
        const { unmount } = render(<FleetView onBack={() => {
            unmount();
            render(<InteractiveView agent={null} dir={program.opts().dir} />);
        }} />);
    });

program
    .command('tasks [agent]')
    .description('View and manage tasks for an agent')
    .helpGroup('Monitoring:')
    .action((agent?: string) => {
        const dir = program.opts().dir;
        render(<TasksView agent={agent ?? 'frontend'} dir={dir} />);
    });

program
    .command('create-story')
    .description('Create a new Agility story')
    .helpGroup('Stories:')
    .action(() => {
        const dir = program.opts().dir;
        render(<CreateStoryView dir={dir} />);
    });

program
    .command('orchestrate [goal]')
    .description('Kick off the SDLC: author stories (from a goal or AI-QA findings), assign, and watch the fleet')
    .helpGroup('Stories:')
    .option('--from-aiqa', 'seed authoring from the AI-QA scorecard findings instead of a goal')
    .action((goal: string | undefined, opts: { fromAiqa?: boolean }) => {
        if (!goal && !opts.fromAiqa) {
            console.error('Provide a goal (e.g. orchestrate "add a /api/ping/build endpoint") or use --from-aiqa');
            process.exit(1);
        }
        render(<OrchestrateView goal={goal} fromAiqa={opts.fromAiqa} />);
    });

program.parse();
