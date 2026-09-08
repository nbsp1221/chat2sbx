import { type CAC, cac } from 'cac';
import { loadAppConfig, loadRuntimeConfig } from '../config.js';
import { serve } from '../runtime/serve.js';
import { StateDatabase } from '../state/database.js';
import { version } from '../version.js';
import { WorkspaceService } from '../workspaces/service.js';
import { setup } from './setup.js';
import { status } from './status.js';

const ownerId = 'local-owner';

function listWorkspaces(): void {
  const config = loadAppConfig();
  const database = new StateDatabase(config.databasePath);
  const workspaces = new WorkspaceService({
    database,
    workspaceRoot: config.workspaceRoot,
    dataRoot: config.dataRoot,
  });
  try {
    console.log(JSON.stringify(workspaces.list(ownerId), null, 2));
  } finally {
    database.close();
  }
}

export function createCli(): CAC {
  const cli = cac('chat2sbx');
  cli.version(version);
  cli.help();

  cli
    .command('setup', 'Check prerequisites and create the CodexPro sandbox template')
    .action(() => setup(loadRuntimeConfig()));

  cli
    .command('serve', 'Run the local MCP gateway in the foreground')
    .action(() => serve(loadRuntimeConfig()));

  cli.command('status', 'Show service and MCP readiness').action(async () => {
    if (!(await status(loadRuntimeConfig()))) {
      process.exitCode = 1;
    }
  });

  cli.command('workspace <action>', 'List managed workspaces').action((action: string) => {
    if (action !== 'list') {
      throw new Error(`Unknown workspace action: ${action}`);
    }
    listWorkspaces();
  });

  cli.command('help [command]', 'Show help for a command').action((commandName?: string) => {
    if (!commandName) {
      cli.unsetMatchedCommand();
      cli.outputHelp();
      return;
    }
    const command = cli.commands.find((candidate) => candidate.name === commandName);
    if (!command) {
      throw new Error(`Unknown command: ${commandName}`);
    }
    command.outputHelp();
  });

  return cli;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const cli = createCli();
  if (argv.length <= 2) {
    cli.outputHelp();
    return;
  }
  cli.parse(argv, { run: false });
  if (!cli.matchedCommand) {
    if (cli.options.help || cli.options.version) {
      return;
    }
    throw new Error(`Unknown command: ${String(cli.args[0])}`);
  }
  await cli.runMatchedCommand();
}
