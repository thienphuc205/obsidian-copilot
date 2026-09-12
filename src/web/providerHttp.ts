import { requestUrl, type RequestUrlResponse } from "obsidian";
import {
  WebProviderError,
  type WebProviderTransport,
  type WebProviderTransportRequest,
  type WebProviderTransportResponse,
} from "@/web/types";
const MAX_PROVIDER_BODY_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT = new Error(`Web provider request deadline elapsed`);
const REQUEST_ABORTED = new Error(`Web provider request cancelled`);
const RAW_RESPONSE_INVALID = new Error(`Web provider response shape invalid`);
const RAW_RESPONSE_TOO_LARGE = new Error(`Web provider response body too large`);

/**
 * Applies a bounded deadline and sanitized failures to an explicit provider request.
 * @param providerName Trusted display label used in errors.
 * @param transport Host HTTP adapter, which may outlive the deadline when it cannot cancel.
 * @param apiKey Credential sent only as the Authorization header.
 * @param url Provider-owned API endpoint, never a fetched page URL.
 * @param body Operation payload containing only its explicit arguments.
 * @param signal Optional caller cancellation.
 */
export async function requestWebProvider(
  providerName: string,
  transport: WebProviderTransport,
  apiKey: string,
  url: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<WebProviderTransportResponse> {
  if (signal?.aborted) throw cancelledRequestError(providerName);

  const request: WebProviderTransportRequest = {
    url,
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    contentType: "application/json",
    body: JSON.stringify(body),
    timeoutMs: REQUEST_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  };

  let requestPromise: Promise<WebProviderTransportResponse>;
  try {
    requestPromise = Promise.resolve(transport(request));
  } catch {
    throw networkError(providerName);
  }

  let timeoutId: number | undefined;
  let abortListener: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(REQUEST_TIMEOUT), REQUEST_TIMEOUT_MS);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = (): void => reject(REQUEST_ABORTED);
    if (signal?.aborted) {
      abortListener();
      return;
    }
    signal?.addEventListener("abort", abortListener, { once: true });
  });

  try {
    // requestUrl has no AbortSignal support. The deadline releases this caller
    // while an accepted underlying request may continue; no retry is safe here.
    const response = await Promise.race([requestPromise, timeoutPromise, abortPromise]);
    validateRawResponseSize(response);
    return response;
  } catch (error) {
    if (error === REQUEST_TIMEOUT) {
      throw new WebProviderError(
        "timeout",
        null,
        `${providerName} did not respond before the request deadline.`,
        true
      );
    }
    if (error === REQUEST_ABORTED) {
      throw cancelledRequestError(providerName);
    }
    if (error === RAW_RESPONSE_INVALID || error === RAW_RESPONSE_TOO_LARGE) {
      throw malformedResponseError(providerName);
    }
    throw networkError(providerName);
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
    if (signal !== undefined && abortListener !== undefined) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

/** Reads raw response bounds before asking Obsidian to parse JSON.
 * @param request Explicit fixed-endpoint POST request.
 */
export async function defaultWebTransport(
  request: WebProviderTransportRequest
): Promise<WebProviderTransportResponse> {
  let response: RequestUrlResponse;
  try {
    response = await requestUrl({
      url: request.url,
      method: request.method,
      headers: request.headers,
      contentType: request.contentType,
      body: request.body,
      throw: false,
    });
  } catch {
    throw networkError("Web provider");
  }

  if (!isRecord(response) || typeof response.status !== "number") {
    throw RAW_RESPONSE_INVALID;
  }

  const rawResponse: WebProviderTransportResponse = {
    status: response.status,
    json: undefined,
    text: response.text,
    arrayBuffer: response.arrayBuffer,
  };
  validateRawResponseSize(rawResponse);
  return { ...rawResponse, json: response.json };
}

/** Maps HTTP failures without retaining the provider response body.
 * @param response The bounded transport response.
 * @param providerName Trusted display label used in errors.
 */
export function ensureSuccessfulResponse(
  response: WebProviderTransportResponse,
  providerName: string
): void {
  if (!isRecord(response) || typeof response.status !== "number") {
    throw malformedResponseError(providerName);
  }
  if (!Number.isInteger(response.status) || response.status < 100) {
    throw malformedResponseError(providerName);
  }

  if (response.status < 200 || response.status >= 300) {
    throw errorForStatus(response.status, providerName);
  }
}

function errorForStatus(status: number, providerName: string): WebProviderError {
  if (status === 401 || status === 403) {
    return new WebProviderError(
      "unauthorized",
      status,
      `${providerName} rejected the API key.`,
      false
    );
  }
  if (status === 429) {
    return new WebProviderError(
      "rate_limited",
      status,
      `${providerName} rate limit reached. Try again later.`,
      true
    );
  }
  if (status === 402) {
    return new WebProviderError(
      "quota_exceeded",
      status,
      `${providerName} account quota is unavailable for this request.`,
      false
    );
  }
  if (status === 408 || status === 504) {
    return new WebProviderError(
      "timeout",
      status,
      `${providerName} did not complete the request before its deadline.`,
      true
    );
  }
  if (status >= 500) {
    return new WebProviderError(
      "server",
      status,
      `${providerName} is temporarily unavailable.`,
      true
    );
  }
  return new WebProviderError(
    "bad_request",
    status,
    `${providerName} rejected the request.`,
    false
  );
}

function malformedResponseError(providerName: string): WebProviderError {
  return new WebProviderError(
    "malformed_response",
    null,
    `${providerName} returned an invalid response.`,
    false
  );
}

function networkError(providerName: string): WebProviderError {
  return new WebProviderError("network", null, `Could not reach ${providerName}.`, true);
}

function cancelledRequestError(providerName: string): WebProviderError {
  return new WebProviderError("timeout", null, `The ${providerName} request was cancelled.`, true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRawResponseSize(response: WebProviderTransportResponse): void {
  if (!isRecord(response) || typeof response.status !== "number") {
    throw RAW_RESPONSE_INVALID;
  }
  const rawByteLengths: number[] = [];
  if (typeof response.text === "string") {
    rawByteLengths.push(utf8ByteLengthUpTo(response.text, MAX_PROVIDER_BODY_BYTES));
  }
  const arrayBufferByteLength = getArrayBufferByteLength(response.arrayBuffer);
  if (arrayBufferByteLength !== undefined) rawByteLengths.push(arrayBufferByteLength);
  if (rawByteLengths.some((length) => length > MAX_PROVIDER_BODY_BYTES)) {
    throw RAW_RESPONSE_TOO_LARGE;
  }
}

function getArrayBufferByteLength(value: unknown): number | undefined {
  if (!isRecord(value) || typeof value.byteLength !== "number") return undefined;
  return Number.isInteger(value.byteLength) && value.byteLength >= 0 ? value.byteLength : undefined;
}

/** Stops counting once a string exceeds a byte budget.
 * @param value Raw text to measure, without allocating another encoded copy.
 * @param maxBytes Budget after which the exact byte length is no longer needed.
 */
export function utf8ByteLengthUpTo(value: string, maxBytes: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length && bytes <= maxBytes; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
