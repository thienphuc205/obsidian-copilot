import { WebProviderError } from "@/web/types";
const MAX_URL_LENGTH = 2048;

/** Validates an outbound URL without resolving DNS or inspecting provider redirects.
 * @param value The explicit user or agent URL; local hosts and embedded credentials are rejected.
 */
export function validatePublicUrl(value: string): string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH || value !== value.trim()) {
    throw invalidUrlError();
  }

  const normalizedUrl = normalizePublicUrl(value);
  if (normalizedUrl === undefined) {
    throw invalidUrlError();
  }
  return normalizedUrl;
}

/** Returns a public HTTP(S) URL suitable for a citation, or undefined.
 * @param value An untrusted provider result URL.
 */
export function normalizePublicUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.length > MAX_URL_LENGTH) return undefined;

  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.hostname === "" ||
      isPrivateOrLocalHostname(url.hostname)
    ) {
      return undefined;
    }
    return url.href.length <= MAX_URL_LENGTH ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    host === "localhost" ||
    host === "local" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }

  const ipv4 = parseIpv4(host);
  if (ipv4 !== undefined) {
    const [first, second] = ipv4;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }

  // IPv6 prefixes apply only to address literals, not public DNS names such as fc.example.com.
  if (
    host === "::" ||
    host === "::1" ||
    (host.includes(":") && (host.startsWith("fc") || host.startsWith("fd")))
  ) {
    return true;
  }

  if (host.includes(":") && /^fe[89a-f]/.test(host)) return true;
  return isMappedPrivateIpv4(host);
}

function parseIpv4(host: string): [number, number, number, number] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return undefined;
  }
  const numbers = parts.map(Number);
  if (numbers.some((part) => part > 255)) return undefined;
  return numbers as [number, number, number, number];
}

function isMappedPrivateIpv4(host: string): boolean {
  if (!host.startsWith("::ffff:")) return false;
  const hexParts = host.slice("::ffff:".length).split(":");
  if (hexParts.length !== 2 || hexParts.some((part) => !/^[\da-f]{1,4}$/.test(part))) {
    return false;
  }
  const high = Number.parseInt(hexParts[0], 16);
  const low = Number.parseInt(hexParts[1], 16);
  const first = high >>> 8;
  const second = high & 255;
  const third = low >>> 8;
  const fourth = low & 255;
  return (
    parseIpv4(`${first}.${second}.${third}.${fourth}`) !== undefined &&
    isPrivateOrLocalHostname(`${first}.${second}.${third}.${fourth}`)
  );
}

function invalidUrlError(): WebProviderError {
  return new WebProviderError(
    "invalid_url",
    null,
    "Only public HTTP(S) URLs can be fetched.",
    false
  );
}
