# Architecture

## Goal

ChatGPT can create, discover, reuse, and destroy isolated development environments, then use the existing CodexPro tools with full freedom inside a selected environment.
No request can inherit a host shell, host sudo, the host Docker socket, or an arbitrary host filesystem path. Workspaces are owned and managed by chat2sbx.

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

A transport such as OpenAI Secure MCP Tunnel can carry MCP messages to the loopback endpoint, but transport authentication and lifecycle are external to chat2sbx.
The chat2sbx process owns identity, managed workspace lifecycle, sandbox lifecycle, expiration, and routing only after a request reaches its MCP endpoint.
The `SbxDriver` is the only component allowed to invoke `sbx`, and it accepts structured values rather than raw arguments.

## Runtime ownership

The npm package exposes one `chat2sbx` executable. `chat2sbx serve` is the only server entry point and stays in the foreground. It validates local dependencies, reconciles persisted sandbox state, opens the loopback MCP gateway, and closes it on SIGINT or SIGTERM. Long-running deployments should use an external operating-system process manager; chat2sbx does not daemonize itself or supervise any external tunnel process.

The writable SQLite connection checks the application-owned `user_version` and applies all pending forward migrations in one transaction before exposing the database to application logic. Fresh and existing databases follow the same ordered migration list. Reopening an up-to-date database is a no-op, while a database created by a newer unsupported chat2sbx version fails before any application work. There is no manual migration command, down migration, or schema-dependent branch in business logic.

There is no shell-script supervisor, fixed startup timeout, daemon mode, automatic restart, or service installation. A process manager may supervise `chat2sbx serve`, but those policies remain outside the product. `chat2sbx status` reads the runtime PID and probes the local MCP gateway. `chat2sbx sandbox list` and `chat2sbx sandbox destroy <id>` are thin operator clients for the same local MCP lifecycle tools; they do not access SQLite or invoke `sbx` directly and do not depend on the external tunnel.

## Port exposure

`sandbox_expose` asks `SbxDriver` to publish one TCP/IPv4 mapping from a sandbox port to a host bind address and host port. The caller provides `sandbox_port`; `host` defaults to `127.0.0.1`, and `host_port` is allocated automatically when omitted. Callers can instead provide an explicit host IPv4 address, including `0.0.0.0`, and an explicit host port. The service inside the sandbox must listen on `0.0.0.0`; chat2sbx does not start it or check its protocol or health.

The mapping is owned by Docker Sandboxes and disappears with the sandbox. chat2sbx stores no exposure state, creates no URL, adds no authentication or expiration, and has no knowledge of Tailscale or any other route by which the user reaches the host. Repeating the same mapping request returns the existing mapping; a different host or host port can create another mapping for the same sandbox port. Traffic through a mapping does not renew the sandbox inactivity deadline because it is not an MCP tool call.

## Independent identities

`sandbox_id` identifies a disposable microVM and is required on every CodexPro tool call.
`workspace_id` identifies persistent files and can be attached to a replacement sandbox after the previous runtime expires.
Neither identity depends on a ChatGPT conversation or MCP session, so another conversation under the same authenticated principal can discover it with `sandbox_list` or `workspace_list`.

The current authentication provider maps every accepted MCP request to `local-owner`. Secure MCP Tunnel is the recommended transport, but transport and access control remain outside this provider.

## Managed workspaces

chat2sbx exposes one workspace model. When `sandbox_create` omits `workspace_id`, chat2sbx creates `~/.chat2sbx/workspaces/<workspace_id>` with mode `0700` and mounts it read-write. Supplying an existing `workspace_id` reuses that persistent managed workspace with a replacement or existing sandbox.

MCP callers cannot request arbitrary host paths. Repository workflows happen inside the managed workspace, for example by running `git clone` and authenticating Git from inside the sandbox. The database retains legacy workspace capability columns and approval tables for non-destructive compatibility and possible future policy work, but the current runtime creates, lists, and selects only managed workspaces.

