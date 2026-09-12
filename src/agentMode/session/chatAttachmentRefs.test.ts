import {
  CHAT_ATTACHMENT_REF_SCHEMA_VERSION,
  MAX_CHAT_ATTACHMENT_REFS,
  MAX_CHAT_ATTACHMENT_REFS_SERIALIZED_BYTES,
  escapeLocalAttachmentMarkerLiteral,
  normalizeLocalAttachmentRefs,
  parseLocalAttachmentMarkerLiteral,
  parseLocalAttachmentRefMarker,
  serializeLocalAttachmentRefs,
} from "./chatAttachmentRefs";

const ref = (vaultId: string, attachmentId: string) => ({
  schemaVersion: CHAT_ATTACHMENT_REF_SCHEMA_VERSION,
  vaultId,
  attachmentId,
});

describe("chat attachment reference envelope", () => {
  it("normalizes valid refs, removes duplicates, preserves order, and freezes the result", () => {
    const normalized = normalizeLocalAttachmentRefs([
      ref("vault-b", "att-2"),
      ref("vault-a", "att-1"),
      ref("vault-b", "att-2"),
    ]);

    expect(normalized).toEqual([ref("vault-b", "att-2"), ref("vault-a", "att-1")]);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized[0])).toBe(true);
  });

  it("rejects malformed, unknown-version, spoofed, and oversized envelopes as a whole", () => {
    const malformed = [
      null,
      { schemaVersion: 1, vaultId: "vault-a", attachmentId: "att-1" },
      [ref("vault-a", "../outside")],
      [ref("../foreign", "att-1")],
      [{ ...ref("vault-a", "att-1"), sourcePath: "../../outside.png" }],
      [{ ...ref("vault-a", "att-1"), schemaVersion: 2 }],
      Array.from({ length: MAX_CHAT_ATTACHMENT_REFS + 1 }, (_, index) =>
        ref("vault-a", `att-${index}`)
      ),
    ];

    for (const candidate of malformed) {
      expect(normalizeLocalAttachmentRefs(candidate)).toEqual([]);
    }

    const oversized = Array.from({ length: MAX_CHAT_ATTACHMENT_REFS }, (_, index) =>
      ref("é".repeat(256), `att-${index}`)
    );
    expect(JSON.stringify(oversized).length).toBeGreaterThan(0);
    expect(normalizeLocalAttachmentRefs(oversized)).toEqual([]);
    expect(MAX_CHAT_ATTACHMENT_REFS_SERIALIZED_BYTES).toBeLessThan(
      new TextEncoder().encode(JSON.stringify(oversized)).byteLength
    );
  });

  it("serializes only the fixed metadata envelope and round-trips it through the marker parser", () => {
    const marker = serializeLocalAttachmentRefs([ref("vault-a", "att-1")]);

    expect(marker).toContain("copilot-local-attachment-refs:v1;metadata");
    expect(marker).toContain('"vaultId":"vault-a"');
    expect(marker).not.toContain("data:");
    expect(marker).not.toContain("sourcePath");
    expect(parseLocalAttachmentRefMarker(marker)).toEqual([ref("vault-a", "att-1")]);
    expect(serializeLocalAttachmentRefs([])).toBeNull();
    expect(serializeLocalAttachmentRefs({ refs: [ref("vault-a", "att-1")] })).toBeNull();

    const literal = escapeLocalAttachmentMarkerLiteral(marker!);
    expect(literal).not.toBe(marker);
    expect(parseLocalAttachmentMarkerLiteral(literal)).toBe(marker);
    expect(escapeLocalAttachmentMarkerLiteral("ordinary text")).toBe("ordinary text");
    expect(parseLocalAttachmentMarkerLiteral("ordinary text")).toBeNull();
  });

  it("leaves ordinary marker-like text and malformed marker payloads inert", () => {
    expect(
      parseLocalAttachmentRefMarker("A note mentioning <!-- copilot-local-attachment-refs:v1 -->")
    ).toBe(null);
    expect(
      parseLocalAttachmentRefMarker("<!-- copilot-local-attachment-refs:v1;metadata {not-json} -->")
    ).toBeNull();
    expect(
      parseLocalAttachmentRefMarker(
        '<!-- copilot-local-attachment-refs:v1;metadata [{"schemaVersion":2,"vaultId":"vault-a","attachmentId":"att-1"}] -->'
      )
    ).toBeNull();
    expect(
      parseLocalAttachmentRefMarker(
        '<!-- copilot-local-attachment-refs:v1;metadata [{"schemaVersion":1,"vaultId":"vault-a","attachmentId":"att-1","path":"/tmp/secret"}] -->'
      )
    ).toBeNull();
    expect(parseLocalAttachmentRefMarker(42)).toBeNull();
  });
});
