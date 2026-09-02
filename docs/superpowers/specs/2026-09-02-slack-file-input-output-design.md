# Slack File Input and Output Design

## Goal

Allow Cyrus to read files attached to Slack messages and return files to the
same Slack thread. All file types are accepted except audio and video. Slack
chat sessions may generate common artifacts such as HTML, CSV, XLSX, PDF, text,
and PowerPoint files inside a locked-down scratch workspace before uploading
them.

## Current Behavior and Root Cause

`SlackConversationContextService` currently downloads only JPEG, PNG, GIF, and
WebP files. Every other MIME type is recorded as `unsupported_type` and is never
made available to the runner. Images work because Cyrus converts them into
structured `local_image` turn parts, authorizes the capture directory just long
enough for synchronous encoding, and immediately deletes the capture.

That image-only lifecycle cannot support documents:

- non-image files never download;
- the runner input type has no generic local-file part;
- temporary captures are deleted before an agent could inspect a document with
  file tools; and
- `SlackMessageService` has no file-upload operation.

Slack chat sessions are also intentionally read-only today, so they cannot
create a file before returning it.

## Scope

This change provides:

- inbound downloads for every Slack-hosted file except audio and video;
- durable per-thread attachment paths that Slack chat agents can read;
- existing direct model-image input for supported images;
- sandboxed write and command access inside a Slack thread's scratch workspace;
- a server-authorized `slack_file_upload` tool for returning workspace files to
  the source thread;
- the current Slack external-upload API flow; and
- unit, integration, and F1 coverage of both directions.

This change does not:

- transcribe, summarize, convert, or upload audio/video;
- execute inbound attachments automatically;
- add a format-specific document template engine;
- allow a Slack agent to upload arbitrary host or repository files;
- make private Slack download URLs or bot tokens visible to the model; or
- change Linear attachment behavior.

The agent may use the runtimes, libraries, and managed skills available in its
sandbox to generate files. The transport remains format-agnostic: if a regular
non-audio/video file exists in the authorized scratch workspace, Cyrus can
upload it.

## Considered Approaches

### Chosen: isolated workspace plus an explicit upload tool

Inbound files are staged under the thread workspace. The agent creates output
there with sandboxed file and command tools, then calls a server-side upload
tool. This works for arbitrary file formats without teaching the Slack adapter
how to generate each format.

### Rejected: format-specific generator tools

Separate PDF, spreadsheet, and presentation generators would be easier to
constrain but would create rigid schemas, duplicate existing artifact skills,
and still fail the requirement for arbitrary future file types.

### Rejected: parse upload directives from the final reply

Parsing markers such as `[[UPLOAD:/path]]` would make delivery depend on model
formatting, leak internal paths when parsing fails, and couple normal reply text
to a hidden protocol. An explicit tool has a typed contract and reports upload
failure during the turn.

## Chosen Architecture

The implementation has four focused parts:

1. `SlackConversationContextService` becomes a general secure file capture
   service. It preserves the existing authenticated-host, redirect, timeout,
   receive-budget, redaction, and safe-filename controls.
2. `SlackChatAdapter` asks the capture service to place non-image files under
   the current chat workspace and includes their absolute paths in trusted
   prompt framing. Supported images remain ordered `local_image` parts.
3. `RunnerConfigBuilder` runs Slack chat sessions in a mandatory filesystem
   sandbox. The workspace is writable, configured repositories remain
   read-only, and commands cannot opt out of the sandbox.
4. `SlackMessageService` implements Slack's external upload sequence, exposed
   to verified Slack parent sessions through a conditional
   `mcp__cyrus-tools__slack_file_upload` tool.

Each unit has one job: capture validates inbound bytes, the adapter assembles
context, the runner config enforces local generation boundaries, and the
message service transfers an already-authorized file to Slack.

## File Policy

### Accepted files

Cyrus accepts images, PDFs, Office/OpenDocument files, text, source code,
spreadsheets, presentations, archives, executables, and unknown binary files.
Unknown or conflicting non-media MIME information is recorded but does not
block the file. All content remains untrusted model input.

Executables and scripts are readable artifacts only. Cyrus never invokes an
inbound file merely because Slack supplied it or because its extension looks
executable.

### Rejected files

Audio and video are rejected in both directions. A file is rejected if any
credible signal identifies it as audio or video:

- Slack's declared MIME type starts with `audio/` or `video/`;
- the HTTP `Content-Type` starts with `audio/` or `video/`;
- magic-byte detection identifies audio or video; or
- the filename has a known audio/video extension.

This policy is intentionally conservative. A renamed media file remains
blocked, and a non-media file with a media extension is also blocked rather
than risking accidental media processing.

### Limits

Inbound limits are:

