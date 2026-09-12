# Local image preparation

Copilot can prepare images referenced by the active Markdown note for later
local use. These actions are desktop-only and are deliberately separate from
sending a message to an agent or model.

## Choose an explicit action

Use **Save active note images locally** to create local attachment records and
copies for the active note. This action does not open an Agent chat, change a
chat, or send anything to a model.

Use **Prepare active note images for this Agent chat** only when an Agent Chat
session is already active. It stages bounded, inert attachment references for
that exact session, project scope, and vault identity. Staging is volatile: it
is not chat-history persistence, it is not automatically included in the next
send, and it does not mean that the agent can see or analyze the images. A
future feature must ask for a separate user-visible permission before any
model upload or vision use.

If there is no active Agent Chat session, Copilot reports a local error and does
not create or start a backend session. If the active session, project, or
vault changes while the preview or confirmation is in progress, Copilot does
not attach the references to the new target. Existing local records and blobs
are retained; Copilot does not silently delete or garbage-collect them.

## What is shown and what is read

Before either action proceeds, Copilot shows the active note, the allowed folder
scope, the intended local storage location, and bounded candidate counts. The
default scope is the active note's parent folder. A note at the vault root uses
the vault-wide scope. The scope is not silently widened for embeds outside that
folder.

Preview parses bounded note text only. An explicit native confirmation is
required before image bytes are read or persistent attachment storage is
created. Canceling leaves the image files and attachment storage untouched.
Retrying starts a fresh preview and confirmation. Failures show bounded counts
and safe summaries rather than source paths, image bytes, or raw exceptions.

## Storage and privacy

Local attachment data is stored outside the vault under Copilot's OS-level
directory, normally `~/.obsidian-copilot/attachments/`, in a per-vault
namespace. The exact namespace is shown in the confirmation dialog when
available. Keeping data outside the vault avoids writing image copies into
notes or vault folders, but the operating system may still back up or sync this
directory. Copilot does not promise exclusion from every backup or sync tool.

Only bounded inert metadata is retained for staging or chat history. It contains
opaque attachment identifiers and the vault identity; it is not a permission to
read a file, a path capability, or a model prompt block. Authorized local reads
must recheck the live vault and folder policy.

## Limits and platform support

Input note text, referenced destinations, image sizes, and persisted references
are bounded. When a limit is reached, the preview or result reports truncation;
it does not claim that every embed was processed. Unsupported adapters and
mobile runtimes fail locally. There is no startup scan or watcher, no note
modification, no automatic next-send inclusion, and no cloud upload in these
actions.

These actions do not provide a full agent sandbox. Agent permissions and the
agent's available filesystem, shell, MCP, or model tools remain separate
controls. Native Obsidian-host validation is still required for release; unit
tests and a synthetic confirmation harness do not prove behavior in every
Obsidian window or adapter.
