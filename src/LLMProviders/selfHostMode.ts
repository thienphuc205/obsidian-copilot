import { getSettings } from "@/settings/model";

/**
 * Self-Host Mode is a plain user preference in this fork. Upstream gated it on
 * a paid `self_host` entitlement from the Copilot Plus license server; the
 * relay-free fork has no such gate, so the toggle alone decides.
 */
export function isSelfHostModeEnabled(): boolean {
  return getSettings().enableSelfHostMode === true;
}
