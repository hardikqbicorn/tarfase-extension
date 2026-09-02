import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { optionBool, optionString, parseArgs } from "./args";
import { selectIdes, userSettingsDir, type IdeTarget } from "./ide";
import { applyCollectorSettings, readSettings, stripJsonComments, writeSettings } from "./settings";
import { clearHandoff, readHandoff, writeHandoff } from "./handoff";
import { coerceSettingValue } from "./commands/config";
import { EXTENSION_ID, selectVsixAsset, findLocalVsix, resolveVsix } from "./vsix";
import { machineFingerprint, registerInstallation } from "./register";
import { isInteractive } from "./prompt";
import { hostname, userInfo } from "os";

describe("parseArgs", () => {
  it("separates command, positionals, and options", () => {
    const parsed = parseArgs(["config", "set", "telemetry.enabled", "true", "--ide", "cursor"]);
    expect(parsed.command).toBe("config");
    expect(parsed.positionals).toEqual(["set", "telemetry.enabled", "true"]);
    expect(parsed.options.ide).toBe("cursor");
  });

  it("supports --flag=value", () => {
    expect(parseArgs(["install", "--ide=vscode"]).options.ide).toBe("vscode");
  });

  it("treats known boolean flags as booleans, not value-takers", () => {
    // Without the boolean list, `--enable install` would swallow "install".
    const parsed = parseArgs(["--json", "doctor"]);
    expect(parsed.options.json).toBe(true);
    expect(parsed.command).toBe("doctor");
  });

  it("treats a trailing valueless option as a boolean", () => {
    expect(parseArgs(["install", "--enable"]).options.enable).toBe(true);
  });

  it("maps -h and -v to help and version", () => {
    expect(parseArgs(["-h"]).options.help).toBe(true);
    expect(parseArgs(["-v"]).options.version).toBe(true);
  });

  it("passes everything after -- through as positionals", () => {
    const parsed = parseArgs(["install", "--", "--not-a-flag"]);
    expect(parsed.positionals).toContain("--not-a-flag");
  });

  it("does not confuse a negative-looking value with a flag", () => {
    // `--code -abc` should treat -abc as a flag, not a value, so a malformed
    // code is caught rather than silently becoming the option value.
    const parsed = parseArgs(["login", "--code", "-abc"]);
    expect(parsed.options.code).toBe(true);
  });

  it("optionString and optionBool read values safely", () => {
    const { options } = parseArgs(["install", "--ide", "cursor", "--enable"]);
    expect(optionString(options, "ide")).toBe("cursor");
    expect(optionString(options, "enable")).toBeUndefined();
    expect(optionBool(options, "enable")).toBe(true);
    expect(optionBool(options, "missing")).toBe(false);
  });
});

describe("userSettingsDir", () => {
  it("uses the platform-appropriate location", () => {
    expect(userSettingsDir("Code", "darwin")).toContain("Library/Application Support/Code/User");
    expect(userSettingsDir("Code", "linux")).toContain("Code/User");
    expect(userSettingsDir("Code", "win32")).toContain("Code");
  });
});

describe("selectIdes", () => {
  const detected: IdeTarget[] = [
    { id: "vscode", label: "VS Code", command: "code", settingsDir: "/a" },
    { id: "cursor", label: "Cursor", command: "cursor", settingsDir: "/b" },
  ];

  it("returns every detected IDE when no preference is given", () => {
    expect(selectIdes(detected)).toHaveLength(2);
  });

  it("narrows to the requested IDE", () => {
    expect(selectIdes(detected, "cursor").map((i) => i.id)).toEqual(["cursor"]);
  });

  it("explains what is available when the preference matches nothing", () => {
    expect(() => selectIdes(detected, "windsurf")).toThrow(/vscode, cursor/);
  });
});

describe("stripJsonComments", () => {
  it("parses VS Code settings with comments and trailing commas", () => {
    const jsonc = `{
      // a line comment
      "telemetry.enabled": true, /* block */
      "other": "value",
    }`;
    expect(JSON.parse(stripJsonComments(jsonc))).toEqual({
      "telemetry.enabled": true,
      other: "value",
    });
  });

  it("leaves comment-like text inside strings alone", () => {
    const jsonc = '{"url": "https://example.com//path", "note": "/* not a comment */"}';
    const parsed = JSON.parse(stripJsonComments(jsonc));
    expect(parsed.url).toBe("https://example.com//path");
    expect(parsed.note).toBe("/* not a comment */");
  });

  it("handles escaped quotes inside strings", () => {
    const jsonc = '{"quote": "say \\"hi\\" // here"}';
    expect(JSON.parse(stripJsonComments(jsonc)).quote).toBe('say "hi" // here');
  });
});

describe("applyCollectorSettings", () => {
  it("merges only the provided keys and preserves the rest", () => {
    const merged = applyCollectorSettings(
      { "editor.fontSize": 14, "telemetry.enabled": false },
      { enabled: true, ingestionEndpoint: "https://ingest.example.com" }
    );
    expect(merged["editor.fontSize"]).toBe(14);
    expect(merged["telemetry.enabled"]).toBe(true);
    expect(merged["telemetry.ingestionEndpoint"]).toBe("https://ingest.example.com");
    // Not provided, so not written.
    expect(merged["telemetry.registrationEndpoint"]).toBeUndefined();
  });
});

