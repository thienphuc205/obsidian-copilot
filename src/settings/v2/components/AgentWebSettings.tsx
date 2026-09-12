import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { SettingItem } from "@/components/ui/setting-item";
import { SettingSection } from "@/components/ui/setting-section";
import { updateSetting, useSettingsValue, type AgentWebSearchProvider } from "@/settings/model";
import { createWebProvider } from "@/web/provider";
import { Loader2 } from "lucide-react";
import React from "react";

const WEB_PROVIDER_OPTIONS = [
  { label: "Firecrawl", value: "firecrawl" },
  { label: "Tavily", value: "tavily" },
  { label: "Exa", value: "exa" },
  { label: "Custom API", value: "custom" },
];
const PROVIDER_FIELDS = {
  firecrawl: { key: "firecrawlAgentWebApiKey", label: "Firecrawl", placeholder: "fc-…" },
  tavily: { key: "tavilyAgentWebApiKey", label: "Tavily", placeholder: "tvly-…" },
  exa: { key: "exaAgentWebApiKey", label: "Exa", placeholder: "Exa API key" },
  custom: { key: "customAgentWebApiKey", label: "Custom API", placeholder: "API key" },
} as const;

export type AgentWebConnectionStatus = "idle" | "checking" | "success" | "error";

export type AgentWebProviderFactory = typeof createWebProvider;

export interface AgentWebSettingsProps {
  /** Optional settings override for stories and isolated component tests. */
  enabled?: boolean;
  /** Optional provider override for stories and isolated component tests. */
  provider?: AgentWebSearchProvider;
  /** Optional key override for stories and isolated component tests. */
  apiKey?: string;
  /** Optional auto-describe opt-in override for stories and isolated tests. */
  autoIndexEnabled?: boolean;
  /** Custom endpoint override for isolated previews. */
  baseUrl?: string;
  onBaseUrlChange?: (baseUrl: string) => void;
  /** Called when the opt-in switch changes. */
  onEnabledChange?: (enabled: boolean) => void;
  /** Called when the auto-describe opt-in switch changes. */
  onAutoIndexChange?: (enabled: boolean) => void;
  /** Called when the provider selection changes. */
  onProviderChange?: (provider: AgentWebSearchProvider) => void;
  /** Called when the key input changes. */
  onApiKeyChange?: (apiKey: string) => void;
  /** Injectable factory used by tests and gallery previews. */
  providerFactory?: AgentWebProviderFactory;
  /** Initial visual state for gallery stories. */
  initialConnectionStatus?: AgentWebConnectionStatus;
}

/**
 * Codex Agent web-tool settings.
 *
 * This component owns only the opt-in UI and the explicit connection probe.
 * It does not run a probe on mount, register agent tools, or enforce a vault
 * scope. The provider factory is supplied by the Codex Agent integration.
 */
