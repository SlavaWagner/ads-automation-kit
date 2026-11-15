import chalk from 'chalk';

/**
 * Checks whether ads-automation-kit is executing inside Google Antigravity CLI (agy).
 * Modeled after SlavaWagner/ai-ads-pipeline/bin/index.js and SlavaWagner/swa-google-ads-mcp.
 */
export function isRunningInsideAntigravity(argv = process.argv, env = process.env) {
  if (argv.includes('--force') || argv.includes('--inside-agy')) {
    return true;
  }

  const knownKeys = [
    'ANTIGRAVITY_PROJECT_ID',
    'ANTIGRAVITY_LS_VERSION',
    'ANTIGRAVITY_SOURCE_METADATA',
    'ANTIGRAVITY_TRAJECTORY_ID',
    'ANTIGRAVITY_AGENT',
    'ANTIGRAVITY_CONVERSATION_ID',
    'JETSKI_APP_DATA_DIR',
    'AGY_SESSION',
    'AGY'
  ];

  if (knownKeys.some((k) => Boolean(env[k]))) {
    return true;
  }

  return Object.keys(env).some(
    (k) => (k.startsWith('ANTIGRAVITY_') || k.startsWith('AGY_') || k.startsWith('JETSKI_')) && Boolean(env[k])
  );
}

/**
 * Formats and prints the Antigravity CLI prerequisite notice.
 * Uses stderr when writeToStderr=true so MCP stdio JSON-RPC stays uncorrupted.
 */
export function showAgyPrerequisiteWarning(writeToStderr = false) {
  const out = writeToStderr ? console.error : console.log;
  const yellow = chalk.hex('#eab308');
  const green = chalk.bold.hex('#1dd900');
  const cyan = chalk.bold.hex('#06b6d4');
  const white = chalk.bold.white;

  out('');
  out(yellow('================================================================================'));
  out(yellow('  PREREQUISITE REQUIRED: GOOGLE ANTIGRAVITY CLI ("agy")'));
  out(yellow('================================================================================'));
  out('');
  out(white('  ads-automation-kit operates exclusively INSIDE the Google Antigravity CLI!'));
  out('');
  out(chalk.yellow('  Please start Google Antigravity first using "agy" in your terminal, or run'));
  out(chalk.yellow('  the MCP server via Antigravity\'s ~/.gemini/config/mcp_config.json file.'));
  out('');
  out(cyan('  STEP 1:'));
  out(white('    Run: ') + green('agy'));
  out('');
  out(cyan('  STEP 2:'));
  out(white('    Inside Antigravity, launch any CLI Agent or run setup:'));
  out(green('    ads-automation-kit setup && ads-automation-kit'));
  out('');
  out(yellow('================================================================================'));
  out(chalk.gray('  (Developer / CI override: pass "--inside-agy" or "--force")'));
  out('');
}

/**
 * Enforces Antigravity CLI execution context.
 * @param {'cli'|'mcp'} mode
 */
export function enforceAntigravityRuntime(mode = 'cli') {
  if (!isRunningInsideAntigravity()) {
    const isMcp = mode === 'mcp';
    showAgyPrerequisiteWarning(isMcp);
    process.exit(isMcp ? 1 : 0);
  }
}
