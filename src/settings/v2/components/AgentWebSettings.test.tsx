import { DEFAULT_SETTINGS } from "@/constants";
import type { WebProvider } from "@/web/types";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { AgentWebSettings, type AgentWebProviderFactory } from "./AgentWebSettings";
import * as agentWebStories from "./AgentWebSettings.stories";

const mockUpdateSetting = jest.fn<void, unknown[]>();
let mockSettings = { ...DEFAULT_SETTINGS };

jest.mock("@/settings/model", () => {
  const actual = jest.requireActual<typeof import("@/settings/model")>("@/settings/model");
  return {
    ...actual,
    updateSetting: (...args: unknown[]) => mockUpdateSetting(...args),
    // eslint-disable-next-line @eslint-react/hooks-extra/no-unnecessary-use-prefix -- mocks the real hook; name must match the export
    useSettingsValue: () => mockSettings,
  };
});

const mockTestConnection = jest.fn<Promise<void>, []>();
const mockProviderFactory = jest.fn<
  ReturnType<AgentWebProviderFactory>,
  Parameters<AgentWebProviderFactory>
>();

function makeProvider(): WebProvider {
  return {
    search: jest.fn(),
    fetch: jest.fn(),
    testConnection: mockTestConnection,
  };
}

function renderSettings(overrides: React.ComponentProps<typeof AgentWebSettings> = {}) {
  return render(
    <AgentWebSettings
      onEnabledChange={(enabled) => mockUpdateSetting("enableAgentWebTools", enabled)}
      onProviderChange={(provider) => mockUpdateSetting("agentWebSearchProvider", provider)}
      onApiKeyChange={(apiKey) => mockUpdateSetting("firecrawlAgentWebApiKey", apiKey)}
      providerFactory={mockProviderFactory}
      {...overrides}
    />
  );
}

