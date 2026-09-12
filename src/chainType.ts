export enum ChainType {
  LLM_CHAIN = "llm_chain",
  // TODO(copilot-plus-removal): the Copilot Plus chain is being deleted, but
  // files outside this wave's ownership (ContextManager.ts, utils.ts,
  // contextProcessor.embeds.test.ts, settings/model.test.ts) still reference
  // this member — remove it once those callers are cleaned up.
}
