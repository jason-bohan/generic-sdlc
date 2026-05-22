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
    shell: false,
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

function detectDriver() {
  if (commandExists('agent')) return 'cursor';
  if (commandExists('cursor-agent')) return 'cursor';
  if (commandExists('claude')) return 'claude-code';
  if (commandExists('goose')) return 'goose';
  return 'generic';
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

async function main() {
  console.log(color('cyan', '\n=== SDLC Framework Setup ==='));
  console.log(color('dim', `Platform: ${os.platform()} ${os.arch()}`));

  logStep('[1/8] Checking Node.js');
  if (nodeMajor() < 22 || nodeMajor() >= 24) {
    throw new Error(`Node ${process.version} detected. Use Node 22.x before setup.`);
  }
  console.log(color('green', `  Node ${process.version}`));

  logStep('[2/8] Checking optional tools');
  printToolStatus('ollama', 'Install from https://ollama.com/download for local models.');
  printToolStatus('goose', 'Install from https://block.github.io/goose/docs/getting-started for local execution mode.');
  printToolStatus('claude', 'Install with: npm install -g @anthropic-ai/claude-code');
  printToolStatus('gh', 'Install GitHub CLI from https://cli.github.com for Renovate/Dependabot PR upkeep.');
  printToolStatus('harlequin', 'Install with: pip install harlequin for the SQLite TUI.');

  logStep('[3/8] Detecting agent driver');
  const driver = detectDriver();
  console.log(color('green', `  Detected driver: ${driver}`));

  logStep('[4/8] Installing Node dependencies');
  if (skipInstall) {
    console.log(color('dim', '  Skipped by --skip-install'));
  } else {
    run('npm', ['install']);
  }

  logStep('[5/8] Creating environment file');
  ensureEnvFile();

  logStep('[6/8] Creating framework config');
  const configFile = ensureConfigFile(driver);

  const prompt = createPrompt();
  try {
    logStep('[7/8] Configuring project workspace paths');
    await configureWorkspacePaths(prompt, configFile);

    logStep('[8/8] Shell PATH');
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

main().catch((error) => {
  console.error(color('red', `\nSetup failed: ${error.message}`));
  process.exit(1);
});