describe("coerceSettingValue", () => {
  it("coerces booleans and numbers by key", () => {
    expect(coerceSettingValue("telemetry.enabled", "true")).toBe(true);
    expect(coerceSettingValue("telemetry.enabled", "false")).toBe(false);
    expect(coerceSettingValue("telemetry.batchSize", "50")).toBe(50);
    expect(coerceSettingValue("telemetry.ingestionEndpoint", "https://x")).toBe("https://x");
  });

  it("rejects a non-boolean for a boolean key rather than storing a string", () => {
    // "telemetry.enabled": "yes" would be silently ignored by the extension.
    expect(() => coerceSettingValue("telemetry.enabled", "yes")).toThrow(/true or false/);
  });

  it("rejects a non-numeric value for a numeric key", () => {
    expect(() => coerceSettingValue("telemetry.batchSize", "many")).toThrow(/number/);
  });
});

describe("settings read/write", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ide-collector-settings-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("treats a missing settings file as empty rather than failing", async () => {
    const result = await readSettings(dir);
    expect(result.existed).toBe(false);
    expect(result.settings).toEqual({});
  });

  it("round-trips settings and backs up the previous file", async () => {
    await writeFile(join(dir, "settings.json"), '{"editor.fontSize": 12}');
    await writeSettings(dir, { "editor.fontSize": 12, "telemetry.enabled": true });

    const after = await readSettings(dir);
    expect(after.settings["telemetry.enabled"]).toBe(true);
    const backup = await readFile(join(dir, "settings.json.ide-collector-backup"), "utf8");
    expect(backup).toContain("fontSize");
  });

  it("reports an unparseable settings file instead of overwriting it", async () => {
    await writeFile(join(dir, "settings.json"), "{ this is not json ");
    await expect(readSettings(dir)).rejects.toThrow(/Could not parse/);
  });
});

describe("credential handoff", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ide-collector-handoff-"));
    path = join(dir, "pending-credential.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const payload = {
    installation_id: "11111111-1111-4111-8111-111111111111",
    installation_token: "token-value",
    user_id: "22222222-2222-4222-8222-222222222222",
    ingestion_endpoint: "http://localhost:8080",
    registration_endpoint: "http://localhost:8081",
  };

  it("writes the file readable only by the owner", async () => {
    await writeHandoff(payload, path);
    const info = await stat(path);
    // The file briefly holds a bearer token, so 0600 is the point.
    expect(info.mode & 0o077).toBe(0);
  });

  it("round-trips a valid credential", async () => {
    await writeHandoff(payload, path);
    const result = await readHandoff(path);
    expect(result.status).toBe("ok");
    expect(result.payload?.installation_token).toBe("token-value");
  });

  it("reports an expired credential rather than handing it back", async () => {
    await writeHandoff({ ...payload, expiresAt: new Date(Date.now() - 1000) }, path);
    const result = await readHandoff(path);
    expect(result.status).toBe("expired");
  });

  it("reports a missing file", async () => {
    expect((await readHandoff(path)).status).toBe("missing");
  });

  it("reports a corrupt file", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path, "{not json");
    expect((await readHandoff(path)).status).toBe("invalid");
  });

  it("rejects a payload missing required fields", async () => {
    await writeFile(path, JSON.stringify({ version: 1, installation_id: "x" }));
    expect((await readHandoff(path)).status).toBe("invalid");
  });

  it("clear removes the file and is safe to repeat", async () => {
    await writeHandoff(payload, path);
    await clearHandoff(path);
    expect((await readHandoff(path)).status).toBe("missing");
    await expect(clearHandoff(path)).resolves.toBeUndefined();
  });
});

