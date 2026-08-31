#!/usr/bin/env node
import { parseArgs } from "./args";
import { installCommand } from "./commands/install";
import { loginCommand } from "./commands/login";
import { doctorCommand } from "./commands/doctor";
import { configCommand } from "./commands/config";
import { uninstallCommand } from "./commands/uninstall";
import { bold, dim, fail } from "./output";

// Kept in step with package.json by the release workflow.
const VERSION = "0.1.0";

const HELP = `${bold("ide-collector")} - install and configure the IDE Event Collector extension

${bold("USAGE")}
  ide-collector <command> [options]

${bold("COMMANDS")}
  install       Install the extension into your VS Code-family IDE
  login         Register this installation and hand the credential to the extension
  config        Read or write the extension's telemetry.* settings
  doctor        Diagnose why collection is not working
  uninstall     Remove the extension and clear local state

${bold("QUICK START")}
  npx @ide-collector/cli install
  npx @ide-collector/cli config set telemetry.enabled true
  npx @ide-collector/cli login --code <enrollment-code> \\
      --registration-endpoint https://api.example.com \\
      --ingestion-endpoint https://ingest.example.com
  # restart your IDE

${bold("INSTALL OPTIONS")}
  --ide <vscode|cursor|windsurf>   Target one IDE (default: every detected IDE)
  --vsix <path>                    Install a local .vsix instead of downloading
  --extension-version <tag>        Release tag to download (default: latest)
  --repo <owner/name>              Source repository for releases
  --endpoint <url>                 Set telemetry.ingestionEndpoint
  --registration-endpoint <url>    Set telemetry.registrationEndpoint
  --enable                         Also set telemetry.enabled to true

${bold("LOGIN OPTIONS")}
  --code <enrollment-code>         Code issued by your platform administrator
  --registration-endpoint <url>    Control plane (default: http://localhost:8081)
  --ingestion-endpoint <url>       Ingestion API (default: http://localhost:8080)

${bold("GLOBAL")}
  -h, --help       Show this help
  -v, --version    Show the CLI version

${dim("Collection is opt-in and off by default. Nothing is captured until you")}
${dim("enable it and register.")}
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.options.version === true) {
    console.log(VERSION);
    return 0;
  }

  if (!args.command || args.options.help === true) {
    console.log(HELP);
    // `ide-collector` with no command is a usage error, not a success, so
    // scripts that forget the subcommand fail loudly.
    return args.command ? 0 : args.options.help === true ? 0 : 1;
  }

  switch (args.command) {
    case "install":
      return installCommand(args);
    case "login":
    case "register":
      return loginCommand(args);
    case "config":
      return configCommand(args);
    case "doctor":
      return doctorCommand(args);
    case "uninstall":
      return uninstallCommand(args);
    case "help":
      console.log(HELP);
      return 0;
    default:
      fail(`Unknown command: ${args.command}`, "Run `ide-collector --help` for usage.");
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    fail("Unexpected error", err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