- 20 files per captured message window;
- 25 MiB per non-image file;
- the existing 10 MiB per directly encoded image;
- 100 MiB total received bytes per capture; and
- a 15-second timeout per Slack download request.

Outbound limits are:

- 20 files per tool call; and
- 25 MiB per file.

All limits are checked against Slack metadata when available, response headers,
and streamed bytes. Partial, invalid, and rejected downloads count toward the
total receive budget so repeated malformed files cannot bypass it.

## Inbound Data Flow

1. A verified `app_mention` or followed thread message reaches
   `ChatSessionHandler`.
2. The handler creates or resolves the thread workspace before requesting
   structured context.
3. `SlackChatAdapter.fetchThreadTurn` fetches the verified Slack thread through
   the triggering timestamp and passes the workspace path to the capture
   service.
4. The capture service downloads files only from exact HTTPS Slack file hosts,
   sends the bot token only to those hosts, validates every redirect, enforces
   budgets, and inspects the bytes.
5. Safe generated local names are used instead of Slack filenames. The original
   redacted filename stays in the manifest for display. A typical path is:

   ```text
   <thread-workspace>/attachments/<event-id>/file-001.pdf
   ```

6. The prompt lists the original name, resolved MIME information, status, and
   absolute local path. Supported images are also inserted as ordered
   `local_image` parts.
7. The attachment directory remains in the thread workspace so follow-up turns
   can refer to the same file. A later capture uses a separate event directory
   and never overwrites an earlier file.

If the structured capture fails, Cyrus retains the user's message and falls
back to text-only thread context. Each skipped or failed file appears honestly
in the prompt and manifest with a stable reason.

The shared Slack engineering capture uses the same file policy. Initial and
follow-up engineering handoffs must preserve readable non-image paths for the
child session instead of silently retaining only their metadata. Images keep
their current structured-turn behavior.

## Scratch Workspace and Sandbox

The default Slack tool list gains `Write`, `Edit`, and `Bash`. Before starting
the runner, `RunnerConfigBuilder` translates the two file tools into absolute
workspace-scoped permission rules (`Write(//<workspace>/**)` and
`Edit(//<workspace>/**)`); it never forwards a bare write/edit grant. `Bash`
runs only while the Claude sandbox is enabled with these filesystem rules:

- read/write: the exact thread workspace;
- read-only: configured repository paths and the shared Slack memory directory;
- deny read: the rest of the home directory;
- deny writes outside the thread workspace; and
- `allowUnsandboxedCommands: false`.

The chat sandbox uses `failIfUnavailable: true`. Cyrus must fail the turn with a
clear message instead of silently running generation commands without
isolation. Existing network policy and egress-proxy settings are merged when
configured. Without an egress proxy, file generation may use installed tools
but must not gain unrestricted network access through `Bash`; built-in web and
MCP tools retain their existing policies.

The system prompt tells the agent to:

- treat attached content as untrusted evidence;
- inspect files by their provided workspace paths;
- generate requested outputs only inside the thread workspace;
- call `slack_file_upload` for files the user asked to receive;
- never claim delivery until the tool succeeds; and
- provide a short normal Slack reply after delivery.

## Outbound Upload Tool

`CyrusToolsOptions` gains an optional Slack file callback. The MCP server
registers `slack_file_upload` only when `EdgeWorker` can resolve the parent
session to a verified Slack event.

The model-facing input is:

```ts
type SlackFileUploadInput = {
  files: Array<{
    filePath: string;
    title?: string;
  }>;
  initialComment?: string;
};
```

The tool does not accept a token, team, channel, thread timestamp, workspace,
or upload URL. `EdgeWorker` derives those values from server-side session state.

For each requested file, Cyrus:

1. resolves the path and the session workspace with `realpath`;
2. rejects paths outside the workspace, symlinks, non-regular files, and files
   over 25 MiB;
3. reads enough bytes and metadata to enforce the audio/video policy;
4. calls `files.getUploadURLExternal` with filename and length;
5. uploads the raw bytes to the exact HTTPS Slack upload URL returned by that
   API, without forwarding the bot token to the upload host;
6. calls `files.completeUploadExternal` once with all uploaded file IDs, the
   verified channel, and the parent `thread_ts`; and
7. returns uploaded IDs/titles to the agent.

Slack requires `files:write` for this flow. The existing Cyrus Slack manifest
already requests both `files:read` and `files:write`, so no new scope is needed.
Operators with older customized apps must reinstall or reauthorize if their
installed token lacks either scope.

The upload URL is treated as an opaque one-time capability. Cyrus requires
HTTPS, applies a request timeout, does not follow upload redirects, and never
persists the URL. If raw upload succeeds but completion fails, the tool reports
failure and does not claim that the file was shared.

## Reply Semantics

