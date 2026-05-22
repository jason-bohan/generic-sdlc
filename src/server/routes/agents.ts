import type { UseFn } from './types';
import { mount as mountAgentsCore } from './agents-core';
import { mount as mountAgentsModels } from './agents-models';
import { mount as mountAgentsContinueHook } from './agents-continue-hook';

export function mount(use: UseFn, rootDir: string, configFile: string): void {
    mountAgentsCore(use, rootDir, configFile);
    mountAgentsModels(use, rootDir, configFile);
    mountAgentsContinueHook(use, rootDir, configFile);
}