function renderStrictSettings(overrides: React.ComponentProps<typeof AgentWebSettings> = {}) {
  return render(
    <React.StrictMode>
      <AgentWebSettings
        onEnabledChange={(enabled) => mockUpdateSetting("enableAgentWebTools", enabled)}
        onProviderChange={(provider) => mockUpdateSetting("agentWebSearchProvider", provider)}
        onApiKeyChange={(apiKey) => mockUpdateSetting("firecrawlAgentWebApiKey", apiKey)}
        providerFactory={mockProviderFactory}
        {...overrides}
      />
    </React.StrictMode>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("AgentWebSettings", () => {
  // The section renders two switches in DOM order: web tools, then the
  // auto-describe opt-in. Index 0 keeps the web-tools switch.
  const webToolsSwitch = () => screen.getAllByRole("switch")[0];
  const autoIndexSwitch = () => screen.getAllByRole("switch")[1];

  beforeEach(() => {
    jest.clearAllMocks();
    mockSettings = { ...DEFAULT_SETTINGS };
    mockTestConnection.mockResolvedValue(undefined);
    mockProviderFactory.mockReturnValue(makeProvider());
  });

  describe("AgentWebSettings()", () => {
    it("defaults to disabled Firecrawl settings and does not probe on render", () => {
      renderSettings();

      expect(screen.getByText("Codex Agent web tools")).toBeTruthy();
      expect(
        screen.getByText("Allows Codex Agent sessions to use web search and fetch.")
      ).toBeTruthy();
      expect(
        screen.getByText(
          /Changing enablement, provider, or API key restarts the Codex Agent backend/
        )
      ).toBeTruthy();
      expect(screen.queryByText(/future\s+Agent\s+integration/i)).toBeNull();
      expect(webToolsSwitch().getAttribute("aria-checked")).toBe("false");
      expect(autoIndexSwitch().getAttribute("aria-checked")).toBe("false");
      expect(screen.getByRole<HTMLSelectElement>("combobox").value).toBe("firecrawl");
      expect(screen.getByPlaceholderText("fc-…").getAttribute("type")).toBe("password");
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Test Connection" }).disabled
      ).toBe(true);
      expect(mockProviderFactory).not.toHaveBeenCalled();
      expect(mockTestConnection).not.toHaveBeenCalled();
    });

    it("offers all four independent providers in the dropdown", () => {
      renderSettings({ enabled: true, apiKey: "fc-test" });

      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
        "Firecrawl",
        "Tavily",
        "Exa",
        "Custom API",
      ]);
    });

    it("keeps the provider, key input, and Test Connection disabled until the opt-in is enabled", () => {
      renderSettings({ enabled: false, apiKey: "fc-test" });

      expect(screen.getByRole<HTMLSelectElement>("combobox").disabled).toBe(true);
      expect(screen.getByPlaceholderText<HTMLInputElement>("fc-…").disabled).toBe(true);
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Test Connection" }).disabled
      ).toBe(true);
    });

    it("allows removing the Firecrawl key while web tools are disabled", () => {
      renderSettings({ enabled: false, apiKey: "fc-test" });

      const removeButton = screen.getByRole("button", { name: "Remove Firecrawl API key" });
      expect(removeButton.textContent).toBe("Remove key");
      fireEvent.click(removeButton);

      expect(mockUpdateSetting).toHaveBeenCalledWith("firecrawlAgentWebApiKey", "");
      expect(mockUpdateSetting).not.toHaveBeenCalledWith("enableAgentWebTools", true);
      expect(screen.queryByRole("button", { name: "Remove Firecrawl API key" })).toBeNull();
    });

    it("keeps Test Connection disabled when enabled without a key", () => {
      renderSettings({ enabled: true });

      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Test Connection" }).disabled
      ).toBe(true);
      expect(mockProviderFactory).not.toHaveBeenCalled();
    });

    it("persists the opt-in and key changes through the existing settings writer", () => {
      renderSettings({ enabled: false });

      fireEvent.click(webToolsSwitch());
      fireEvent.change(screen.getByPlaceholderText("fc-…"), {
        target: { value: "fc-new-key" },
      });

      expect(mockUpdateSetting).toHaveBeenCalledWith("enableAgentWebTools", true);
      expect(mockUpdateSetting).toHaveBeenCalledWith("firecrawlAgentWebApiKey", "fc-new-key");
    });

    it("renders the auto-describe toggle off by default and persists its change", () => {
      renderSettings({ enabled: false });

      expect(screen.getByText("Auto-describe new images")).toBeTruthy();
      expect(
        screen.getByText(
          /newly added note images are described with your configured model for search/
        )
      ).toBeTruthy();
      expect(autoIndexSwitch().getAttribute("aria-checked")).toBe("false");

      fireEvent.click(autoIndexSwitch());

      expect(mockUpdateSetting).toHaveBeenCalledWith("enableImageAutoIndex", true);
      expect(mockUpdateSetting).not.toHaveBeenCalledWith("enableAgentWebTools", true);
    });

    it("keeps the auto-describe override prop authoritative when provided", () => {
      renderSettings({ autoIndexEnabled: true });

      expect(autoIndexSwitch().getAttribute("aria-checked")).toBe("true");
    });

    it("invokes the provider only after an explicit click when enabled with a key", async () => {
      renderSettings({ enabled: true, apiKey: "fc-test-key" });

      fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));

      await waitFor(() => expect(mockTestConnection).toHaveBeenCalledTimes(1));
      expect(mockProviderFactory).toHaveBeenCalledWith({
        provider: "firecrawl",
        apiKey: "fc-test-key",
      });
      expect(screen.getByRole("status").textContent).toContain("Connection successful.");
    });

    it("completes a successful connection after StrictMode effect replay", async () => {
      renderStrictSettings({ enabled: true, apiKey: "fc-test-key" });

      fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));

      await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
      expect(screen.getByRole("status").textContent).toContain("Connection successful.");
    });

    it("completes a sanitized error after StrictMode effect replay", async () => {
      mockTestConnection.mockRejectedValue(new Error("provider details and fc-test-key"));
      renderStrictSettings({ enabled: true, apiKey: "fc-test-key" });

      fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));

      const error = await screen.findByRole("alert");
      expect(error.textContent).toBe(
        "Connection failed. Check your Firecrawl API key and try again."
      );
    });

    it("ignores a second click while a connection test is in flight", async () => {
      const pending = deferred<void>();
      mockTestConnection.mockReturnValue(pending.promise);
      renderSettings({ enabled: true, apiKey: "fc-test-key" });

      const button = screen.getByRole("button", { name: "Test Connection" });
      fireEvent.click(button);
      fireEvent.click(button);

      expect(mockProviderFactory).toHaveBeenCalledTimes(1);
      expect(mockTestConnection).toHaveBeenCalledTimes(1);

      await act(async () => {
        pending.resolve(undefined);
        await pending.promise;
      });
    });

    it("does not show a stale success after the key changes during a test", async () => {
      const pending = deferred<void>();
      mockTestConnection.mockReturnValue(pending.promise);
      renderSettings({ enabled: true, apiKey: "fc-old-key" });

      fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
      fireEvent.change(screen.getByPlaceholderText("fc-…"), {
        target: { value: "fc-new-key" },
      });

      await act(async () => {
        pending.resolve(undefined);
        await pending.promise;
      });

      expect(screen.queryByText("Connection successful.")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("does not show a stale success after the opt-in setting changes during a test", async () => {
      const pending = deferred<void>();
      mockTestConnection.mockReturnValue(pending.promise);
      renderSettings({ enabled: true, apiKey: "fc-test-key" });

      fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
      fireEvent.click(webToolsSwitch());

      await act(async () => {
        pending.resolve(undefined);
        await pending.promise;
      });

      expect(screen.queryByText("Connection successful.")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("shows a sanitized error without exposing provider details or the key", async () => {
      mockTestConnection.mockRejectedValue(
        new Error("request failed for fc-test-key at https://api.firecrawl.dev")
      );
      renderSettings({ enabled: true, apiKey: "fc-test-key" });

      fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));

      const error = await screen.findByRole("alert");
      expect(error.textContent).toContain(
        "Connection failed. Check your Firecrawl API key and try again."
      );
      expect(error.textContent).not.toContain("fc-test-key");
      expect(error.textContent).not.toContain("https://api.firecrawl.dev");
    });

    it("keeps provider credentials separate and tests only the selected Tavily key", async () => {
      mockSettings = {
        ...DEFAULT_SETTINGS,
        enableAgentWebTools: true,
        firecrawlAgentWebApiKey: "fc-saved-key",
        tavilyAgentWebApiKey: "tvly-saved-key",
      };
      const view = render(<AgentWebSettings providerFactory={mockProviderFactory} />);
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "tavily" } });
      expect(mockUpdateSetting).toHaveBeenCalledWith("agentWebSearchProvider", "tavily");
      mockSettings = { ...mockSettings, agentWebSearchProvider: "tavily" };
      view.rerender(<AgentWebSettings providerFactory={mockProviderFactory} />);
      expect(screen.getByPlaceholderText<HTMLInputElement>("tvly-…").value).toBe("tvly-saved-key");
      fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
      await waitFor(() => expect(mockTestConnection).toHaveBeenCalledTimes(1));
      expect(mockProviderFactory).toHaveBeenCalledWith({
        provider: "tavily",
        apiKey: "tvly-saved-key",
      });
      fireEvent.click(screen.getByRole("button", { name: "Remove Tavily API key" }));
      expect(mockUpdateSetting).toHaveBeenCalledWith("tavilyAgentWebApiKey", "");
      expect(mockUpdateSetting).not.toHaveBeenCalledWith("firecrawlAgentWebApiKey", "");
    });

    it("discards an in-flight Firecrawl result when the provider changes", async () => {
      const pending = deferred<void>();
      mockTestConnection.mockReturnValue(pending.promise);
      const view = renderSettings({ enabled: true, apiKey: "fc-old-key" });
      fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
      view.rerender(
        <AgentWebSettings
          enabled
          provider="tavily"
          apiKey="tvly-new-key"
          providerFactory={mockProviderFactory}
        />
      );
      await act(async () => {
        pending.resolve();
        await pending.promise;
      });
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByPlaceholderText<HTMLInputElement>("tvly-…").value).toBe("tvly-new-key");
    });

    it("requires a Custom URL and tests only that endpoint with its own key", async () => {
      const view = renderSettings({
        enabled: true,
        provider: "custom",
        apiKey: "custom-fixture",
        baseUrl: "",
      });
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Test Connection" }).disabled
      ).toBe(true);
      view.rerender(
        <AgentWebSettings
          enabled
          provider="custom"
          apiKey="custom-fixture"
          baseUrl="https://search.example.com/v1"
          providerFactory={mockProviderFactory}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
      await waitFor(() => expect(mockTestConnection).toHaveBeenCalledTimes(1));
      expect(mockProviderFactory).toHaveBeenCalledWith({
        provider: "custom",
        apiKey: "custom-fixture",
        baseUrl: "https://search.example.com/v1",
      });
    });

    it("drops a connection result when the Custom endpoint changes", async () => {
      const pending = deferred<void>();
      mockTestConnection.mockReturnValue(pending.promise);
      const view = renderSettings({
        enabled: true,
        provider: "custom",
        apiKey: "custom-fixture",
        baseUrl: "https://first.example.com",
      });
      fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
      view.rerender(
        <AgentWebSettings
          enabled
          provider="custom"
          apiKey="custom-fixture"
          baseUrl="https://second.example.com"
          providerFactory={mockProviderFactory}
        />
      );
      await act(async () => {
        pending.resolve();
        await pending.promise;
      });
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("renders every standalone gallery story state", () => {
      const stories = [
        ["Disabled", agentWebStories.Disabled],
        ["DisabledWithKey", agentWebStories.DisabledWithKey],
        ["EnabledWithoutKey", agentWebStories.EnabledWithoutKey],
        ["EnabledWithKey", agentWebStories.EnabledWithKey],
        ["Checking", agentWebStories.Checking],
        ["ConnectionSuccess", agentWebStories.ConnectionSuccess],
        ["ConnectionError", agentWebStories.ConnectionError],
        ["TavilyWithKey", agentWebStories.TavilyWithKey],
        ["TavilyConnectionError", agentWebStories.TavilyConnectionError],
        ["ExaWithKey", agentWebStories.ExaWithKey],
        ["CustomWithoutUrl", agentWebStories.CustomWithoutUrl],
        ["CustomWithKey", agentWebStories.CustomWithKey],
      ] as const;

      for (const [name, story] of stories) {
        const view = render(<AgentWebSettings {...agentWebStories.default.args} {...story.args} />);

        expect(view.getByText("Codex Agent web tools")).toBeTruthy();
        expect(
          view.getByText("Allows Codex Agent sessions to use web search and fetch.")
        ).toBeTruthy();
        expect(
          view.getByText(
            /Changing enablement, provider, or API key restarts the Codex Agent backend/
          )
        ).toBeTruthy();
        expect(
          view.getByText(/Queries and URLs are sent to (Firecrawl|Tavily|Exa|Custom API)/)
        ).toBeTruthy();
        if (name === "ConnectionSuccess") {
          expect(view.getByRole("status")).toBeTruthy();
        }
        if (name === "ConnectionError" || name === "TavilyConnectionError") {
          expect(view.getByRole("alert")).toBeTruthy();
        }

        view.unmount();
      }
    });
  });
});
