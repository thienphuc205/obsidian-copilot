export {
  CHAT_ATTACHMENT_REF_SCHEMA_VERSION,
  MAX_CHAT_ATTACHMENT_ID_LENGTH,
  MAX_CHAT_ATTACHMENT_REFS,
  MAX_CHAT_ATTACHMENT_REFS_SERIALIZED_BYTES,
  MAX_CHAT_ATTACHMENT_VAULT_ID_LENGTH,
  escapeLocalAttachmentMarkerLiteral,
  normalizeLocalAttachmentRefs,
  parseLocalAttachmentMarkerLiteral,
  parseLocalAttachmentRefMarker,
  serializeLocalAttachmentRefs,
} from "../attachmentRefs";
export type { LocalAttachmentRef } from "../attachmentRefs";
