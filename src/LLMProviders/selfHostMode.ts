import { useSettingsValue } from "@/settings/model";
import { getSettings } from "@/settings/model";

/**
 * Self-Host Mode is a plain user preference in this fork. Upstream gated it on
 * a paid `self_host` entitlement from the Copilot Plus license server; the
 * relay-free fork has no such gate, so the toggle alone decides.
 */
export function isSelfHostModeEnabled(): boolean {
  return getSettings().enableSelfHostMode === true;
}

/**
 * Whether the Self-Host Mode tab may be toggled: always true in this fork.
 * Upstream derived eligibility from a paid `self_host` entitlement claim; the
 * relay-free fork has no such gate. Kept as a hook-shaped seam so settings
 * components keep their existing call pattern.
 */
export function useIsSelfHostEligible(): boolean {
  return useSettingsValue().enableSelfHostMode === true;
}
