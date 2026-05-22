import React from 'react';
import { Box, Text } from 'ink';

interface TokenCounts { input: number; output: number }
interface Props { cloud: TokenCounts; meshllm?: TokenCounts; ollama: TokenCounts }

function fmt(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

export function TokenUsage({ cloud, meshllm = { input: 0, output: 0 }, ollama }: Props) {
    return (
        <Box flexDirection="column">
            <Text bold>Tokens</Text>
            <Box gap={1}>
                <Text color="cyan">Cloud:</Text>
                <Text>{fmt(cloud.input)} in / {fmt(cloud.output)} out</Text>
            </Box>
            <Box gap={1}>
                <Text color="magenta">MeshLLM:</Text>
                <Text>{fmt(meshllm.input)} in / {fmt(meshllm.output)} out</Text>
            </Box>
            <Box gap={1}>
                <Text color="green">Ollama:</Text>
                <Text>{fmt(ollama.input)} in / {fmt(ollama.output)} out</Text>
            </Box>
        </Box>
    );
}
TokenUsage.displayName = 'TokenUsage';
