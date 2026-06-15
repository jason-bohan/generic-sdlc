import { authorizeToolCall } from '../gateway/tool-authz';

// Re-export all public symbols from sub-modules for backward compatibility.
// External consumers (routes, tests) import from this barrel.
export { AGENT_TOOLS } from './tool-definitions';
export { safePath, resolveWritablePath, globToRegex } from './path-utils';
export {
    parseWorktreeAddPath,
    parseWorktreeAddBranch,
    parseWorktreeList,
    rewriteWorktreeAddOnCollision,
    findStoryWorktree,
    ensureStoryWorktree,
    findActiveWorktree,
    activeOrCreatedWorktree,
    maybeRedirectToWorktree,
    readAgentStoryNumber,
    parseWorktreeCommandCwd,
} from './worktree';
export { toolRunCommand } from './command-tools';
export {
    autoCommitWorktree,
    autoCreatePr,
    autoMergePr,
    classifyCiRollup,
    prIsEmpty,
    DEVOPS_BUILD_CHAIN,
    devopsBuildChainNextPhase,
} from './commit-pr';
export { toolRunValidation, persistValidationFailure } from './validation';
export {
    toolSearchInFiles,
    toolGrep,
    toolRead,
    toolGlob,
    toolSummarizeFile,
    toolSummarizeSearch,
} from './search-tools';
export { toolUpdateStatus, toolCreateTask, toolHttpRequest } from './status-tools';
export { toolReadFile, toolWriteFile, toolEditFile, toolListDirectory } from './file-tools';
export { toolCompletePhase } from './phase-tools';
export type { AutoCommitResult, AutoPrResult, AutoMergeResult } from './commit-pr';

import { toolReadFile, toolWriteFile, toolEditFile, toolListDirectory } from './file-tools';
import { toolRunCommand } from './command-tools';
import { toolRunValidation } from './validation';
import { toolCreateTask, toolHttpRequest, toolUpdateStatus } from './status-tools';
import { toolCompletePhase } from './phase-tools';
import {
    toolSearchInFiles,
    toolGrep,
    toolRead,
    toolGlob,
    toolSummarizeFile,
    toolSummarizeSearch,
} from './search-tools';

export async function executeToolCall(
    name: string,
    args: unknown,
    workspaceDir: string,
    frameworkDir: string,
    agentId: string,
    configPath: string,
): Promise<string> {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;

    // Gateway authorization: gate workflow-mutating tools by role scope before
    // execution (default-deny). Structurally stops e.g. a reviewer advancing a
    // phase — a guarantee that no longer depends on the model heeding a nudge.
    const authz = authorizeToolCall(agentId, name);
    if (!authz.ok) return `Refused: ${authz.reason}`;

    switch (name) {
        case 'read_file':       return toolReadFile(a, workspaceDir, frameworkDir, agentId, configPath);
        case 'write_file':      return toolWriteFile(a, workspaceDir, frameworkDir, agentId);
        case 'edit_file':       return toolEditFile(a, workspaceDir, frameworkDir, agentId);
        case 'list_directory':  return toolListDirectory(a, workspaceDir, frameworkDir);
        case 'run_command':     return toolRunCommand(a, workspaceDir, frameworkDir, configPath, agentId);
        case 'run_validation':  return toolRunValidation(a, workspaceDir, frameworkDir, agentId);
        case 'http_request':    return toolHttpRequest(a);
        case 'create_task':     return toolCreateTask(a, frameworkDir, agentId);
        case 'complete_phase':  return toolCompletePhase(a, workspaceDir, frameworkDir, agentId, configPath);
        case 'search_in_files': return toolSearchInFiles(a, workspaceDir, frameworkDir);
        case 'grep':            return toolGrep(a, workspaceDir, frameworkDir);
        case 'read':            return toolRead(a, workspaceDir, frameworkDir);
        case 'glob':            return toolGlob(a, workspaceDir, frameworkDir);
        case 'summarize_file':  return toolSummarizeFile(a, workspaceDir, frameworkDir, configPath);
        case 'summarize_search': return toolSummarizeSearch(a, workspaceDir, frameworkDir, configPath);
        case 'update_status':   return toolUpdateStatus(a, workspaceDir, frameworkDir, agentId);
        default: {
            // Local 14B models often emit the task *description* as the tool name
            // (e.g. {"name":"Add validation to POST /api/tasks","arguments":{...}}).
            // If the name contains spaces it's almost certainly a task title — route it.
            if (name.includes(' ') || name.length > 40) {
                return toolCreateTask({ ...a, name }, frameworkDir, agentId);
            }
            return `Unknown tool: "${name}". Valid tools: read_file, write_file, edit_file, list_directory, search_in_files, grep, read, glob, summarize_file, summarize_search, run_command, create_task, update_status, http_request, complete_phase.`;
        }
    }
}
