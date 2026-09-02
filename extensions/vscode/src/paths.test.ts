import { describe, expect, it } from "vitest";
import { basename, isSensitiveFile, stableId, toWorkspaceRelative } from "./paths";

describe("toWorkspaceRelative", () => {
  it("strips the workspace root", () => {
    expect(toWorkspaceRelative("/workspace/proj/src/a.ts", "/workspace/proj")).toBe("src/a.ts");
  });

  it("handles a trailing slash on the root", () => {
    expect(toWorkspaceRelative("/workspace/proj/src/a.ts", "/workspace/proj/")).toBe("src/a.ts");
  });

  it("returns only the file name for a path outside the workspace", () => {
    const result = toWorkspaceRelative("/Users/alice/secrets/notes.md", "/workspace/proj");
    expect(result).toBe("notes.md");
    expect(result).not.toContain("alice");
  });

  it("returns only the file name when there is no workspace", () => {
    expect(toWorkspaceRelative("/Users/alice/a.ts", undefined)).toBe("a.ts");
  });

  it("handles Windows separators", () => {
    expect(basename("C:\\Users\\alice\\project\\a.ts")).toBe("a.ts");
  });
});

describe("isSensitiveFile", () => {
  it.each([
    ".env",
    "/workspace/proj/.env.local",
    "/home/u/.ssh/id_rsa",
    "/workspace/cert.pem",
    "/workspace/proj/secrets.yaml",
    "/home/u/.aws/credentials",
    "/workspace/.npmrc",
  ])("flags %s as sensitive", (path) => {
    expect(isSensitiveFile(path)).toBe(true);
  });

  it.each(["/workspace/proj/src/index.ts", "/workspace/proj/README.md", "environment.ts"])(
    "does not flag %s",
    (path) => {
      expect(isSensitiveFile(path)).toBe(false);
    }
  );
});

describe("stableId", () => {
  it("is deterministic and non-reversible", () => {
    const id = stableId("/workspace/my-project");
    expect(id).toBe(stableId("/workspace/my-project"));
    expect(id).not.toContain("workspace");
    expect(id).toHaveLength(32);
  });

  it("differs for different inputs", () => {
    expect(stableId("/a")).not.toBe(stableId("/b"));
  });
});
