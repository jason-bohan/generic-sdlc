#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const yes = process.argv.includes('--yes') || process.argv.includes('-y');
const skipInstall = process.argv.includes('--skip-install');

const colors = {
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

function color(name, value) {
  return `${colors[name] || ''}${value}${colors.reset}`;
}

function logStep(label) {
  console.log(`\n${color('yellow', label)}`);
}

function commandExists(command) {
  const checker = isWindows ? 'where' : 'command';
  const args = isWindows ? [command] : ['-v', command];
  return spawnSync(checker, args, { shell: !isWindows, stdio: 'ignore' }).status === 0;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    stdio: options.stdio || 'inherit',
    shell: isWindows,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
  return result;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupFile(file, reason) {
  const backup = `${file}.bak-${timestampForFile()}`;
  fs.copyFileSync(file, backup);
  console.log(color('yellow', `  Backed up ${path.basename(file)} (${reason}) to ${path.basename(backup)}`));
  return backup;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeMissingDefaults(target, defaults, prefix = '') {
  const added = [];
  const repaired = [];
  const output = { ...target };

  for (const [key, defaultValue] of Object.entries(defaults)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    const currentValue = output[key];

    if (currentValue === undefined) {
      output[key] = defaultValue;
      added.push(keyPath);
      continue;
    }

    if (isPlainObject(defaultValue)) {
      if (isPlainObject(currentValue)) {
        const merged = mergeMissingDefaults(currentValue, defaultValue, keyPath);
        output[key] = merged.value;
        added.push(...merged.added);
        repaired.push(...merged.repaired);
      } else if (currentValue === null || Array.isArray(currentValue)) {
        output[key] = defaultValue;
        repaired.push(keyPath);
      }
    }
  }

  return { value: output, added, repaired };
}

function readConfigOrSelfHeal(configFile, templateFile) {
  const hasTemplate = templateFile && fs.existsSync(templateFile);
  const template = hasTemplate ? readJson(templateFile) : null;

  if (!fs.existsSync(configFile)) {
    if (!template) {
      console.log(color('yellow', '  No config template found; create .sdlc-framework.config.json manually'));
      return null;
    }
    writeJson(configFile, template);
    console.log(color('green', `  Created .sdlc-framework.config.json from ${path.basename(templateFile)}`));
    return template;
  }

  let cfg;
  try {
    cfg = readJson(configFile);
  } catch (error) {
    if (!template) {
      console.log(color('yellow', `  Could not parse .sdlc-framework.config.json: ${error.message}`));
      return null;
    }
    backupFile(configFile, 'invalid JSON');
    writeJson(configFile, template);
    console.log(color('green', '  Recreated .sdlc-framework.config.json from template'));
    return template;
  }

  if (!isPlainObject(cfg)) {
    if (!template) {
      console.log(color('yellow', '  .sdlc-framework.config.json is not an object; create it manually'));
      return null;
    }
    backupFile(configFile, 'invalid config shape');
    writeJson(configFile, template);
    console.log(color('green', '  Recreated .sdlc-framework.config.json from template'));
    return template;
  }

  if (!template) {
    console.log(color('green', '  .sdlc-framework.config.json exists'));
    return cfg;
  }

  const merged = mergeMissingDefaults(cfg, template);
  if (merged.added.length || merged.repaired.length) {
    writeJson(configFile, merged.value);
    const addedText = merged.added.length ? `${merged.added.length} missing key(s)` : '';
    const repairedText = merged.repaired.length ? `${merged.repaired.length} malformed section(s)` : '';
    console.log(color('green', `  Self-healed .sdlc-framework.config.json from template (${[addedText, repairedText].filter(Boolean).join(', ')})`));
  } else {
    console.log(color('green', '  .sdlc-framework.config.json already matches the template shape'));
  }

  return merged.value;
}

function createPrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask(question, fallback = '') {
      if (yes) return Promise.resolve(fallback);
      return new Promise((resolve) => {
        const suffix = fallback ? ` [${fallback}]` : '';
        rl.question(`${question}${suffix}: `, (answer) => resolve(answer.trim() || fallback));
      });
    },
    close() {
      rl.close();
    },
  };
}

function nodeMajor() {
  return Number(process.versions.node.split('.')[0]);
}

function isCursorInstalled() {
  if (commandExists('cursor-agent')) return true;
  // Verify 'agent' is actually Cursor's agent CLI, not an unrelated command
  const localAppData = process.env.LOCALAPPDATA || '';
  const shimCmd = path.join(localAppData, 'cursor-agent', 'bin', 'agent.cmd');
  const versionsDir = path.join(localAppData, 'cursor-agent', 'versions');
  return fs.existsSync(shimCmd) || fs.existsSync(versionsDir);
}

function detectDriver() {
  if (isCursorInstalled()) return 'cursor';
  if (commandExists('claude')) return 'claude-code';
  if (commandExists('goose')) return 'goose';
  return 'loop';
}

function configTemplatePath() {
  const template = path.join(root, '.sdlc-framework.config.example.json');
  return fs.existsSync(template) ? template : null;
}

function ensureEnvFile() {
  const envFile = path.join(root, '.env');
  const envExample = path.join(root, '.env.example');
  if (fs.existsSync(envFile)) {
    console.log(color('green', '  .env already exists'));
    return;
  }
  if (!fs.existsSync(envExample)) {
    console.log(color('yellow', '  .env.example not found; skipping .env creation'));
    return;
  }
  fs.copyFileSync(envExample, envFile);
  console.log(color('green', '  Created .env from .env.example'));
}

function ensureConfigFile(driver) {
  const configFile = path.join(root, '.sdlc-framework.config.json');
  const template = configTemplatePath();
  const cfg = readConfigOrSelfHeal(configFile, template);
  if (!cfg) return null;

  try {
    cfg.scheduler = cfg.scheduler || {};
    if (!cfg.scheduler.driver || cfg.scheduler.driver === 'generic') {
      cfg.scheduler.driver = driver;
      writeJson(configFile, cfg);
      console.log(color('green', `  Set scheduler.driver = ${driver}`));
    } else {
      console.log(color('dim', `  Keeping scheduler.driver = ${cfg.scheduler.driver}`));
    }
  } catch (error) {
    console.log(color('yellow', `  Could not update scheduler.driver: ${error.message}`));
  }

  return configFile;
}

async function configureWorkspacePaths(prompt, configFile) {
  if (!configFile || !fs.existsSync(configFile)) return;

  const cfg = readJson(configFile);
  if (!cfg.projects || typeof cfg.projects !== 'object') {
    console.log(color('dim', '  No projects section found; skipping workspace path prompts'));
    return;
  }

  let changed = false;
  for (const [name, project] of Object.entries(cfg.projects)) {
    if (!project || typeof project !== 'object') continue;
    const current = project.workspacePath || '';
    if (current && fs.existsSync(current)) {
      console.log(color('green', `  ${name}: ${current}`));
      continue;
    }

    const defaultPath = name === 'sdlc-framework' ? root : '';
    if (current) {
      console.log(color('yellow', `  ${name}: configured path does not exist: ${current}`));
    }
    const answer = await prompt.ask(`  Workspace path for ${name} (blank to skip)`, defaultPath);
    if (!answer) continue;
    const resolved = path.resolve(answer.replace(/^~(?=$|\/|\\)/, os.homedir()));
    if (!fs.existsSync(resolved)) {
      console.log(color('yellow', `  Path does not exist, leaving ${name} unchanged: ${resolved}`));
      continue;
    }
    project.workspacePath = resolved;
    changed = true;
    console.log(color('green', `  Set ${name}.workspacePath = ${resolved}`));
  }

  if (changed) writeJson(configFile, cfg);
}

function shellProfileCandidates() {
  if (isWindows) {
    const documents = path.join(os.homedir(), 'Documents');
    return [path.join(documents, 'PowerShell', 'Microsoft.PowerShell_profile.ps1')];
  }
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh')) return [path.join(os.homedir(), '.zshrc')];
  if (shell.includes('bash')) return [path.join(os.homedir(), '.bashrc'), path.join(os.homedir(), '.bash_profile')];
  return [path.join(os.homedir(), '.profile')];
}

async function maybeAddBinToPath(prompt) {
  const binDir = path.join(root, 'bin');
  const alreadyOnPath = (process.env.PATH || '').split(path.delimiter).includes(binDir);
  if (alreadyOnPath) {
    console.log(color('green', '  bin/ is already on PATH for this shell'));
    return;
  }

  const profile = shellProfileCandidates()[0];
  const answer = await prompt.ask(`  Add ${binDir} to ${path.basename(profile)}? (y/N)`, 'N');
  if (!/^y(es)?$/i.test(answer)) {
    console.log(color('dim', `  Skipping PATH update. Add manually: ${binDir}`));
    return;
  }

  fs.mkdirSync(path.dirname(profile), { recursive: true });
  const existing = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : '';
  if (existing.includes(binDir)) {
    console.log(color('green', `  ${profile} already contains bin/`));
    return;
  }
  const line = isWindows
    ? `\n# SDLC Framework CLI\n$env:PATH = "${binDir};$env:PATH"\n`
    : `\n# SDLC Framework CLI\nexport PATH="${binDir}:$PATH"\n`;
  fs.appendFileSync(profile, line, 'utf8');
  console.log(color('green', `  Added bin/ to ${profile}`));
}

function printToolStatus(name, installHint) {
  if (commandExists(name)) {
    console.log(color('green', `  ${name} found`));
  } else {
    console.log(color('dim', `  ${name} not found. ${installHint}`));
  }
}

// ─── Stack catalog ─────────────────────────────────────────────────────────────
//
// One entry = one supported product. To add a new tracker / code host / chat tool,
// add an object to the matching list below — the interactive prompt, the .mcp.json
// composition, the .env selectors, and the "keys you still need" summary all read
// from this catalog. No other code changes are required.
//
// Fields:
//   id          stable key (printed under --yes / scripting)
//   label       menu text
//   env         { ENV_VAR: value } written into .env  (e.g. PM_PROVIDER selector)
//   mcp         { "Server Name": {command,args,env} } merged into .mcp.json
//   install     { cmd, args, label } optional package the MCP needs (e.g. linear-mcp)
//   requiredEnv [ENV_VAR, …] keys the user must fill in .env for this choice to work
//   requiredConfig [dotted.path, …] values that live in .sdlc-framework.config.json
//   note        one-line hint printed after selection
//
// The literal token <your-ado-org> in any mcp args triggers a one-time org prompt.
const ADO_MCP = { command: 'npx', args: ['-y', '@azure-devops/mcp', '<your-ado-org>'] };

const STACK_CATALOG = {
  tracker: {
    label: 'Project tracker (stories & tasks)',
    options: [
      { id: 'github', label: 'GitHub Issues / Projects', env: { PM_PROVIDER: 'github' },
        requiredEnv: ['GITHUB_TOKEN'], note: 'Tracker reads/writes via the gh CLI + GitHub API (no extra MCP).' },
      { id: 'linear', label: 'Linear', env: { PM_PROVIDER: 'linear' },
        mcp: { linear: { command: 'sh', args: ['-c', 'set -a && . .env && set +a && node $(npm root -g)/linear-mcp/build/index.js'] } },
        install: { cmd: 'npm', args: ['install', '-g', 'linear-mcp'], label: 'linear-mcp (global)' },
        requiredEnv: ['LINEAR_API_KEY', 'LINEAR_TEAM_ID'] },
      { id: 'azure-devops', label: 'Azure DevOps Boards', env: { PM_PROVIDER: 'azure' },
        mcp: { 'Azure DevOps': ADO_MCP }, requiredEnv: ['AZURE_DEVOPS_PAT'] },
      { id: 'agility', label: 'Agility (Digital.ai / VersionOne)', env: { PM_PROVIDER: 'agility' },
        mcp: { Agility: { command: 'node', args: ['tools/mcp-agility/index.js'],
          env: { AGILITY_API_KEY: '${AGILITY_API_KEY}', AGILITY_BASE_URL: '${AGILITY_BASE_URL}' } } },
        requiredEnv: ['AGILITY_API_KEY', 'AGILITY_BASE_URL'] },
      { id: 'mock', label: 'Mock (no external tracker — local testing)', env: { PM_PROVIDER: 'mock' } },
    ],
  },
  codeHost: {
    label: 'Code host (pull requests)',
    options: [
      { id: 'github', label: 'GitHub', requiredEnv: ['GITHUB_TOKEN'],
        note: 'PRs via the gh CLI (already used by the loop).' },
      { id: 'azure-devops', label: 'Azure DevOps Repos', mcp: { 'Azure DevOps': ADO_MCP },
        requiredEnv: ['AZURE_DEVOPS_PAT'], note: 'PRs via the Azure DevOps MCP (shared with the tracker).' },
    ],
  },
  chat: {
    label: 'Chat notifications',
    options: [
      { id: 'none', label: 'None', env: { NOTIFY_PROVIDER: 'mock' } },
      { id: 'slack', label: 'Slack', env: { NOTIFY_PROVIDER: 'slack' }, requiredEnv: ['SLACK_WEBHOOK_URL'] },
      { id: 'teams', label: 'Microsoft Teams', env: { NOTIFY_PROVIDER: 'teams' },
        requiredConfig: ['notifications.teams.webhookUrl'] },
    ],
  },
};

// The framework's own MCP is always available regardless of stack.
const FRAMEWORK_MCP = { 'sdlc-framework': { command: 'node', args: ['tools/mcp-sdlc-framework/index.js'] } };

/** Server names this catalog manages, so a re-run can replace them without clobbering user-added servers. */
function catalogServerNames() {
  const names = new Set(Object.keys(FRAMEWORK_MCP));
  for (const category of Object.values(STACK_CATALOG)) {
    for (const opt of category.options) {
      for (const name of Object.keys(opt.mcp || {})) names.add(name);
    }
  }
  return names;
}

async function selectOption(prompt, category) {
  console.log(color('cyan', `  ${category.label}:`));
  category.options.forEach((opt, i) => {
    console.log(`    ${i + 1}) ${opt.label}${i === 0 ? color('dim', ' (default)') : ''}`);
  });
  const answer = await prompt.ask('  Choose a number', '1');
  const opt = category.options[Number(answer) - 1] || category.options[0];
  console.log(color('green', `  → ${opt.label}`));
  if (opt.note) console.log(color('dim', `    ${opt.note}`));
  return opt;
}

/** Set or append KEY=value lines in .env without disturbing other lines. */
function patchEnvVars(updates) {
  const envFile = path.join(root, '.env');
  if (!fs.existsSync(envFile)) return;
  const lines = fs.readFileSync(envFile, 'utf8').split('\n');
  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (idx >= 0) lines[idx] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(envFile, lines.join('\n'), 'utf8');
}

function envValue(key) {
  const envFile = path.join(root, '.env');
  if (!fs.existsSync(envFile)) return '';
  const line = fs.readFileSync(envFile, 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : '';
}

/** Replace managed servers in .mcp.json with the freshly selected set; preserve user-added ones. */
function writeMcpServers(servers) {
  const mcpFile = path.join(root, '.mcp.json');
  let current = {};
  if (fs.existsSync(mcpFile)) {
    try { current = readJson(mcpFile); } catch { backupFile(mcpFile, 'invalid JSON'); current = {}; }
  }
  if (!isPlainObject(current.mcpServers)) current.mcpServers = {};
  const managed = catalogServerNames();
  for (const name of Object.keys(current.mcpServers)) {
    if (managed.has(name)) delete current.mcpServers[name];
  }
  Object.assign(current.mcpServers, servers);
  writeJson(mcpFile, current);
  console.log(color('green', `  Wrote .mcp.json (${Object.keys(servers).length} server(s): ${Object.keys(servers).join(', ')})`));
}

async function configureStack(prompt, configFile) {
  const tracker = await selectOption(prompt, STACK_CATALOG.tracker);
  const codeHost = await selectOption(prompt, STACK_CATALOG.codeHost);
  const chat = await selectOption(prompt, STACK_CATALOG.chat);

  // Compose .mcp.json: framework MCP + whatever the selections require.
  let servers = { ...FRAMEWORK_MCP, ...(tracker.mcp || {}), ...(codeHost.mcp || {}) };

  // One-time Azure DevOps org prompt if any selected MCP carries the placeholder.
  if (JSON.stringify(servers).includes('<your-ado-org>')) {
    const org = await prompt.ask('  Azure DevOps organization (e.g. contoso)', '');
    if (org) servers = JSON.parse(JSON.stringify(servers).split('<your-ado-org>').join(org));
    else console.log(color('yellow', '  Left <your-ado-org> placeholder — edit .mcp.json before first run'));
  }
  writeMcpServers(servers);

  // .env selectors (PM_PROVIDER / NOTIFY_PROVIDER).
  patchEnvVars({ ...(tracker.env || {}), ...(chat.env || {}) });
  console.log(color('green', `  Set PM_PROVIDER=${tracker.env?.PM_PROVIDER ?? '(unchanged)'}, NOTIFY_PROVIDER=${chat.env?.NOTIFY_PROVIDER ?? '(unchanged)'}`));

  // Install any package an MCP needs (e.g. linear-mcp), unless skipped.
  const installs = [tracker.install, codeHost.install].filter(Boolean);
  for (const inst of installs) {
    if (skipInstall) { console.log(color('dim', `  Skipped install of ${inst.label} (--skip-install)`)); continue; }
    console.log(color('yellow', `  Installing ${inst.label}…`));
    try { run(inst.cmd, inst.args); } catch (e) { console.log(color('yellow', `  Install failed (${e.message}); run manually: ${inst.cmd} ${inst.args.join(' ')}`)); }
  }

  // Summary: which secrets the user still needs to supply.
  const requiredEnv = [...new Set([...(tracker.requiredEnv || []), ...(codeHost.requiredEnv || []), ...(chat.requiredEnv || [])])];
  const missing = requiredEnv.filter((k) => !envValue(k));
  const requiredConfig = [...(tracker.requiredConfig || []), ...(codeHost.requiredConfig || []), ...(chat.requiredConfig || [])];
  if (missing.length || requiredConfig.length) {
    console.log(color('yellow', '\n  Before the first run, supply these credentials:'));
    for (const k of missing) console.log(`    .env   ${color('cyan', k)}=…`);
    for (const c of requiredConfig) console.log(`    config ${color('cyan', c)} in .sdlc-framework.config.json`);
  } else if (requiredEnv.length) {
    console.log(color('green', '  All required credentials for this stack are already set.'));
  }
}

async function main() {
  console.log(color('cyan', '\n=== SDLC Framework Setup ==='));
  console.log(color('dim', `Platform: ${os.platform()} ${os.arch()}`));

  logStep('[1/9] Checking Node.js');
  if (nodeMajor() < 22 || nodeMajor() >= 24) {
    throw new Error(`Node ${process.version} detected. Use Node 22.x before setup.`);
  }
  console.log(color('green', `  Node ${process.version}`));

  logStep('[2/9] Checking optional tools');
  printToolStatus('ollama', 'Install from https://ollama.com/download for local models.');
  printToolStatus('goose', 'Install from https://block.github.io/goose/docs/getting-started for local execution mode.');
  printToolStatus('claude', 'Install with: npm install -g @anthropic-ai/claude-code');
  printToolStatus('gh', 'Install GitHub CLI from https://cli.github.com for Renovate/Dependabot PR upkeep.');
  printToolStatus('harlequin', 'Install with: pip install harlequin for the SQLite TUI.');

  logStep('[3/9] Detecting agent driver');
  const driver = detectDriver();
  console.log(color('green', `  Detected driver: ${driver}`));

  logStep('[4/9] Installing Node dependencies');
  if (skipInstall) {
    console.log(color('dim', '  Skipped by --skip-install'));
  } else {
    run('npm', ['install']);
  }

  logStep('[5/9] Creating environment file');
  ensureEnvFile();

  logStep('[6/9] Creating framework config');
  const configFile = ensureConfigFile(driver);

  const prompt = createPrompt();
  try {
    logStep('[7/9] Selecting your stack (tracker / code host / chat)');
    await configureStack(prompt, configFile);

    logStep('[8/9] Configuring project workspace paths');
    await configureWorkspacePaths(prompt, configFile);

    logStep('[9/9] Shell PATH');
    await maybeAddBinToPath(prompt);
  } finally {
    prompt.close();
  }

  console.log(color('cyan', '\n=== Setup complete ==='));
  console.log('Next steps:');
  console.log('  npm run server      # API on http://localhost:3001');
  console.log('  npm run dashboard   # Dashboard on http://localhost:3847');
  console.log('  npm run dev         # API + dashboard together');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(color('red', `\nSetup failed: ${error.message}`));
    process.exit(1);
  });
}

// Exported for testing the stack-composition logic with a stub prompt.
module.exports = { STACK_CATALOG, configureStack, writeMcpServers, patchEnvVars, catalogServerNames };
