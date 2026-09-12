/**
 * Composition tests for the doc-processor backend routing in `FileParserManager`.
 *
 * The routing decision lives in `resolveDocProcessorBackend` (field === "miyo",
 * Miyo in use, and available). These tests assert how the two document parsers
 * compose that decision with their (deliberately asymmetric) error shapes:
 *   - Docs4LLMParser THROWS on a Miyo parse failure so the caller marks that
 *     file failed/retriable — it is never routed elsewhere silently.
 *   - PDFParser (single-doc mode) RETURNS an error string on a Miyo parse
 *     failure — also never routed elsewhere silently.
 * An explicit "miyo" field always fails closed when Miyo can't be used — whether
 * it's unreachable or no longer in use (disconnected). There is no relay fallback
 * anywhere: a legacy non-"miyo" field value only reaches the legacy PDF cache and
 * then a local-only error.
 */

// resolveDocProcessorBackend gates on isMiyoAvailableForCapability, reads the
// snapshot, and — when it's unconclusive — triggers one refresh. All three are
// stubbed so tests drive the exact status the parser sees.
const mockSnapshot = jest.fn(() => ({ documentProcessor: "available" }));
const mockRefresh = jest.fn(async () => ({}));
// resolveDocProcessorBackend also gates on shouldUseMiyo (is Miyo actually in
// use, not just the persisted field). Default true so tests exercise the
// doc-processor routing; a dedicated test flips it to assert the stale-preference
// path fails closed.
const mockShouldUseMiyo = jest.fn(() => true);
jest.mock("@/miyo/miyoRuntimePolicy", () => ({
  shouldUseMiyo: () => mockShouldUseMiyo(),
  getMiyoCustomUrl: () => "",
}));
jest.mock("@/miyo/miyoStatusStore", () => ({
  isMiyoAvailableForCapability: jest.fn(),
  getMiyoStatusSnapshot: () => mockSnapshot(),
  refreshMiyoStatus: () => mockRefresh(),
}));

const mockResolveBaseUrl = jest.fn();
const mockParseDoc = jest.fn();
jest.mock("@/miyo/MiyoClient", () => ({
  MiyoClient: jest.fn().mockImplementation(() => ({
    resolveBaseUrl: mockResolveBaseUrl,
    parseDoc: mockParseDoc,
  })),
}));

const mockPdfCacheGet = jest.fn();
const mockPdfCacheSet = jest.fn();
jest.mock("@/cache/pdfCache", () => ({
  PDFCache: {
    getInstance: () => ({ get: mockPdfCacheGet, set: mockPdfCacheSet }),
  },
}));

jest.mock("@/utils/convertedDocOutput", () => ({
  saveConvertedDocOutput: jest.fn(),
}));

jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

const mockGetSettings = jest.fn<CopilotSettings, []>();
jest.mock("@/settings/model", () => ({
  getSettings: () => mockGetSettings(),
}));

import type { LocalPdfParser } from "@/context/documents/pdfTypes";
import { isMiyoAvailableForCapability } from "@/miyo/miyoStatusStore";
import type { CopilotSettings } from "@/settings/model";
import type { TFile, Vault } from "obsidian";
import { Docs4LLMParser, PDFParser } from "./FileParserManager";

const mockAvailable = isMiyoAvailableForCapability as jest.MockedFunction<
  typeof isMiyoAvailableForCapability
>;

const settings = (over: Partial<CopilotSettings>): CopilotSettings =>
  ({ miyoServerUrl: "", convertedDocOutputFolder: "", ...over }) as CopilotSettings;

const pdf = (name: string): TFile =>
  // eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast -- test fixture; not a real TFile
  ({ extension: "pdf", path: `docs/${name}.pdf`, basename: name }) as unknown as TFile;

const epub = (name: string): TFile =>
  // eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast -- test fixture; not a real TFile
  ({ extension: "epub", path: `books/${name}.epub`, basename: name }) as unknown as TFile;

