import type { ToolDefinition } from './types';

export const AGENT_TOOLS: ToolDefinition[] = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the contents of a file. Path may be absolute or relative to the workspace root. In the early understanding phases, large files come back as a concise summary to save context; pass full:true (or read again once you are editing) to get exact contents.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to read' },
                    full: { type: 'boolean', description: 'Return the exact full file contents even in an understanding phase (needed before editing). Default false = may be summarized for large files.' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Write (or overwrite) a file. Creates parent directories if needed.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to write' },
                    content: { type: 'string', description: 'Content to write' },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'edit_file',
            description: 'Make a targeted edit to an existing file by replacing one exact snippet with another. PREFER THIS over write_file for changing existing files — you only send the small piece that changes, not the whole file. old_string must appear EXACTLY once in the file (include enough surrounding context to be unique).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to edit' },
                    old_string: { type: 'string', description: 'Exact text to find (must be unique in the file)' },
                    new_string: { type: 'string', description: 'Text to replace it with' },
                },
                required: ['path', 'old_string', 'new_string'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description: 'List files and subdirectories at a path.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Directory path' },
                    recursive: { type: 'boolean', description: 'List recursively (default false)' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'run_command',
            description: 'Run a shell command (git, dotnet, nx, npm, etc.) and return stdout + stderr.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Executable or shell command' },
                    args: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Arguments list',
                    },
                    cwd: {
                        type: 'string',
                        description: 'Working directory (defaults to workspace root)',
                    },
                    timeout_ms: {
                        type: 'number',
                        description: 'Timeout in ms (default 120000)',
                    },
                },
                required: ['command'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'run_validation',
            description: 'Validating phase only: run the project\'s type-check, build, and tests for the current story and return a structured pass/fail report. The framework runs the commands for you — do NOT run npm/tsc/git yourself. After calling this, pass its results straight into complete_phase.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Worktree path to validate. Optional — auto-detected from the story worktree if omitted.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_in_files',
            description: 'Search for a text pattern across files. Returns matching lines with file paths.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Text to search for (case-insensitive)' },
                    directory: {
                        type: 'string',
                        description: 'Directory to search in (defaults to workspace root)',
                    },
                    extensions: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'File extensions to include, e.g. [".ts", ".cs"] (defaults to all)',
                    },
                    max_results: {
                        type: 'number',
                        description: 'Maximum number of matching lines to return (default 50)',
                    },
                },
                required: ['pattern'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'grep',
            description: 'Search files using a regular expression. Like the CLI grep command. Returns matching lines with file paths.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Regex pattern to search for (case-insensitive by default)' },
                    directory: { type: 'string', description: 'Directory to search in (defaults to workspace root)' },
                    include: { type: 'string', description: 'Glob pattern for file names to include, e.g. "*.ts", "*.{ts,tsx}" (defaults to all)' },
                    max_results: { type: 'number', description: 'Maximum results to return (default 50)' },
                },
                required: ['pattern'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read',
            description: 'Read the contents of a file. Like the CLI cat/less command. Returns the full file contents.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to read' },
                    offset: { type: 'number', description: 'Starting line number (1-indexed, default 1)' },
                    limit: { type: 'number', description: 'Max lines to return (default all)' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'glob',
            description: 'Find files matching a glob pattern. Like the CLI find/ls command with wildcards.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts", "src/**/*.test.*"' },
                    directory: { type: 'string', description: 'Directory to search in (defaults to workspace root)' },
                },
                required: ['pattern'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'summarize_file',
            description: 'Read a file and return a concise summary using a cheap 1-bit worker model. Use this instead of read_file when you only need to know what a file does, not its full contents — saves context for the main model.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to summarize' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'summarize_search',
            description: 'Search for a pattern across the codebase and return a grouped summary using a cheap 1-bit worker model. Use this instead of search_in_files or grep when you have a broad pattern and want a concise per-file summary rather than raw line matches.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Text pattern or regex to search for' },
                    directory: { type: 'string', description: 'Directory to search in (defaults to workspace root)' },
                    include: { type: 'string', description: 'Glob pattern for file names to include, e.g. "*.ts", "*.{ts,tsx}"' },
                },
                required: ['pattern'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'http_request',
            description: 'Make an HTTP request to a URL. Use this to call the SDLC API (create tasks, complete phases, etc.) instead of curl.',
            parameters: {
                type: 'object',
                properties: {
                    method: { type: 'string', description: 'HTTP method: GET, POST, PUT, PATCH, DELETE' },
                    url: { type: 'string', description: 'Full URL to request' },
                    body: { type: 'object', description: 'JSON body to send (for POST/PUT/PATCH)' },
                    headers: { type: 'object', description: 'Additional headers (optional)' },
                },
                required: ['method', 'url'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'create_task',
            description: 'Create an implementation task for the current story. Returns the task ID.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Short task name, e.g. "Add input validation to POST /api/tasks"' },
                    estimate: { type: 'number', description: 'Estimated hours (1-8)' },
                },
                required: ['name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'complete_phase',
            description: 'Mark the current SDLC phase as complete and advance to the next phase. Call this to signal phase completion — do NOT use http_request for this. Required at the end of every phase.',
            parameters: {
                type: 'object',
                properties: {
                    next_phase: { type: 'string', description: 'Next phase id to advance to (e.g. "analyzing", "generating-code", "creating-pr")' },
                    summary: { type: 'string', description: 'Short human-readable summary of what was accomplished in this phase' },
                    branch_plan: { type: 'string', description: 'Git branch name for this story, e.g. "fix/2-validate-input". Required for phases that produce branchPlan.' },
                    risks: { type: 'string', description: 'Risks or blockers identified. Required for phases that produce risks; use "None identified" only after actually checking.' },
                    open_questions: { type: 'string', description: 'Open questions or unknowns. Required for phases that produce openQuestions; use "None" only after actually checking.' },
                    test_matrix: { type: 'string', description: 'Test plan or test matrix description. Required for phases that produce testMatrix.' },
                    code_changes: { type: 'string', description: 'Summary of code changes made (for generating-code / validating phases)' },
                    classification: { type: 'string', description: 'Story classification, e.g. "feature", "bug", "refactor"' },
                    affected_repo: { type: 'string', description: 'Name of the affected repository or project' },
                    review_verdict: { type: 'string', description: 'Review decision: "approved", "request-changes", or "rejected" (for reviewing-pr phase)' },
                    design_spec: { type: 'string', description: 'Design specification summary (for designing phase)' },
                    validation_results: { type: 'string', description: 'Validation/lint/build results summary' },
                    test_results: { type: 'string', description: 'Test run results summary' },
                    static_analysis: { type: 'string', description: 'Static analysis results summary' },
                    build: { type: 'string', description: 'Build outcome summary' },
                },
                required: ['next_phase', 'summary'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_status',
            description: 'Update the agent status file. Call this after completing each phase.',
            parameters: {
                type: 'object',
                properties: {
                    phase: { type: 'string', description: 'Current phase name (e.g. "analyzing", "coding", "creating-pr")' },
                    storyNumber: { type: 'string', description: 'Story number being worked on' },
                    currentTask: { type: 'string', description: 'Short description of what is being done right now' },
                    message: { type: 'string', description: 'Human-readable status message' },
                    verdict: { type: 'string', description: 'Review verdict (reviewer only): "approved" or "changes-requested". Set this on your FINAL review update — it routes the PR (approved → devops; changes-requested → back to the author) and the phase is set to match automatically. Non-blocking nits do NOT block: nits-only → "approved".' },
                    tasks: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                name: { type: 'string' },
                                status: { type: 'string' },
                            },
                        },
                        description: 'Task list for the current story',
                    },
                },
                required: ['phase'],
            },
        },
    },
];
