import { createInterface } from "readline";

/**
 * A yes/no prompt, and the rule for what to do without a terminal.
 *
 * `setup` turns on a tool that watches what you type, so it has to ask before
 * it does. The interesting case is the non-interactive one - a CI job, a pipe,
 * a provisioning script - where there is nobody to ask. Answering "yes" on the
 * user's behalf there would make the consent theatre, so `confirm` refuses
 * instead and the caller tells them to pass `--yes`. That keeps the
 * unattended path possible but explicit.
 */

export function isInteractive(input = process.stdin, output = process.stdout): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question} `, resolve);
    });
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
