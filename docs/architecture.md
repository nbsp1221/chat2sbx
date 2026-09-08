# Architecture

## Goal

ChatGPT can create, discover, reuse, and destroy isolated development environments, then use the existing CodexPro tools with full freedom inside a selected environment.
No request can inherit a host shell, host sudo, the host Docker socket, or an unapproved host filesystem path.

## Trust boundaries

```text
Untrusted: ChatGPT prompts and MCP arguments
    |
    v
Public policy boundary: chat2sbx MCP server
    | fixed operations and stable ids only
    v
Host privilege boundary: narrow SbxDriver
    | validated workspace + pinned template + port mapping
    v
Primary execution boundary: Docker Sandbox microVM
    | full shell, workspace access, private Docker Engine
    v
Internal adapter: CodexPro
```

The Secure MCP Tunnel transports MCP messages to one loopback endpoint and does not decide tool policy.
The chat2sbx process owns identity, path approval, lifecycle, expiration, and routing.
The `SbxDriver` is the only component allowed to invoke `sbx`, and it accepts structured values rather than raw arguments.

## Runtime ownership

The npm package exposes one `chat2sbx` executable. `chat2sbx serve` is the only server entry point and stays in the foreground. It validates local dependencies, reconciles persisted sandbox state, opens the loopback MCP gateway, starts tunnel-client as its child, and closes both on SIGINT or SIGTERM.

The writable SQLite connection checks the application-owned `user_version` and applies all pending forward migrations in one transaction before exposing the database to application logic. Fresh and existing databases follow the same ordered migration list. Reopening an up-to-date database is a no-op, while a database created by a newer unsupported chat2sbx version fails before any application work. There is no manual migration command, down migration, or schema-dependent branch in business logic.

There is no shell-script supervisor, fixed startup timeout, daemon mode, automatic restart, or service installation. A process manager may supervise `chat2sbx serve`, but those policies remain outside the product. `chat2sbx status` reads the runtime PID and probes both the MCP gateway and tunnel readiness endpoints.

## Port exposure

`sandbox_expose` asks `SbxDriver` to publish one TCP/IPv4 sandbox port on `0.0.0.0` using an automatically assigned host port. The service inside the sandbox must listen on `0.0.0.0`; chat2sbx does not start it or check its protocol or health.

The mapping is owned by Docker Sandboxes and disappears with the sandbox. chat2sbx stores no exposure state, creates no URL, adds no authentication or expiration, and has no knowledge of Tailscale or any other route by which the user reaches the host. A repeated request for the same sandbox port returns the existing mapping. Traffic through the mapping does not renew the sandbox inactivity deadline because it is not an MCP tool call.

## Independent identities

`sandbox_id` identifies a disposable microVM and is required on every CodexPro tool call.
`workspace_id` identifies persistent files and can be attached to a replacement sandbox after the previous runtime expires.
Neither identity depends on a ChatGPT conversation or MCP session, so another conversation under the same authenticated principal can discover it with `sandbox_list` or `workspace_list`.

The current authentication provider maps every accepted MCP request to `local-owner`. Secure MCP Tunnel is the recommended transport, but transport and access control remain outside this provider.

## Workspace modes

### Managed

When no workspace is specified, chat2sbx creates `~/.chat2sbx/workspaces/<workspace_id>` with mode `0700` and mounts it read-write.
The path is owned by chat2sbx and is safe to create without an approval.

### Clone

An approved Git repository is passed to `sbx create --clone`.
The host checkout is the read-only source of a private clone inside the microVM, so sandbox edits do not immediately affect the host checkout.
The user must commit and fetch useful changes before sandbox destruction.

### Direct

An approved host directory is mounted read-write at the same absolute path.
This is intentionally a scoped host filesystem capability, not host execution authority.
It requires local registration or approval and should be used only when immediate host checkout edits are desired.

## Approval model

The MCP API can request a host path but cannot approve it.
Host access is disabled by default. `CHAT2SBX_ALLOWED_HOST_ROOTS` must explicitly configure one or more roots before chat2sbx inspects a requested host path.
The path is canonicalized with `realpath`, must be a directory strictly below an allowed root, and is rejected when it contains protected credential-directory components.
A successful request creates an `approval_required` response with a stable approval ID.
Only the local CLI can approve or reject it, after which MCP callers refer to the resulting `workspace_id` instead of resubmitting a raw path.

## Sandbox creation

1. Read `AGENTS.md` from the configured data directory when it exists so an unreadable file fails before sandbox creation.
2. Resolve an approved workspace or create a managed workspace.
3. Reuse its running sandbox if one exists. Any other unfinished sandbox, including `failed`, must be explicitly destroyed before the same workspace can be used again.
4. Atomically enforce the optional active-sandbox count limit and persist a `creating` record before invoking external commands.
5. Create a named `shell` microVM from the pinned CodexPro template with Docker Sandboxes resource defaults, an optional caller-supplied memory limit, and one dynamic loopback port.
6. Generate a random CodexPro bearer token.
7. Start CodexPro inside the microVM with full bash, workspace writes, and only the sandbox workspace as an allowed root.
8. Verify its authenticated health endpoint and persist the endpoint and token in the mode-`0600` SQLite database.
9. Return a safe summary that omits the token, endpoint, runtime name, and runtime path and includes the exact global instructions read before creation.

