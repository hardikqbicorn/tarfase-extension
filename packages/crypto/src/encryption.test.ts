import { describe, expect, it } from "vitest";
import { encrypt, decrypt } from "./encryption";

describe("encrypt/decrypt", () => {
  it("round-trips plaintext", () => {
    const secret = "test-secret";
    const plaintext = JSON.stringify({ hello: "world", n: 1 });
    const ciphertext = encrypt(plaintext, secret);
    expect(ciphertext).not.toContain("world");
    expect(decrypt(ciphertext, secret)).toBe(plaintext);
  });

  it("fails to decrypt with the wrong secret", () => {
    const ciphertext = encrypt("secret data", "correct-secret");
    expect(() => decrypt(ciphertext, "wrong-secret")).toThrow();
  });
});