const docx = (name: string): TFile =>
  // eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast -- test fixture; not a real TFile
  ({ extension: "docx", path: `docs/${name}.docx`, basename: name }) as unknown as TFile;

const vault = { getName: () => "MyVault", readBinary: jest.fn(async () => new ArrayBuffer(8)) };
const asVault = vault as unknown as Vault;

beforeEach(() => {
  jest.clearAllMocks();
  mockPdfCacheGet.mockResolvedValue(null);
  mockResolveBaseUrl.mockResolvedValue("http://localhost:8742");
  mockSnapshot.mockReturnValue({ documentProcessor: "available" }); // conclusive by default
  mockRefresh.mockResolvedValue({});
  mockShouldUseMiyo.mockReturnValue(true); // Miyo in use by default
});

describe("Docs4LLMParser — batch × partial failure (Miyo available)", () => {
  it("returns content for parsable PDFs and throws for the failing one", async () => {
    mockGetSettings.mockReturnValue(settings({ docProcessorBackend: "miyo" }));
    mockAvailable.mockReturnValue(true);
    // First file parses; second file fails at the Miyo endpoint.
    mockParseDoc
      .mockResolvedValueOnce({ text: "extracted one" })
      .mockRejectedValueOnce(new Error("connection reset"));

    const parser = new Docs4LLMParser();

    await expect(parser.parseFile(pdf("a"), asVault)).resolves.toBe("extracted one");
    // The failing file throws instead of being silently routed elsewhere.
    await expect(parser.parseFile(pdf("b"), asVault)).rejects.toThrow(/Miyo failed to parse b/);
  });
});

describe("Docs4LLMParser — fail closed (field miyo in use, Miyo unavailable)", () => {
  it("throws when explicitly-chosen Miyo is unreachable instead of degrading silently", async () => {
    mockGetSettings.mockReturnValue(settings({ docProcessorBackend: "miyo" }));
    mockAvailable.mockReturnValue(false); // Miyo not reachable

    const parser = new Docs4LLMParser();

    await expect(parser.parseFile(pdf("a"), asVault)).rejects.toThrow(/Miyo.*is unavailable/);
    expect(mockParseDoc).not.toHaveBeenCalled();
  });
});

describe("PDFParser — error shape preserved (Miyo available, parse fails)", () => {
  it("returns an error string rather than throwing", async () => {
    mockGetSettings.mockReturnValue(settings({ docProcessorBackend: "miyo" }));
    mockAvailable.mockReturnValue(true);
    mockParseDoc.mockRejectedValue(new Error("endpoint down"));

    const parser = new PDFParser(undefined);
    const result = await parser.parseFile(pdf("solo"), asVault);

    expect(result).toContain("[Error: Could not extract content from PDF solo");
  });
});

describe("PDFParser — fail closed (field miyo in use, Miyo unavailable)", () => {
  it("returns an error when explicitly-chosen Miyo is unreachable instead of degrading silently", async () => {
    mockGetSettings.mockReturnValue(settings({ docProcessorBackend: "miyo" }));
    mockAvailable.mockReturnValue(false);

    const parser = new PDFParser(undefined);
    const result = await parser.parseFile(pdf("solo"), asVault);

    expect(result).toContain("Miyo (local document processor) is unavailable");
    expect(mockParseDoc).not.toHaveBeenCalled();
  });
});