describe("vsix resolution", () => {
  it("picks the .vsix asset from a release", () => {
    const asset = selectVsixAsset({
      tag_name: "v0.1.0",
      assets: [
        { name: "checksums.txt", browser_download_url: "https://x/checksums.txt" },
        { name: "ide-event-collector-0.1.0.vsix", browser_download_url: "https://x/e.vsix" },
      ],
    });
    expect(asset.name).toBe("ide-event-collector-0.1.0.vsix");
  });

  it("explains when a release has no .vsix attached", () => {
    expect(() =>
      selectVsixAsset({
        tag_name: "v0.1.0",
        assets: [{ name: "source.zip", browser_download_url: "https://x/s.zip" }],
      })
    ).toThrow(/no \.vsix asset/);
  });

  it("returns undefined when no local build exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ide-collector-vsix-"));
    expect(await findLocalVsix(dir)).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("finds the highest-versioned local build", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ide-collector-vsix-"));
    await writeFile(join(dir, "ide-event-collector-0.1.0.vsix"), "x");
    await writeFile(join(dir, "ide-event-collector-0.2.0.vsix"), "x");
    expect(await findLocalVsix(dir)).toContain("0.2.0");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("registerInstallation", () => {
  const endpoint = "http://control.test";

  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("returns the payload on success", async () => {
    const outcome = await registerInstallation({
      registrationEndpoint: endpoint,
      code: "abc",
      fetchImpl: async () =>
        jsonResponse(200, {
          installation_id: "i-1",
          installation_token: "t-1",
          user_id: "u-1",
        }),
    });

    expect(outcome).toEqual({
      ok: true,
      payload: { installation_id: "i-1", installation_token: "t-1", user_id: "u-1" },
    });
  });

  it("sends the enrollment code only when one was given", async () => {
    const bodies: unknown[] = [];
    const capture = async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(200, {
        installation_id: "i",
        installation_token: "t",
        user_id: "u",
      });
    };

    await registerInstallation({
      registrationEndpoint: endpoint,
      code: "code-1",
      fetchImpl: capture as unknown as typeof fetch,
    });
    await registerInstallation({
      registrationEndpoint: endpoint,
      fetchImpl: capture as unknown as typeof fetch,
    });

    expect((bodies[0] as Record<string, unknown>).enrollment_code).toBe("code-1");
    expect(bodies[1]).not.toHaveProperty("enrollment_code");
  });

  it("does not put the hostname or username on the wire", async () => {
    let sent: Record<string, unknown> = {};
    await registerInstallation({
      registrationEndpoint: endpoint,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return jsonResponse(200, {
          installation_id: "i",
          installation_token: "t",
          user_id: "u",
        });
      }) as unknown as typeof fetch,
    });

    const serialised = JSON.stringify(sent);
    expect(serialised).not.toContain(hostname());
    expect(serialised).not.toContain(userInfo().username);
    expect(sent.machine_id).toBe(machineFingerprint());
  });

  it("distinguishes a bad code from an unreachable database", async () => {
    const rejected = await registerInstallation({
      registrationEndpoint: endpoint,
      code: "stale",
      fetchImpl: async () => new Response("nope", { status: 401 }),
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.detail).toMatch(/single-use/);

    const unavailable = await registerInstallation({
      registrationEndpoint: endpoint,
      fetchImpl: async () => new Response("", { status: 503 }),
    });
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) expect(unavailable.message).toMatch(/cannot reach its database/);
  });

  it("reports an unreachable control plane rather than throwing", async () => {
    const outcome = await registerInstallation({
      registrationEndpoint: endpoint,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toContain(endpoint);
      expect(outcome.detail).toContain("curl");
    }
  });

  it("rejects a 200 that is missing the token", async () => {
    // A partial success stored as a credential would fail later, at ingestion,
    // where the cause is much harder to see.
    const outcome = await registerInstallation({
      registrationEndpoint: endpoint,
      fetchImpl: async () => jsonResponse(200, { installation_id: "i", user_id: "u" }),
    });
    expect(outcome.ok).toBe(false);
  });
});

describe("resolveVsix", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vsix-resolve-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("prefers an explicit --vsix over anything else", async () => {
    const explicit = join(dir, "given.vsix");
    await writeFile(explicit, "x");

    const resolved = await resolveVsix({ explicit, cwd: dir });
    expect(resolved.origin).toBe("explicit");
    expect(resolved.path).toBe(explicit);
  });

  it("fails on an explicit path that does not exist", async () => {
    await expect(resolveVsix({ explicit: join(dir, "absent.vsix") })).rejects.toThrow(
      /No file at/
    );
  });

  it("falls back to a local build when run from a checkout", async () => {
    const extensionDir = join(dir, "extensions", "vscode");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(join(extensionDir, "ide-event-collector-0.1.0.vsix"), "x");

    const resolved = await resolveVsix({ cwd: dir });
    expect(resolved.origin).toBe("local-build");
    expect(resolved.path).toBe(join(extensionDir, "ide-event-collector-0.1.0.vsix"));
  });
});

describe("isInteractive", () => {
  // The consent prompt is only meaningful if something can answer it. Without
  // a TTY, `setup` has to stop rather than assume yes.
  const tty = { isTTY: true } as NodeJS.ReadStream;
  const pipe = { isTTY: undefined } as unknown as NodeJS.ReadStream;

  it("is true only when both streams are terminals", () => {
    expect(isInteractive(tty, tty as unknown as NodeJS.WriteStream)).toBe(true);
    expect(isInteractive(pipe, tty as unknown as NodeJS.WriteStream)).toBe(false);
    expect(isInteractive(tty, pipe as unknown as NodeJS.WriteStream)).toBe(false);
  });
});

describe("EXTENSION_ID", () => {
  it("matches publisher.name in the extension's package.json", async () => {
    // The CLI ships without the repository, so the id has to be a constant.
    // This is what stops a rename in the extension manifest from silently
    // breaking `doctor`'s installed check and `uninstall` entirely.
    const manifest = JSON.parse(
      await readFile(
        join(__dirname, "..", "..", "extensions", "vscode", "package.json"),
        "utf8"
      )
    ) as { publisher: string; name: string };

    expect(EXTENSION_ID).toBe(`${manifest.publisher}.${manifest.name}`);
  });
});
