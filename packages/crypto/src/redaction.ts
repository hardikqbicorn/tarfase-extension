/**
 * Redaction layer: strips secrets/PII from event payloads before they ever
 * leave the IDE process. Applied in the extension (defense in depth) AND
 * again in the Kafka consumer before persistence, so a bypass at one layer
 * cannot leak data into Supabase.
 */

export interface RedactionRule {
  name: string;
  /** Matches "KEY=value" / "KEY: value" style secret assignments. */
  pattern: RegExp;
  replacement?: string;
}

const REDACTED = "[REDACTED]";

/** Key-name fragments that mark a field as sensitive regardless of value shape. */
const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /password/i,
  /passwd/i,
  /secret/i,
  /api[_-]?key/i,
  /access[_-]?key/i,
  /private[_-]?key/i,
  /auth(orization)?[_-]?token/i,
  /^token$/i,
  /bearer/i,
  /session[_-]?cookie/i,
  /ssh[_-]?key/i,
  /credit[_-]?card/i,
  /\bcvv\b/i,
  /\bssn\b/i,
  /client[_-]?secret/i,
  /refresh[_-]?token/i,
];

/** Value-shape patterns for secrets embedded in free text (e.g. .env lines, terminal output). */
export const DEFAULT_REDACTION_RULES: RedactionRule[] = [
  {
    name: "env-assignment-secret",
    pattern:
      /\b((?:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*)(['"]?)([^\s'"]+)\2/gi,
    replacement: `$1$2${REDACTED}$2`,
  },
  {
    name: "aws-access-key-id",
    pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    name: "aws-secret-key-like",
    pattern: /\b[A-Za-z0-9/+=]{40}\b/g,
  },
  {
    name: "bearer-token",
    pattern: /\b(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,
    replacement: `$1${REDACTED}`,
  },
  {
    name: "generic-jwt",
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  },
  {
    name: "private-key-block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: "openai-style-key",
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/g,
  },
  {
    name: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    name: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    name: "credit-card",
    pattern: /\b(?:\d[ -]*?){13,16}\b/g,
  },
];

export interface RedactorOptions {
  rules?: RedactionRule[];
  /** Extra key-name patterns considered sensitive, merged with the defaults. */
  extraSensitiveKeys?: RegExp[];
  /** Max depth walked into nested objects/arrays to avoid pathological payloads. */
  maxDepth?: number;
}

export class Redactor {
  private readonly rules: RedactionRule[];
  private readonly sensitiveKeyPatterns: RegExp[];
  private readonly maxDepth: number;

  constructor(options: RedactorOptions = {}) {
    this.rules = options.rules ?? DEFAULT_REDACTION_RULES;
    this.sensitiveKeyPatterns = [
      ...SENSITIVE_KEY_PATTERNS,
      ...(options.extraSensitiveKeys ?? []),
    ];
    this.maxDepth = options.maxDepth ?? 8;
  }

  /** Redacts secret-shaped substrings out of a free-text string. */
  redactString(input: string): string {
    let output = input;
    for (const rule of this.rules) {
      output = output.replace(rule.pattern, rule.replacement ?? REDACTED);
    }
    return output;
  }

  isSensitiveKey(key: string): boolean {
    return this.sensitiveKeyPatterns.some((p) => p.test(key));
  }

  /** Deep-redacts an arbitrary JSON-like value (event payload/metadata). */
  redactValue(value: unknown, depth = 0): unknown {
    if (depth > this.maxDepth) return REDACTED;

    if (typeof value === "string") {
      return this.redactString(value);
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.redactValue(v, depth + 1));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (this.isSensitiveKey(k)) {
          out[k] = REDACTED;
        } else {
          out[k] = this.redactValue(v, depth + 1);
        }
      }
      return out;
    }
    return value;
  }

  /** Redacts payload + metadata on a full event object in place (returns a copy). */
  redactEvent<T extends { payload?: unknown; metadata?: unknown }>(event: T): T {
    return {
      ...event,
      payload: event.payload !== undefined ? this.redactValue(event.payload) : event.payload,
      metadata:
        event.metadata !== undefined ? this.redactValue(event.metadata) : event.metadata,
    };
  }
}

export const defaultRedactor = new Redactor();