describe("PDFParser — injected local parser", () => {
  const localResult = {
    metadata: {
      byteLength: 3,
      outputCharacters: 10,
      pageCount: 2,
      pagesProcessed: 2,
    },
    pages: [
      { pageNumber: 1, text: "Local page one" },
      { pageNumber: 2, text: "Local page two" },
    ],
  };

  it("uses local bytes before cache and Miyo, preserving page markers", async () => {
    mockGetSettings.mockReturnValue(settings({ docProcessorBackend: "plus" as unknown as "miyo" }));
    const parse = jest.fn().mockResolvedValue(localResult);
    const factory = jest.fn<Promise<LocalPdfParser | null>, []>().mockResolvedValue({ parse });
    vault.readBinary.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);

    const parser = new PDFParser(undefined, {
      localPdfParserFactory: factory,
    });
    const result = await parser.parseFile(pdf("local"), asVault);

    expect(result).toBe("[Page 1]\nLocal page one\n\n[Page 2]\nLocal page two");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(mockPdfCacheGet).not.toHaveBeenCalled();
    expect(mockPdfCacheSet).not.toHaveBeenCalled();
    expect(mockParseDoc).not.toHaveBeenCalled();
  });

  it("memoizes the local parser factory across PDF reads", async () => {
    const parse = jest.fn().mockResolvedValue(localResult);
    const factory = jest.fn<Promise<LocalPdfParser | null>, []>().mockResolvedValue({ parse });
    const parser = new PDFParser(undefined, {
      localPdfParserFactory: factory,
    });

    await parser.parseFile(pdf("first"), asVault);
    await parser.parseFile(pdf("second"), asVault);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(mockPdfCacheGet).not.toHaveBeenCalled();
  });

  it("keeps the legacy cache route when no local package is available and the field is a legacy value", async () => {
    mockGetSettings.mockReturnValue(settings({ docProcessorBackend: "plus" as unknown as "miyo" }));
    const factory = jest.fn<Promise<LocalPdfParser | null>, []>().mockResolvedValue(null);
    mockPdfCacheGet.mockResolvedValue({ response: "cached text" });

    const parser = new PDFParser(undefined, {
      localPdfParserFactory: factory,
    });
    await expect(parser.parseFile(pdf("legacy"), asVault)).resolves.toBe("cached text");

    expect(factory).toHaveBeenCalledTimes(1);
    expect(mockPdfCacheGet).toHaveBeenCalledTimes(1);
    // A legacy backend choice is never probed — Miyo is only checked for an
    // explicit "miyo" field.
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockParseDoc).not.toHaveBeenCalled();
  });

  it("fails closed with a local-only error when the legacy cache has no entry", async () => {
    mockGetSettings.mockReturnValue(settings({ docProcessorBackend: "plus" as unknown as "miyo" }));
    const factory = jest.fn<Promise<LocalPdfParser | null>, []>().mockResolvedValue(null);

    const parser = new PDFParser(undefined, {
      localPdfParserFactory: factory,
    });
    await expect(parser.parseFile(pdf("orphan"), asVault)).resolves.toContain(
      "No local document processor is available"
    );

    expect(mockPdfCacheGet).toHaveBeenCalledTimes(1);
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockParseDoc).not.toHaveBeenCalled();
  });

  it("fails closed when local parsing errors or returns no text", async () => {
    const parse = jest
      .fn()
      .mockRejectedValueOnce(new Error("worker failed"))
      .mockResolvedValueOnce({
        ...localResult,
        pages: [],
      });
    const factory = jest.fn<Promise<LocalPdfParser | null>, []>().mockResolvedValue({ parse });
    const parser = new PDFParser(undefined, {
      localPdfParserFactory: factory,
    });

    await expect(parser.parseFile(pdf("failed"), asVault)).resolves.toContain(
      "local PDF parser failed"
    );
    await expect(parser.parseFile(pdf("empty"), asVault)).resolves.toContain(
      "scanned (no text layer)"
    );
    expect(mockParseDoc).not.toHaveBeenCalled();
    expect(mockPdfCacheGet).not.toHaveBeenCalled();
  });

  it("does not fall back when the local package factory itself fails", async () => {
    const factory = jest
      .fn<Promise<LocalPdfParser | null>, []>()
      .mockRejectedValue(new Error("local package failed"));
    const parser = new PDFParser(undefined, {
      localPdfParserFactory: factory,
    });

    await expect(parser.parseFile(pdf("factory-failed"), asVault)).resolves.toContain(
      "Could not extract content from PDF factory-failed"
    );
    expect(mockPdfCacheGet).not.toHaveBeenCalled();
  });
});

