import { createHash } from "crypto";

/**
 * Path helpers shared by every collector. Kept free of the `vscode` import so
 * they are directly unit-testable.
 */

/**
 * Converts an absolute file path into a workspace-relative one. Absolute paths
 * leak the developer's username and directory layout, so events carry the
 * relative form whenever the file lives inside the open workspace.
 */
export function toWorkspaceRelative(filePath: string, workspaceRoot?: string): string {
  if (!workspaceRoot) return basename(filePath);
  const normalizedRoot = workspaceRoot.endsWith("/") ? workspaceRoot : `${workspaceRoot}/`;
  if (filePath.startsWith(normalizedRoot)) {
    return filePath.slice(normalizedRoot.length);
  }
  // Outside the workspace: report only the file name, never the full path.
  return basename(filePath);
}

export function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

/** Stable, non-reversible identifier for a workspace/repository root. */
export function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * Files whose *contents or names* commonly carry secrets. Their paths are
 * still reported (they are useful signal), but collectors must never attach
 * content or diff payloads for them.
 */
const SENSITIVE_FILE_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.keystore$/i,
  /(^|\/)credentials$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.ssh\//i,
  /secrets?\.(ya?ml|json|toml)$/i,
];

export function isSensitiveFile(filePath: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}
