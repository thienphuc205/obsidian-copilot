import { SettingItem } from "@/components/ui/setting-item";
import type { SelfHostSearchProvider } from "@/settings/model";
import { ArrowUpRight } from "lucide-react";
import React from "react";

/** A provider that owns its own credential row (everything except auto). */
type KeyedSearchProvider = Exclude<SelfHostSearchProvider, "auto">;

interface SearchProviderConfig {
  apiKeyTitle: string;
  description: string;
  label: string;
  placeholder: string;
  signupUrl: string;
}

const SEARCH_PROVIDER_CONFIGS: Record<KeyedSearchProvider, SearchProviderConfig> = {
  firecrawl: {
    apiKeyTitle: "Firecrawl API Key",
    description: "Web search & fetch via Firecrawl.",
    label: "Firecrawl",
    placeholder: "fc-…",
    signupUrl: "https://firecrawl.link/logan-yang",
  },
  perplexity: {
    apiKeyTitle: "Perplexity API Key",
    description: "Web search via Perplexity Sonar.",
    label: "Perplexity Sonar",
    placeholder: "pplx-…",
    signupUrl: "https://docs.perplexity.ai",
  },
  // Each provider owns a separate credential so switching providers cannot
  // expose one service's key to another. https://github.com/Brevilabs/obsidian-copilot-private/issues/285
  parallel: {
    apiKeyTitle: "Parallel API Key",
    description: "Web search via Parallel.",
    label: "Parallel",
    placeholder: "parallel-…",
    signupUrl: "https://platform.parallel.ai/",
  },
  exa: {
    apiKeyTitle: "Exa API Key",
    description: "Web search via Exa.",
    label: "Exa",
    placeholder: "exa-…",
    signupUrl: "https://dashboard.exa.ai/api-keys",
  },
};

/** Credential fields shown together when auto merges every configured provider. */
const KEYED_SEARCH_PROVIDERS = Object.keys(SEARCH_PROVIDER_CONFIGS) as KeyedSearchProvider[];

const AUTO_SEARCH_PROVIDER = {
  label: "Auto (merge all configured)",
  description: "Queries every provider with a configured key in parallel and merges results.",
} as const;

const SEARCH_PROVIDER_OPTIONS = [
  { label: AUTO_SEARCH_PROVIDER.label, value: "auto" },
  ...Object.entries(SEARCH_PROVIDER_CONFIGS).map(([value, config]) => ({
    label: config.label,
    value,
  })),
];

interface ProviderKeyFieldProps {
  apiKeys: Readonly<Record<KeyedSearchProvider, string>>;
  disabled: boolean;
  onApiKeyChange: (provider: KeyedSearchProvider, value: string) => void;
  provider: KeyedSearchProvider;
}

/** One provider credential row with its signup link. */
const ProviderKeyField: React.FC<ProviderKeyFieldProps> = ({
  apiKeys,
  disabled,
  onApiKeyChange,
  provider,
}) => {
  const config = SEARCH_PROVIDER_CONFIGS[provider];

  return (
    <SettingItem
      type="password"
      title={config.apiKeyTitle}
      description={
        <span>
          {config.description}{" "}
          <a
            href={config.signupUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="tw-text-accent"
          >
            Sign up <ArrowUpRight className="tw-inline tw-size-3 tw-align-text-bottom" />
          </a>
        </span>
      }
      value={apiKeys[provider]}
      onChange={(value) => onApiKeyChange(provider, value)}
      placeholder={config.placeholder}
      disabled={disabled}
    />
  );
};

export interface SelfHostWebSearchSettingsProps {
  apiKeys: Readonly<Record<KeyedSearchProvider, string>>;
  disabled: boolean;
  onApiKeyChange: (provider: KeyedSearchProvider, value: string) => void;
  onProviderChange: (provider: SelfHostSearchProvider) => void;
  provider: SelfHostSearchProvider;
}

/**
 * Presents provider selection and the selected provider's credential without
 * reading or writing plugin state.
 */
export const SelfHostWebSearchSettings: React.FC<SelfHostWebSearchSettingsProps> = ({
  apiKeys,
  disabled,
  onApiKeyChange,
  onProviderChange,
  provider,
}) => {
  return (
    <>
      <SettingItem
        type="select"
        title="Web Search Provider"
        description="Your key turns this into an agent skill parameter."
        value={provider}
        onChange={(value) => onProviderChange(value as SelfHostSearchProvider)}
        options={SEARCH_PROVIDER_OPTIONS}
        disabled={disabled}
      />

      {provider === "auto" ? (
        <>
          <div className="tw-px-1 tw-text-xs tw-text-muted">{AUTO_SEARCH_PROVIDER.description}</div>
          {KEYED_SEARCH_PROVIDERS.map((keyedProvider) => (
            <ProviderKeyField
              key={keyedProvider}
              apiKeys={apiKeys}
              disabled={disabled}
              onApiKeyChange={onApiKeyChange}
              provider={keyedProvider}
            />
          ))}
        </>
      ) : (
        <ProviderKeyField
          apiKeys={apiKeys}
          disabled={disabled}
          onApiKeyChange={onApiKeyChange}
          provider={provider}
        />
      )}
    </>
  );
};