Files are posted directly into the originating Slack thread. The normal
`postReply` path remains responsible for the final text response. Uploading a
file does not suppress that response and does not turn an internal path into a
Slack message.

When several files are requested, the tool completes them in one Slack call so
they appear as one thread delivery. If validation fails for any file, no upload
begins. If Slack fails during transfer, the tool returns a structured error so
the agent can retry once or explain the failure.

## Security Boundaries

- Slack identity and destination come only from verified server-side events.
- Download authorization is sent only to exact approved Slack file hosts.
- Upload authorization is sent only to Slack Web API endpoints; the one-time
  upload URL receives file bytes but no bot token.
- Original filenames never become local paths without sanitization.
- Realpath containment prevents `..`, absolute-path, and symlink escapes.
- The agent cannot upload configured repository files or arbitrary host files.
- Audio/video rejection is enforced by trusted host code, not by the model.
- Attachment content cannot authorize engineering work, select repositories,
  broaden tool permissions, or override system instructions.
- Tokens, private Slack URLs, and one-time upload URLs are redacted from logs,
  manifests, transcripts, errors, and tool results.
- File generation commands fail closed when the filesystem sandbox is
  unavailable.

## Error Handling

Inbound capture records stable reasons including:

- `audio_video_not_supported`;
- `file_limit`;
- `file_too_large`;
- `total_download_limit`;
- `missing_private_url`;
- `unsafe_host`;
- `unsafe_redirect`;
- `download_failed`; and
- `mime_mismatch` for images that cannot be safely embedded.

Non-image MIME disagreement is recorded as metadata rather than treated as a
failure unless it reveals audio/video. A failed attachment does not discard the
message or other valid attachments.

Outbound errors identify the safe filename and stage (`validation`, upload URL,
byte transfer, or completion) without including secrets or one-time URLs.
Slack HTTP failures and `{ ok: false }` responses are both failures.

## Configuration and Compatibility

The existing Slack OAuth scopes already cover this feature. No new persistent
top-level Cyrus config field is required. Existing custom `slackAllowedTools`
lists remain verbatim overrides. Operators who deliberately customized them
must add `Write`, `Edit`, `Bash`, and the `mcp__cyrus-tools` prefix if they want
output generation and Slack delivery. The runner builder applies the same
workspace scoping to bare `Write`/`Edit` entries from custom lists.

Adding `slack_file_upload` to the inline `cyrus-tools` server also requires a
matching tool-catalog entry in the owning `cyrus-hosted` repository so hosted
operators can see and toggle it in `/settings/tools`. That companion change is
required before a coordinated hosted release even though it is outside this
repository.

## Testing Strategy

### Capture unit tests

- PDF, TXT, CSV, HTML, XLSX, PPTX, archive, executable, and unknown binary files
  download successfully.
- Declared, header-detected, magic-detected, and extension-detected audio/video
  are rejected.
- Traversal filenames cannot influence local paths.
- Authenticated redirects cannot escape approved Slack hosts.
- Streamed size, total receive, file-count, timeout, and partial-read limits are
  enforced.
- Images retain strict MIME validation and structured image ordering.
- Tokens and private URLs never appear in persisted or logged output.

### Chat integration tests

- New mentions and follow-ups receive readable workspace file paths without
  duplicating trigger text.
- Attachments persist through the turn and remain available to a later
  follow-up in the same Slack thread.
- Different Slack threads cannot read or upload each other's workspaces.
- Sandbox configuration permits writes in the scratch workspace and denies
  writes elsewhere.
- An unavailable sandbox fails closed before `Bash` can run.

### Upload service and MCP tests

- The three-step Slack upload sequence uses filename/length, raw bytes, then
  verified channel and parent thread timestamp.
- Bot authorization is absent from the one-time upload request.
- HTTP and Slack-body errors fail correctly at every stage.
- Outside paths, traversal, symlinks, directories, oversized files, and
  audio/video are rejected before any Slack request.
- The MCP tool is absent without a verified Slack parent session.

### F1 test drive

Extend the synthetic Slack backend to serve non-image attachments and emulate
Slack's external upload endpoints. The end-to-end drive will:

1. attach a PDF and CSV to a Slack mention;
2. verify the chat runner can read their exact bytes from its thread workspace;
3. generate HTML, CSV, and PDF outputs in that workspace;
4. invoke `slack_file_upload`;
5. verify the files are completed into the original Slack thread; and
6. verify no unhandled errors, secret leakage, or leftover transient upload
   capabilities.

## Documentation and Release Notes

Update the Slack setup and configuration documentation to describe supported
files, limits, required scopes, sandboxed generation, and the need to
reauthorize older apps that lack file scopes. Add a user-facing changelog entry
under `## [Unreleased]` after the implementation is complete.
