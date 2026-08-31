/** Terminal output helpers. Colour is dropped when not a TTY or when NO_COLOR is set. */

const useColor =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const wrap = (code: string) => (text: string) => (useColor ? `${code}${text}[0m` : text);

export const bold = wrap("[1m");
export const dim = wrap("[2m");
export const green = wrap("[32m");
export const yellow = wrap("[33m");
export const red = wrap("[31m");
export const cyan = wrap("[36m");

export function ok(message: string): void {
  console.log(`${green("✓")} ${message}`);
}

export function warn(message: string, detail?: string): void {
  console.log(`${yellow("!")} ${message}`);
  if (detail) indent(detail);
}

export function fail(message: string, detail?: string): void {
  console.log(`${red("✗")} ${message}`);
  if (detail) indent(detail);
}

export function info(message: string): void {
  console.log(`  ${message}`);
}

export function heading(message: string): void {
  console.log(`\n${bold(message)}`);
}

export function indent(text: string, prefix = "    "): void {
  for (const line of text.split("\n")) console.log(`${prefix}${line}`);
}

export function step(message: string): void {
  console.log(`${cyan("→")} ${message}`);
}