## Sandbox creation

1. Read `AGENTS.md` from the configured data directory when it exists so an unreadable file fails before sandbox creation.
2. Resolve an existing managed workspace or create a new managed workspace.
3. Reuse its running sandbox if one exists. Any other unfinished sandbox, including `failed`, must be explicitly destroyed before the same workspace can be used again.
4. Atomically enforce the optional active-sandbox count limit and persist a `creating` record before invoking external commands.
5. Create a named `shell` microVM from the pinned CodexPro template with Docker Sandboxes resource defaults, an optional caller-supplied memory limit, and one dynamic loopback port.
6. Generate a random CodexPro bearer token.
7. Start CodexPro as a background process inside the microVM with full bash, workspace writes, and only the sandbox workspace as an allowed root. The host `sbx exec` returns after launching it; health checks confirm readiness. CodexPro stdout/stderr go to `/tmp/chat2sbx-codexpro.log` inside the microVM, not the host server console. The process shares the microVM lifetime; stopping the controller does not delete the microVM, and the existing startup reconciliation retires it on the next start.
8. Verify its authenticated health endpoint and persist the endpoint and token in the mode-`0600` SQLite database.
9. Return a safe summary that omits the token, endpoint, runtime name, and runtime path and includes the exact global instructions read before creation.

Failures remove a partially created runtime and persist a visible `failed` record for diagnosis. A failed creation does not reactivate a retained managed workspace or change its retention deadline. Failed records remain in `sandbox_list` until explicitly destroyed; there is no automatic retry, replacement, hiding, or history cleanup.

After the `creating` record is stored, creation and every other lifecycle operation for that sandbox are serialized. A destroy request received during creation waits for creation or its failure cleanup to finish, then leaves the sandbox `destroyed`.

The same global instructions are read and returned by `sandbox_get` when an existing sandbox is opened. An absent file adds no response field; symbolic links and other non-regular entries are rejected, and any other read failure is reported. Instructions are not cached, copied into the microVM or workspace, returned by other tools, interpreted as commands, or enforced as security policy.

`maxActiveSandboxes` counts records in `creating`, `running`, or `destroying` state, plus failed sandboxes whose runtime cleanup is still pending, across this chat2sbx database. Reuse and destruction are never blocked by the count limit. The default is unlimited. A per-sandbox memory value is passed directly as `sbx create --memory`; omitting it delegates to the Docker Sandboxes default. chat2sbx does not implement cgroup discovery, memory admission, resource reservation, or automatic resizing.

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

The lifecycle policy has four rules: a sandbox is removed after 24 hours without a tool call; an active sandbox has no maximum lifetime; a managed workspace is retained for 30 days after sandbox removal; and an expired managed workspace is moved into chat2sbx's archive directory and retained indefinitely.
Every tool call that reaches a running sandbox renews its idle deadline, whether the call succeeds or fails.
An expired workspace is not archived while it has a sandbox in `creating`, `running`, `destroying`, or `failed` state. Archived workspaces are not automatically deleted and are not currently selectable for a new sandbox.

At controller startup, persisted active records are reconciled with `sbx ls`.
A microVM left by a previous controller is not resumed because its foreground CodexPro session belonged to that controller. If runtime cleanup succeeds, the sandbox is recorded as `destroyed`, its managed workspace is retained, and that workspace can be used immediately for a replacement sandbox.
If runtime cleanup fails during reconciliation, that sandbox is recorded as `failed` with the cleanup error while reconciliation continues for other sandboxes. An unhealthy CodexPro runtime also becomes `failed`; explicit destruction retries cleanup.
The user must destroy a failed sandbox before creating a replacement for the same workspace; failures in other workspaces do not block creation. chat2sbx does not restart CodexPro or recover the old runtime automatically.
Reconciliation completes before the MCP gateway begins listening and has no chat2sbx-imposed time limit.
