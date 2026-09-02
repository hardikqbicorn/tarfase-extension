import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

/**
 * Minimal .env loader. Deliberately dependency-free: these scripts are run
 * before `npm install` in some workflows, and a migration runner should not
 * need a package to read a key=value file.
 *
 * Existing process environment always wins, so `DATABASE_URL=... npm run migrate`
 * overrides the file.
 */
function stripInlineComment(value: string): string {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\" && inDouble) {
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (ch === "#" && !inSingle && !inDouble) {
      return value.slice(0, i).trimEnd();
    }
  }

  return value.trim();
}

export function loadDotEnv(file = ".env"): void {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = stripInlineComment(line.slice(eq + 1));

    // Strip matching surrounding quotes, which are common in .env files.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      [
        "DATABASE_URL is not set.",
        "",
        "Set it in .env (copy .env.example), or pass it inline:",
        "  DATABASE_URL='postgresql://...' npm run migrate",
      ].join("\n"),
    );
    process.exit(1);
  }
  return url;
}