Failures remove a partially created runtime and persist a visible `failed` record for diagnosis. A failed creation does not reactivate a retained managed workspace or change its retention deadline. Failed records remain in `sandbox_list` until explicitly destroyed; there is no automatic retry, replacement, hiding, or history cleanup.

The same global instructions are read and returned by `sandbox_get` when an existing sandbox is opened. An absent file adds no response field; symbolic links and other non-regular entries are rejected, and any other read failure is reported. Instructions are not cached, copied into the microVM or workspace, returned by other tools, interpreted as commands, or enforced as security policy.

`maxActiveSandboxes` counts records in `creating`, `running`, or `destroying` state across this chat2sbx database. Reuse and destruction are never blocked by the count limit. The default is unlimited. A per-sandbox memory value is passed directly as `sbx create --memory`; omitting it delegates to the Docker Sandboxes default. chat2sbx does not implement cgroup discovery, memory admission, resource reservation, or automatic resizing.

## CodexPro routing

chat2sbx loads a pinned static copy of the supported CodexPro tool descriptors; it does not import, start, or inspect CodexPro on the host.
It adds a required `sandbox_id` to every schema. Ordinary tool calls retain their CodexPro contract; Bash replaces CodexPro's request-bound timeout with the explicit execution-session contract below.

For each call, chat2sbx validates ownership, expiration, and CodexPro health, removes the outer `sandbox_id`, and forwards the call through an authenticated MCP session to CodexPro inside that microVM.
Calls are serialized per sandbox to prevent concurrent conversations from racing on session selection or writes.

CodexPro assigns its own path-derived workspace ID inside the microVM. That internal ID is not part of the chat2sbx contract, so chat2sbx replaces it in tool results with the persistent public `workspace_id` associated with the sandbox.

## Bash execution sessions

CodexPro remains the only Bash executor. chat2sbx starts each command through CodexPro as a detached process group inside the selected microVM, with combined stdout/stderr written to that microVM's `/tmp` directory.

`bash` always returns a random `session_id` and waits for completion for 10 seconds by default. `yield_time_ms` can explicitly change that wait from 0 to 60 seconds. If the command exits, the call returns `status: exited`, its output, and its exit code; otherwise it returns the output so far and `status: running`. Once the detached launch has succeeded, chat2sbx keeps the session handle even if the first status/output snapshot fails. In that case `bash` conservatively returns `status: running`, empty output, and the same `session_id`; a later `bash_poll` recovers the actual state and unread output. This wait controls only when MCP yields a response and never kills the command.

There is no command lifetime limit unless `timeout_ms` is explicitly supplied. `bash_poll` waits until new output appears, the process exits, or its `yield_time_ms` expires. Its wait defaults to 10 seconds and accepts at most 60 seconds. It returns only output not returned by earlier calls and reports the current status and exit code. Polls for one session are serialized. Each response reads at most 60,000 new bytes, preserves complete UTF-8 characters across reads, and reports `has_more_output` when already-buffered output remains. Call it again while `status` is `running` or `has_more_output` is true. `bash_stop` terminates the process group with SIGTERM and escalates to SIGKILL after 1.5 seconds.

Output bytes are transferred through CodexPro as Base64 so its request-level text transformation cannot corrupt or selectively hide streamed content. chat2sbx decodes the bytes but does not redact them. Everything printed inside the sandbox is visible to the MCP client; sensitive data is controlled by the files and credentials explicitly made available at the sandbox boundary.

Session metadata lives only in the chat2sbx process and session files live only in the microVM. Sandbox deletion removes the processes and files and forgets their IDs. Controller restart does not recover sessions because existing sandboxes are already invalidated by the restart policy. There is no queue, scheduler, retry, automatic restart, or persistent job history.

## Expiration and failure

The lifecycle policy has four rules: a sandbox is removed after 24 hours without a tool call; an active sandbox has no maximum lifetime; a managed workspace is retained for 30 days after sandbox removal; and an expired managed workspace is moved into chat2sbx's recoverable trash directory.
Every tool call that reaches a running sandbox renews its idle deadline, whether the call succeeds or fails.
The trash directory is not emptied automatically. Host workspaces are never moved or deleted because chat2sbx does not own them.

At controller startup, persisted active records are reconciled with `sbx ls`.
Any microVM left by the previous controller is removed and its sandbox record becomes `failed` because the foreground CodexPro session belonged to that controller.
An unhealthy CodexPro runtime is removed immediately and its sandbox record also becomes `failed`. If runtime removal fails, the failure is recorded and explicit destruction retries it.
The user must destroy a failed sandbox before creating a replacement for the same workspace; failures in other workspaces do not block creation. chat2sbx does not restart CodexPro or recover the old runtime automatically.
Reconciliation completes before the MCP gateway begins listening and has no chat2sbx-imposed time limit.
