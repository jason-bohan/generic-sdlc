/**
 * SDLC Framework API server — route modules mounted via createRouter.
 * Consumed by src/server/index.ts (standalone) and tested independently.
 * __dirname replaced with rootDir parameter throughout.
 */

import http from 'node:http';
import { resolve } from 'path';
import { createRouter } from './router';
import { mount as mountStatus } from './routes/status';
import { mount as mountAgents } from './routes/agents';
import { mount as mountReviewer } from './routes/reviewer';
import { mount as mountHandoffs } from './routes/handoffs';
import { mount as mountWorkflows } from './routes/workflows';
import { mount as mountPlanning } from './routes/planning';
import { mount as mountScheduler } from './routes/scheduler';
import { mount as mountOrchestrator } from './routes/orchestrator';
import { mount as mountTokens } from './routes/tokens';
import { mount as mountAnalytics } from './routes/analytics';
import { mount as mountOllama } from './routes/ollama';
import { mount as mountTesting } from './routes/testing';
import { mount as mountChat } from './routes/chat';
import { mount as mountConfig } from './routes/config';
import { mount as mountMock } from './routes/mock';
import { mount as mountPrEvents } from './routes/pr-events';
import { mount as mountNotify } from './routes/notify';
import { mount as mountMeshllm } from './routes/meshllm';
import { mount as mountMeetingAgent } from './routes/meeting-agent';
import { mount as mountAgentOutput } from './routes/agent-output';
import { mount as mountFinetune } from './routes/finetune';
import { mount as mountOpenRouter } from './routes/openrouter';
import { mount as mountMlx } from './routes/mlx';
import { mount as mountWebhooks } from './routes/webhooks';
import { mount as mountAiQa } from './routes/aiqa';
import { mount as mountDemoMode } from './routes/demo-mode';
import { mount as mountAiQaTelemetry } from './routes/aiqa-telemetry';

export function createApp(rootDir: string): http.RequestListener {
    const configFile = resolve(rootDir, '.sdlc-framework.config.json');
    const { use, dispatch } = createRouter();

    mountStatus(use, rootDir, configFile);
    mountAgents(use, rootDir, configFile);
    mountReviewer(use, rootDir, configFile);
    mountHandoffs(use, rootDir, configFile);
    mountWorkflows(use, rootDir, configFile);
    mountPlanning(use, rootDir, configFile);
    mountScheduler(use, rootDir, configFile);
    mountOrchestrator(use, rootDir, configFile);
    mountTokens(use, rootDir, configFile);
    mountAnalytics(use, rootDir, configFile);
    mountOllama(use, rootDir, configFile);
    mountTesting(use, rootDir, configFile);
    mountChat(use, rootDir, configFile);
    mountConfig(use, rootDir, configFile);
    mountMock(use, rootDir, configFile);
    mountPrEvents(use, rootDir, configFile);
    mountNotify(use, rootDir, configFile);
    mountMeshllm(use, rootDir, configFile);
    mountMeetingAgent(use, rootDir);
    mountAgentOutput(use, rootDir);
    mountFinetune(use, rootDir);
    mountOpenRouter(use);
    mountMlx(use, rootDir, configFile);
    mountWebhooks(use, rootDir, configFile);
    mountAiQa(use, rootDir, configFile);
    mountDemoMode(use, rootDir, configFile);
    mountAiQaTelemetry(use, rootDir, configFile);

    return dispatch;
}
