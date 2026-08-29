import { describe, expect, it } from "vitest";
import { Redactor } from "./redaction";

describe("Redactor", () => {
  const redactor = new Redactor();

  it("redacts env-style secret assignments in free text", () => {
    const input = "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\nPASSWORD=hunter2";
    const output = redactor.redactString(input);
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(output).toContain("[REDACTED]");
  });

  it("redacts AWS secret access key style assignment", () => {
    const input = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const output = redactor.redactString(input);
    expect(output).not.toContain("wJalrXUtnFEMI");
  });

  it("redacts sensitive object keys regardless of value", () => {
    const value = { password: "hunter2", nested: { apiKey: "abc123" }, safe: "ok" };
    const result = redactor.redactValue(value) as any;
    expect(result.password).toBe("[REDACTED]");
    expect(result.nested.apiKey).toBe("[REDACTED]");
    expect(result.safe).toBe("ok");
  });

  it("redacts bearer tokens", () => {
    const output = redactor.redactString("Authorization: Bearer abc.def-ghi_123");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("abc.def-ghi_123");
  });

  it("redacts private key blocks", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    const output = redactor.redactString(key);
    expect(output).not.toContain("MIIEpAIBAAKCAQEA");
  });

  it("leaves non-sensitive event payloads untouched", () => {
    const value = { filePath: "src/index.ts", lineCount: 42 };
    const result = redactor.redactValue(value);
    expect(result).toEqual(value);
  });

  it("redactEvent redacts payload and metadata only", () => {
    const event = {
      event_type: "terminal.command_executed",
      payload: { command: "export TOKEN=abc123xyz", exitCode: 0 },
      metadata: { secret: "shh" },
    };
    const redacted = redactor.redactEvent(event);
    expect(redacted.payload.command).not.toContain("abc123xyz");
    expect(redacted.metadata.secret).toBe("[REDACTED]");
    expect(redacted.event_type).toBe("terminal.command_executed");
  });
});