export const AgentWebSettings: React.FC<AgentWebSettingsProps> = ({
  enabled: enabledOverride,
  provider: providerOverride,
  apiKey: apiKeyOverride,
  autoIndexEnabled: autoIndexEnabledOverride,
  baseUrl: baseUrlOverride,
  onBaseUrlChange,
  onEnabledChange,
  onAutoIndexChange,
  onProviderChange,
  onApiKeyChange,
  providerFactory,
  initialConnectionStatus = "idle",
}) => {
  const settings = useSettingsValue();
  const enabled = enabledOverride ?? settings.enableAgentWebTools;
  const autoIndexEnabled = autoIndexEnabledOverride ?? settings.enableImageAutoIndex;
  const provider = providerOverride ?? settings.agentWebSearchProvider;
  const providerFields = PROVIDER_FIELDS[provider] ?? PROVIDER_FIELDS.firecrawl;
  const keyField = providerFields.key;
  const providerLabel = providerFields.label;
  const baseUrl = baseUrlOverride ?? settings.customAgentWebBaseUrl;
  const storedApiKey = apiKeyOverride ?? settings[keyField];
  const [apiKeyDraft, setApiKeyDraft] = React.useState(storedApiKey);
  const [connectionStatus, setConnectionStatus] =
    React.useState<AgentWebConnectionStatus>(initialConnectionStatus);
  const [isTesting, setIsTesting] = React.useState(initialConnectionStatus === "checking");
  const mountedRef = React.useRef(true);
  const testGenerationRef = React.useRef(0);
  const testingRef = React.useRef(false);
  const didCommitInitialSettingsRef = React.useRef(false);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      testGenerationRef.current += 1;
    };
  }, []);

  React.useEffect(() => {
    if (!didCommitInitialSettingsRef.current) {
      didCommitInitialSettingsRef.current = true;
      return;
    }
    // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect -- mirror externally changed settings into the local input draft
    setApiKeyDraft(storedApiKey);
    testGenerationRef.current += 1;
    // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect -- invalidate a result started under the previous settings
    setConnectionStatus("idle");
  }, [enabled, provider, storedApiKey, baseUrl]);

  const invalidateTest = React.useCallback(() => {
    testGenerationRef.current += 1;
    setConnectionStatus("idle");
  }, []);

  const handleEnabledChange = React.useCallback(
    (nextEnabled: boolean) => {
      invalidateTest();
      (onEnabledChange ?? ((value: boolean) => updateSetting("enableAgentWebTools", value)))(
        nextEnabled
      );
    },
    [invalidateTest, onEnabledChange]
  );

  const handleAutoIndexChange = React.useCallback(
    (nextEnabled: boolean) => {
      (onAutoIndexChange ?? ((value: boolean) => updateSetting("enableImageAutoIndex", value)))(
        nextEnabled
      );
    },
    [onAutoIndexChange]
  );

  const handleProviderChange = React.useCallback(
    (nextProvider: AgentWebSearchProvider) => {
      if (!WEB_PROVIDER_OPTIONS.some((option) => option.value === nextProvider)) return;
      invalidateTest();
      (
        onProviderChange ??
        ((value: AgentWebSearchProvider) => updateSetting("agentWebSearchProvider", value))
      )(nextProvider);
    },
    [invalidateTest, onProviderChange]
  );

  const handleApiKeyChange = React.useCallback(
    (nextApiKey: string) => {
      setApiKeyDraft(nextApiKey);
      invalidateTest();
      (onApiKeyChange ?? ((value: string) => updateSetting(keyField, value)))(nextApiKey);
    },
    [invalidateTest, onApiKeyChange, keyField]
  );

  const handleTestConnection = React.useCallback(async () => {
    const apiKey = apiKeyDraft.trim();
    if (
      !enabled ||
      !WEB_PROVIDER_OPTIONS.some((option) => option.value === provider) ||
      (provider === "custom" && !baseUrl.trim()) ||
      apiKey.length === 0 ||
      testingRef.current
    ) {
      return;
    }

    testingRef.current = true;
    const generation = testGenerationRef.current;
    setIsTesting(true);
    setConnectionStatus("checking");

    try {
      const webProvider = (providerFactory ?? createWebProvider)({
        provider,
        apiKey,
        ...(provider === "custom" ? { baseUrl } : {}),
      });
      await webProvider.testConnection();
      if (mountedRef.current && testGenerationRef.current === generation) {
        setConnectionStatus("success");
      }
    } catch {
      if (mountedRef.current && testGenerationRef.current === generation) {
        setConnectionStatus("error");
      }
    } finally {
      testingRef.current = false;
      if (mountedRef.current) {
        setIsTesting(false);
      }
    }
  }, [apiKeyDraft, enabled, provider, providerFactory, baseUrl]);

  const canTest =
    enabled &&
    WEB_PROVIDER_OPTIONS.some((option) => option.value === provider) &&
    (provider !== "custom" || baseUrl.trim().length > 0) &&
    apiKeyDraft.trim().length > 0 &&
    !isTesting;

  return (
    <SettingSection
      label="Codex Agent web tools"
      description="Optional web search and fetch for Codex Agent sessions, using your own provider key."
    >
      <SettingItem
        type="switch"
        title="Enable Codex Agent web tools"
        description="Allows Codex Agent sessions to use web search and fetch."
        checked={enabled}
        onCheckedChange={handleEnabledChange}
      />
      <SettingItem
        type="select"
        title="Web search provider"
        description="Choose the service that receives web queries and URLs."
        value={provider}
        onChange={(value) => handleProviderChange(value as AgentWebSearchProvider)}
        options={WEB_PROVIDER_OPTIONS}
        disabled={!enabled}
      />
      {provider === "custom" && (
        <SettingItem
          type="text"
          title="Custom API base URL"
          description="Public HTTPS endpoint implementing the Copilot web API format, with /search and /fetch routes."
          placeholder="https://search.example.com/api"
          value={baseUrl}
          disabled={!enabled}
          onChange={(value) => {
            invalidateTest();
            (onBaseUrlChange ?? ((url: string) => updateSetting("customAgentWebBaseUrl", url)))(
              value
            );
          }}
        />
      )}
      <SettingItem
        type="custom"
        title={`${providerLabel} API key`}
        description="Stored with the existing Obsidian keychain handling."
      >
        <div className="tw-flex tw-w-full tw-flex-col tw-items-stretch tw-gap-2 sm:tw-flex-row sm:tw-items-center sm:tw-justify-end">
          <PasswordInput
            value={apiKeyDraft}
            onChange={handleApiKeyChange}
            placeholder={providerFields.placeholder}
            disabled={!enabled}
            className="tw-w-full sm:tw-w-[200px]"
          />
          {apiKeyDraft.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove ${providerLabel} API key`}
              onClick={() => handleApiKeyChange("")}
              className="tw-self-start sm:tw-self-auto"
            >
              Remove key
            </Button>
          )}
        </div>
      </SettingItem>
      <SettingItem
        type="custom"
        title="Test Connection"
        description={`This sends a connection request to ${providerLabel} and may consume credits.`}
      >
        <div className="tw-flex tw-w-full tw-flex-col tw-items-start tw-gap-2 sm:tw-items-end">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void handleTestConnection()}
            disabled={!canTest}
          >
            {isTesting ? <Loader2 className="tw-size-4 tw-animate-spin" /> : "Test Connection"}
          </Button>
          {connectionStatus === "success" && (
            <span role="status" className="tw-text-xs tw-text-success">
              Connection successful.
            </span>
          )}
          {connectionStatus === "error" && (
            <span role="alert" className="tw-text-xs tw-text-error">
              {provider === "custom"
                ? "Connection failed. Check your Custom API URL, key, and response format."
                : `Connection failed. Check your ${providerLabel} API key and try again.`}
            </span>
          )}
        </div>
      </SettingItem>
      <SettingItem
        type="switch"
        title="Auto-describe new images"
        description="When enabled, newly added note images are described with your configured model for search. Uses your model's normal quota."
        checked={autoIndexEnabled}
        onCheckedChange={handleAutoIndexChange}
      />
      <div className="tw-space-y-2 tw-border-t tw-border-border tw-px-4 tw-py-3 tw-text-xs tw-text-muted">
        <p className="tw-m-0">
          Changing enablement, provider, or API key restarts the Codex Agent backend when it is
          running and can interrupt an active turn.
          {provider === "custom" && " Changing the Custom API URL also restarts Codex."}
        </p>
        <p className="tw-m-0">
          Queries and URLs are sent to {providerLabel} and may consume {providerLabel} credits.
          Agent-generated queries can contain vault data; this setting does not guarantee that they
          are vault-free.
        </p>
      </div>
    </SettingSection>
  );
};
