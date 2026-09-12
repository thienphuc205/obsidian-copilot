import {
  executeRetiredProviderRemoval,
  planRetiredProviderRemoval,
} from "./retiredProviderRemovalMigration";
import type { ModelManagementApi } from "@/modelManagement";
import { type CopilotSettings } from "@/settings/model";

/** Legacy `CustomModel.provider` / model-key value naming the relay provider. */
const LEGACY_PROVIDERS = ["copilot-plus"] as const;

/**
 * One-time migration (settings v15): erase the removed Copilot Plus relay chat
 * provider from a vault that used it.
 *
 * The relay (Brevilabs hosted models, license entitlement, entitlement-gated
 * self-host) no longer exists in this fork, so a saved `copilot-plus` provider
 * row and its configured models can never resolve again. The relay credential
 * (`plusLicenseKey`) was keychain-hydrated by the generic secret heuristic, so
 * once the settings field is gone the normal persistence path no longer sees
 * it and the stored entry must be deleted explicitly.
 *
 * The shared retired-provider planner removes the provider rows, their
 * configured models, enrollments, and any selection naming them.
 */

/** Pure chat-model plan shared with the other retired-provider migrations. */
export function planCopilotPlusRemoval(settings: CopilotSettings) {
  return planRetiredProviderRemoval(settings, "copilot-plus", LEGACY_PROVIDERS);
}

/** Apply the plan and delete the stored license key from the keychain. */
export async function executeCopilotPlusRemoval(
  api: ModelManagementApi,
  settings: CopilotSettings
): Promise<void> {
  const plan = planCopilotPlusRemoval(settings);
  await executeRetiredProviderRemoval(api, plan, "plusLicenseKey", "copilot-plus-removal");
}