describe("parse-boundary status refresh (field miyo, status unconclusive)", () => {
  it("refreshes once when status is 'unknown', then routes to Miyo if it became available", async () => {
    mockGetSettings.mockReturnValue(settings({ docProcessorBackend: "miyo" }));
    // Status starts unconclusive (never probed). The refresh confirms available,
    // so the subsequent sync read routes to Miyo.
    mockSnapshot.mockReturnValue({ documentProcessor: "unknown" });
    mockAvailable.mockReturnValue(true);
    mockParseDoc.mockResolvedValue({ text: "extracted via miyo" });

    const parser = new PDFParser(undefined);
    const result = await parser.parseFile(pdf("solo"), asVault);

    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(result).toBe("extracted via miyo");
  });

  it("FAILS CLOSED when 'stale' probe confirms Miyo still unavailable", async () => {
    // An EXPLICIT docProcessorBackend="miyo" that can't be confirmed must NOT
    // degrade silently. The user chose local — surface an error.
    mockGetSettings.mockReturnValue(settings({ docProcessorBackend: "miyo" }));
    mockSnapshot.mockReturnValue({ documentProcessor: "stale" });
    mockAvailable.mockReturnValue(false); // refresh didn't bring Miyo back

    const parser = new PDFParser(undefined);
    const result = await parser.parseFile(pdf("solo"), asVault);

    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(result).toContain("Miyo (local document processor) is unavailable");
    expect(mockParseDoc).not.toHaveBeenCalled();
  });

  it("Docs4LLMParser THROWS when Miyo is explicitly chosen but unavailable", async () => {
    mockGetSettings.mockReturnValue(settings({ docProcessorBackend: "miyo" }));
    mockSnapshot.mockReturnValue({ documentProcessor: "unknown" });
    mockAvailable.mockReturnValue(false);

    const parser = new Docs4LLMParser();

    await expect(parser.parseFile(pdf("solo"), asVault)).rejects.toThrow(/Miyo.*is unavailable/);
  });

  it("fails closed when the field is 'miyo' but Miyo is no longer in use", async () => {
    // A stale preference left after Disconnect: docProcessorBackend still "miyo"
    // but shouldUseMiyo is false. The user explicitly chose local, so this must
    // not degrade silently — fail closed with an explicit error.
    mockGetSettings.mockReturnValue(settings({ docProcessorBackend: "miyo" }));
    mockShouldUseMiyo.mockReturnValue(false);
    mockSnapshot.mockReturnValue({ documentProcessor: "unknown" });

    const parser = new PDFParser(undefined);
    const result = await parser.parseFile(pdf("solo"), asVault);

    // No probe (Miyo isn't in use) — an explicit error instead.
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(result).toContain("Miyo (local document processor) is unavailable");
    expect(mockParseDoc).not.toHaveBeenCalled();
  });

  it("does NOT re-read health after resolving to Miyo, so a stale-horizon flip can't override the resolver", async () => {
    // Regression: parseDoc used to re-check the backend synchronously. Because
    // status degrades by wall-clock, the resolver could return "miyo" and an
    // immediately-following sync check disagree — the parser must commit to
    // Miyo (call parseDoc) regardless of any later availability flip.
    mockGetSettings.mockReturnValue(settings({ docProcessorBackend: "miyo" }));
    mockSnapshot.mockReturnValue({ documentProcessor: "available" });
    mockAvailable
      .mockReturnValueOnce(true) // resolver's check: route to Miyo
      .mockReturnValue(false); // any later check would say unavailable
    mockParseDoc.mockResolvedValue({ text: "extracted via miyo" });

    const parser = new PDFParser(undefined);
    const result = await parser.parseFile(pdf("solo"), asVault);

    expect(mockParseDoc).toHaveBeenCalledTimes(1);
    expect(result).toBe("extracted via miyo");
  });

  it("does NOT refresh when status is already conclusive (no hot-path probe)", async () => {
    mockGetSettings.mockReturnValue(settings({ docProcessorBackend: "miyo" }));
    mockSnapshot.mockReturnValue({ documentProcessor: "available" });
    mockAvailable.mockReturnValue(true);
    mockParseDoc.mockResolvedValue({ text: "extracted" });

    const parser = new PDFParser(undefined);
    await parser.parseFile(pdf("solo"), asVault);

    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("does NOT refresh when the field is a legacy non-miyo value (never probes the cache path)", async () => {
    mockGetSettings.mockReturnValue(settings({ docProcessorBackend: "plus" as unknown as "miyo" }));
    mockSnapshot.mockReturnValue({ documentProcessor: "unknown" });

    const parser = new PDFParser(undefined);
    await parser.parseFile(pdf("solo"), asVault);

    expect(mockRefresh).not.toHaveBeenCalled();
    // The legacy route is cache → local-only error; no processor is contacted.
    expect(mockPdfCacheGet).toHaveBeenCalledTimes(1);
    expect(mockParseDoc).not.toHaveBeenCalled();
  });
});

describe("Docs4LLMParser — EPUB routes locally like PDF", () => {
  it("parses an EPUB via Miyo when the field is 'miyo' and Miyo is available", async () => {
    mockGetSettings.mockReturnValue(settings({ docProcessorBackend: "miyo" }));
    mockAvailable.mockReturnValue(true);
    mockParseDoc.mockResolvedValue({ text: "epub text" });

    const parser = new Docs4LLMParser();
    const result = await parser.parseFile(epub("book"), asVault);

    expect(result).toBe("epub text");
    expect(mockParseDoc).toHaveBeenCalledWith(
      "http://localhost:8742",
      "MyVault",
      "books/book.epub"
    );
  });

  it("fails closed for an EPUB when explicitly-chosen Miyo is unavailable", async () => {
    mockGetSettings.mockReturnValue(settings({ docProcessorBackend: "miyo" }));
    mockAvailable.mockReturnValue(false);

    const parser = new Docs4LLMParser();

    await expect(parser.parseFile(epub("book"), asVault)).rejects.toThrow(/Miyo.*is unavailable/);
    expect(mockParseDoc).not.toHaveBeenCalled();
  });

  it("reports no processor for a non-{pdf,epub} format even when Miyo is available", async () => {
    mockGetSettings.mockReturnValue(settings({ docProcessorBackend: "miyo" }));
    mockAvailable.mockReturnValue(true);

    const parser = new Docs4LLMParser();

    await expect(parser.parseFile(docx("report"), asVault)).rejects.toThrow(
      /No document processor available/
    );
    expect(mockParseDoc).not.toHaveBeenCalled(); // Miyo only handles pdf/epub
  });
});

describe("Docs4LLMParser — legacy docProcessorBackend value", () => {
  it("reports no processor for a non-local format without contacting any backend", async () => {
    mockGetSettings.mockReturnValue(settings({ docProcessorBackend: "plus" as unknown as "miyo" }));

    const parser = new Docs4LLMParser();

    await expect(parser.parseFile(docx("report"), asVault)).rejects.toThrow(
      /No document processor available/
    );
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockParseDoc).not.toHaveBeenCalled();
  });

  it("fails closed for an EPUB under a legacy field value (no local processor)", async () => {
    mockGetSettings.mockReturnValue(settings({ docProcessorBackend: "plus" as unknown as "miyo" }));

    const parser = new Docs4LLMParser();

    await expect(parser.parseFile(epub("book"), asVault)).rejects.toThrow(
      /No document processor available/
    );
    expect(mockParseDoc).not.toHaveBeenCalled();
  });
});
