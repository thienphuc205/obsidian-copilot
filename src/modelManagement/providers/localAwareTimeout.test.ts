import { LOCAL_LLM_TIMEOUT_MS, resolveLocalAwareTimeout } from "./localAwareTimeout";

jest.mock("@/LLMProviders/chatModelManager", () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getActiveModel: mockGetActiveModel,
    }),
  },
}));

const mockGetActiveModel = jest.fn();

describe("resolveLocalAwareTimeout()", () => {
  beforeEach(() => {
    mockGetActiveModel.mockReset();
  });

  it("returns the long local budget for a loopback model base URL", async () => {
    mockGetActiveModel.mockReturnValue({ baseUrl: "http://localhost:1234/v1" });

    await expect(resolveLocalAwareTimeout(30_000)).resolves.toBe(LOCAL_LLM_TIMEOUT_MS);
  });

  it("returns the long local budget for a private LAN model base URL", async () => {
    mockGetActiveModel.mockReturnValue({ baseUrl: "http://192.168.1.20:11434/v1" });

    await expect(resolveLocalAwareTimeout(30_000)).resolves.toBe(LOCAL_LLM_TIMEOUT_MS);
  });

  it("keeps the configured timeout for hosted models", async () => {
    mockGetActiveModel.mockReturnValue({ baseUrl: "https://api.openai.com/v1" });

    await expect(resolveLocalAwareTimeout(30_000)).resolves.toBe(30_000);
  });

  it("keeps the configured timeout when no active model exists", async () => {
    mockGetActiveModel.mockReturnValue(null);

    await expect(resolveLocalAwareTimeout(30_000)).resolves.toBe(30_000);
  });

  it("falls back to the configured timeout when the manager is unavailable", async () => {
    mockGetActiveModel.mockImplementation(() => {
      throw new Error("manager offline");
    });

    await expect(resolveLocalAwareTimeout(30_000)).resolves.toBe(30_000);
  });

  it("treats a model without a base URL as hosted", async () => {
    mockGetActiveModel.mockReturnValue({});

    await expect(resolveLocalAwareTimeout(30_000)).resolves.toBe(30_000);
  });
});
