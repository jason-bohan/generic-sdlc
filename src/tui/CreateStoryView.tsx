import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import Link from 'ink-link';
import { loadConfig as loadWorkspaceConfig, checkServer, API_BASE } from './workspace';
import type { ExecMode } from './executionMode';
import { enrichmentHint, MODE_LABELS, parseExecMode } from './executionMode';

interface Props { dir: string; agent?: string; onBack?: () => void }

type Step = 'team' | 'owner' | 'classOfService' | 'title' | 'description' | 'estimate' | 'confirm';
type Status = 'idle' | 'loading' | 'enriching' | 'creating' | 'done' | 'error';

const FIB = ['1', '2', '3', '5', '8', '13'] as const;
const FIB_KEYS: Record<string, string> = { '1': '1', '2': '2', '3': '3', '4': '5', '5': '8', '6': '13' };

interface TeamItem { id: string; name: string }
interface MemberItem { id: string; name: string; nickname: string; email: string }
interface CosItem { id: string; name: string }

function executionModeColor(mode: ExecMode): 'yellow' | 'green' | 'cyan' {
    if (mode === 'speed') return 'yellow';
    if (mode === 'local') return 'green';
    return 'cyan';
}

export function CreateStoryView({ dir, onBack }: Props) {
    const config = loadWorkspaceConfig();
    const project = config?.project;

    const [step, setStep] = useState<Step>('team');
    const [status, setStatus] = useState<Status>('loading');
    const [serverDown, setServerDown] = useState(false);

    const [teams, setTeams] = useState<TeamItem[]>([]);
    const [members, setMembers] = useState<MemberItem[]>([]);
    const [cosItems, setCosItems] = useState<CosItem[]>([]);

    const [team, setTeam] = useState(project?.team ?? '');
    const [owner, setOwner] = useState((project?.owners as string[] | undefined)?.[0] ?? '');
    const [classOfService, setClassOfService] = useState('');
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [estimate, setEstimate] = useState('');
    const [result, setResult] = useState('');
    const [resultUrl, setResultUrl] = useState('');
    const [execMode, setExecMode] = useState<ExecMode>('balanced');

    useEffect(() => {
        checkServer().then(ok => {
            if (!ok) {
                setServerDown(true);
                setStatus('error');
                setResult('Cannot connect to server at localhost:3847. Start it with `npm run dev`.');
                return;
            }
            return Promise.all([
                fetch(`${API_BASE}/api/planning/teams`).then(r => r.json()).catch(() => ({ teams: [] })),
                fetch(`${API_BASE}/api/planning/members`).then(r => r.json()).catch(() => ({ members: [] })),
                fetch(`${API_BASE}/api/planning/class-of-service`).then(r => r.json()).catch(() => ({ values: [] })),
                fetch(`${API_BASE}/api/execution-mode`).then(r => (r.ok ? r.json() : {})).catch(() => ({})),
            ]).then(([teamsData, membersData, cosData, modeData]) => {
                setTeams(teamsData.teams ?? []);
                setMembers(membersData.members ?? []);
                setCosItems(cosData.values ?? []);
                const rawMode = typeof modeData === 'object' && modeData !== null && 'mode' in modeData
                    ? (modeData as { mode?: unknown }).mode
                    : undefined;
                const m = parseExecMode(rawMode);
                if (m) setExecMode(m);
                setStatus('idle');
            });
        });
    }, []);

    async function doCreate() {
        setStatus('enriching');
        try {
            const res = await fetch(`${API_BASE}/api/planning/create-story`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: title.trim(),
                    description: description.trim() || undefined,
                    estimate: estimate ? Number(estimate) : undefined,
                    team: team || undefined,
                    owner: owner || undefined,
                    classOfService: classOfService.trim(),
                    workspaceDir: dir,
                }),
            });
            setStatus('creating');
            const data = await res.json();
            if (data.success) {
                setStatus('done');
                setResult(data.number);
                setResultUrl(data.url ?? '');
            } else {
                setStatus('error');
                setResult(data.error || 'Unknown error');
            }
        } catch (e: any) {
            setStatus('error');
            setResult(e.message);
        }
    }

    function reset() {
        setStep('team');
        setStatus('idle');
        setTitle('');
        setClassOfService('');
        setDescription('');
        setEstimate('');
        setResult('');
        setResultUrl('');
    }

    useInput((input, key) => {
        if (key.escape) {
            if (status === 'done' || status === 'error') { reset(); return; }
            if (step === 'owner') { setStep('team'); return; }
            if (step === 'title') { setStep('classOfService'); return; }
            if (step === 'classOfService') { setStep('owner'); return; }
            if (step === 'description') { setStep('title'); return; }
            if (step === 'estimate') { setStep('description'); return; }
            if (step === 'confirm') { setStep('estimate'); return; }
            onBack?.();
        }
        if (step === 'team' && status === 'idle' && teams.length === 0 && key.return) {
            setStep('owner');
            return;
        }
        if (step === 'owner' && status === 'idle' && members.length === 0 && key.return) {
            setStep('classOfService');
            return;
        }
        if (step === 'estimate' && status === 'idle') {
            if (FIB_KEYS[input]) {
                setEstimate(prev => prev === FIB_KEYS[input] ? '' : FIB_KEYS[input]!);
                return;
            }
            if (key.return) { setStep('confirm'); return; }
        }
        if (step === 'confirm' && status === 'idle') {
            if (input === 'y' || input === 'Y') doCreate();
            if (input === 'n' || input === 'N') reset();
        }
        if (status === 'done' && input === 'c') reset();
    });

    if (status === 'loading') {
        return (
            <Box flexDirection="column" padding={1}>
                <Text bold color="yellow">Create Agility Story</Text>
                <Box marginTop={1} gap={1}>
                    <Text color="cyan"><Spinner type="dots" /></Text>
                    <Text>Loading teams and members...</Text>
                </Box>
            </Box>
        );
    }

    const modeColor = executionModeColor(execMode);

    const modeBadge = (
        <Box flexDirection="column" marginTop={1}>
            <Box gap={1} flexWrap="wrap">
                <Text dimColor>Active mode</Text>
                <Text bold color={modeColor}>[{execMode}]</Text>
                <Text color={modeColor}>{MODE_LABELS[execMode]}</Text>
            </Box>
            <Text dimColor>{enrichmentHint(execMode)}</Text>
        </Box>
    );

    const defaultTeamIdx = teams.findIndex(t => t.name === team);

    return (
        <Box flexDirection="column" padding={1}>
            <Text bold color="yellow">Create Agility Story</Text>
            {modeBadge}

            {status === 'enriching' && (
                <Box marginTop={1} gap={1}>
                    <Text color="cyan"><Spinner type="dots" /></Text>
                    <Text>Enriching story fields...</Text>
                </Box>
            )}

            {status === 'creating' && (
                <Box marginTop={1} gap={1}>
                    <Text color="green"><Spinner type="dots" /></Text>
                    <Text>Creating in Agility...</Text>
                </Box>
            )}

            {status === 'done' && (
                <Box flexDirection="column" marginTop={1}>
                    <Text color="green">Story created: {resultUrl
                        ? <Link url={resultUrl}><Text bold color="cyan">{result}</Text></Link>
                        : <Text bold>{result}</Text>
                    }</Text>
                    <Text dimColor>Title: {title}</Text>
                    <Text dimColor>Team: {team}  |  Owner: {owner}  |  CoS: {classOfService}</Text>
                    {resultUrl && <Text dimColor>{resultUrl}</Text>}
                    <Box marginTop={1}>
                        <Text dimColor>[c] create another  [Esc] back</Text>
                    </Box>
                </Box>
            )}

            {status === 'error' && (
                <Box flexDirection="column" marginTop={1}>
                    <Text color="red">Error: {result}</Text>
                    <Box marginTop={1}>
                        <Text dimColor>[Esc] back</Text>
                    </Box>
                </Box>
            )}

            {status === 'idle' && step === 'team' && (
                <Box flexDirection="column" marginTop={1}>
                    <Text>Team:</Text>
                    {teams.length > 0 ? (
                        <SelectInput
                            items={teams.map(t => ({ label: t.name, value: t.name }))}
                            initialIndex={defaultTeamIdx >= 0 ? defaultTeamIdx : 0}
                            onSelect={(item) => { setTeam(item.value); setStep('owner'); }}
                        />
                    ) : (
                        <Box flexDirection="column">
                            <Text dimColor>Could not load teams. Using default: <Text color="cyan">{team || 'none'}</Text></Text>
                            <Text dimColor>Press Enter to continue</Text>
                        </Box>
                    )}
                    <Text dimColor>[Esc] back</Text>
                </Box>
            )}

            {status === 'idle' && step === 'owner' && (
                <Box flexDirection="column" marginTop={1}>
                    <Text dimColor>Team: <Text color="cyan">{team}</Text></Text>
                    <Text>Owner:</Text>
                    {members.length > 0 ? (
                        <SelectInput
                            items={members.map(m => ({
                                label: m.nickname ? `${m.name} (${m.nickname})` : m.name,
                                value: m.name,
                            }))}
                            initialIndex={Math.max(0, members.findIndex(m => m.name === owner))}
                            onSelect={(item) => { setOwner(item.value); setStep('classOfService'); }}
                        />
                    ) : (
                        <Box flexDirection="column">
                            <Text dimColor>Could not load members. Using default: <Text color="cyan">{owner || 'none'}</Text></Text>
                            <Text dimColor>Press Enter to continue</Text>
                        </Box>
                    )}
                    <Text dimColor>[Esc] back to team</Text>
                </Box>
            )}

            {status === 'idle' && step === 'classOfService' && (
                <Box flexDirection="column" marginTop={1}>
                    <Text dimColor>Team: <Text color="cyan">{team}</Text>  |  Owner: <Text color="cyan">{owner}</Text></Text>
                    <Text>Class of Service:</Text>
                    {cosItems.length > 0 ? (
                        <SelectInput
                            items={cosItems.map(c => ({ label: c.name, value: c.name }))}
                            initialIndex={Math.max(0, cosItems.findIndex(c => c.name === classOfService))}
                            onSelect={(item) => { setClassOfService(item.value); setStep('title'); }}
                        />
                    ) : (
                        <Box flexDirection="column" marginTop={1}>
                            <Text color="red">Could not load Class of Service values from Agility. Story creation cannot proceed.</Text>
                            <Text dimColor>Check server logs and credentials. [Esc] back to owner</Text>
                        </Box>
                    )}
                    <Text dimColor>[Esc] back to owner</Text>
                </Box>
            )}

            {status === 'idle' && step === 'title' && (
                <Box flexDirection="column" marginTop={1}>
                    <Text dimColor>Team: <Text color="cyan">{team}</Text>  |  Owner: <Text color="cyan">{owner}</Text></Text>
                    <Text dimColor>Class of Service: <Text color="cyan">{classOfService}</Text></Text>
                    <Box gap={1} marginTop={1}>
                        <Text>Title:</Text>
                        <TextInput
                            value={title}
                            onChange={setTitle}
                            onSubmit={() => { if (title.trim()) setStep('description'); }}
                        />
                    </Box>
                    <Text dimColor>Required. e.g. "Fix toast readability in Simple theme"</Text>
                    <Text dimColor>[Esc] back to Class of Service</Text>
                </Box>
            )}

            {status === 'idle' && step === 'description' && (
                <Box flexDirection="column" marginTop={1}>
                    <Text dimColor>Team: <Text color="cyan">{team}</Text>  |  Owner: <Text color="cyan">{owner}</Text></Text>
                    <Text dimColor>Class of Service: <Text color="cyan">{classOfService}</Text></Text>
                    <Text dimColor>Title: <Text color="cyan">{title}</Text></Text>
                    <Box gap={1} marginTop={1}>
                        <Text>Description:</Text>
                        <TextInput
                            value={description}
                            onChange={setDescription}
                            onSubmit={() => setStep('estimate')}
                        />
                    </Box>
                    <Text dimColor>Optional - AI will expand this into full AC, frontend, backend, QA fields.</Text>
                    <Text dimColor>Press Enter to skip. [Esc] back to title</Text>
                </Box>
            )}

            {status === 'idle' && step === 'estimate' && (
                <Box flexDirection="column" marginTop={1}>
                    <Text dimColor>Team: <Text color="cyan">{team}</Text>  |  Owner: <Text color="cyan">{owner}</Text></Text>
                    <Text dimColor>Class of Service: <Text color="cyan">{classOfService}</Text></Text>
                    <Text dimColor>Title: <Text color="cyan">{title}</Text></Text>
                    {description && <Text dimColor>Description: {description.slice(0, 60)}{description.length > 60 ? '...' : ''}</Text>}
                    <Text>Estimate (points):</Text>
                    <Box gap={1} marginTop={1}>
                        {FIB.map((v, i) => (
                            <Text key={v} color={estimate === v ? 'green' : undefined} bold={estimate === v}>
                                [{i + 1}] {v}
                            </Text>
                        ))}
                    </Box>
                    <Text dimColor>Press 1-6 to select, Enter to continue. [Esc] back</Text>
                </Box>
            )}

            {status === 'idle' && step === 'confirm' && (
                <Box flexDirection="column" marginTop={1}>
                    <Text bold color="cyan">Confirm</Text>
                    <Text>Team: <Text bold>{team}</Text></Text>
                    <Text>Owner: <Text bold>{owner}</Text></Text>
                    <Text>Class of Service: <Text bold>{classOfService}</Text></Text>
                    <Text>Title: <Text bold>{title}</Text></Text>
                    {description && <Text>Description: {description.slice(0, 80)}{description.length > 80 ? '...' : ''}</Text>}
                    <Text>Estimate: {estimate || '(none)'}</Text>
                    <Box marginTop={1}>
                        <Text dimColor>AI will enrich the description into full story fields.</Text>
                        {execMode === 'speed' && (
                            <Box flexDirection="column" marginTop={1}>
                                <Text dimColor>In Speed mode the server skips enrichment at create time.</Text>
                            </Box>
                        )}
                    </Box>
                    <Box marginTop={1}>
                        <Text dimColor>[y] create  [n] start over  [Esc] back</Text>
                    </Box>
                </Box>
            )}
        </Box>
    );
}
CreateStoryView.displayName = 'CreateStoryView';
