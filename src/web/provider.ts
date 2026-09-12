import { createFirecrawlWebProvider } from "@/web/firecrawl";
import { createTavilyWebProvider } from "@/web/tavily";
import { createExaWebProvider } from "@/web/exa";
import { createCustomWebProvider } from "@/web/custom";
import {
  WebProviderError,
  type WebProviderId,
  type WebProviderTransport,
  type WebProvider,
} from "@/web/types";

export interface CreateWebProviderOptions {
  provider: WebProviderId;
  apiKey: string;
  baseUrl?: string;
  transport?: WebProviderTransport;
}

/** Selects a provider without reading settings or issuing a request.
 * @param options The explicit provider choice, credential, and optional transport.
 */
export function createWebProvider(options: CreateWebProviderOptions): WebProvider {
  switch (options.provider) {
    case "firecrawl":
      return createFirecrawlWebProvider(options);
    case "tavily":
      return createTavilyWebProvider(options);
    case "exa":
      return createExaWebProvider(options);
    case "custom":
      return createCustomWebProvider({ ...options, baseUrl: options.baseUrl ?? "" });
    default:
      throw new WebProviderError(
        "invalid_configuration",
        null,
        "Web provider is not supported.",
        false
      );
  }
}
