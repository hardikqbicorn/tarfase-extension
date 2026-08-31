/**
 * Minimal argument parser.
 *
 * Hand-rolled rather than pulling in a parsing library: this CLI installs
 * software and handles credentials, and it is meant to be run via `npx` by
 * people who have not audited it. Every runtime dependency is supply-chain
 * surface in that position, and the command grammar here is small enough that
 * the tradeoff is not close.
 */

export interface ParsedArgs {
  command?: string;
  /** Positional arguments after the command. */
  positionals: string[];
  /** `--flag value` and `--flag=value` become entries; bare `--flag` becomes true. */
  options: Record<string, string | boolean>;
}

/** Flags that never take a value, so `--json status` keeps `status` positional. */
const BOOLEAN_FLAGS = new Set([
  "help",
  "version",
  "json",
  "yes",
  "force",
  "quiet",
  "verbose",
  "insecure",
  "no-open",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");

      if (eq !== -1) {
        options[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }

      if (BOOLEAN_FLAGS.has(body)) {
        options[body] = true;
        continue;
      }

      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        options[body] = next;
        i++;
      } else {
        options[body] = true;
      }
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      // Short flags: -h, -v. Only the aliases below are recognised.
      const short = arg.slice(1);
      if (short === "h") options.help = true;
      else if (short === "v") options.version = true;
      else options[short] = true;
      continue;
    }

    positionals.push(arg);
  }

  const [command, ...rest] = positionals;
  return { command, positionals: rest, options };
}

export function optionString(
  options: ParsedArgs["options"],
  key: string
): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

export function optionBool(options: ParsedArgs["options"], key: string): boolean {
  return options[key] === true || options[key] === "true";
}
