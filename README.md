<h1 align="center">chat2sbx</h1>

<p align="center"><strong>Give ChatGPT a computer you can safely throw away.</strong></p>

<p align="center">
  <a href="https://github.com/nbsp1221/chat2sbx/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/nbsp1221/chat2sbx/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://www.npmjs.com/package/chat2sbx"><img alt="npm" src="https://img.shields.io/npm/v/chat2sbx?style=flat-square&logo=npm"></a>
  <a href="https://nodejs.org/"><img alt="Node.js >=24" src="https://img.shields.io/badge/Node.js-%3E%3D24-339933?style=flat-square&logo=nodedotjs&logoColor=white"></a>
  <a href="https://docs.docker.com/ai/sandboxes/"><img alt="Docker Sandboxes" src="https://img.shields.io/badge/isolation-Docker%20Sandboxes-2496ED?style=flat-square&logo=docker&logoColor=white"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/github/license/nbsp1221/chat2sbx?style=flat-square"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="./docs/architecture.md">Architecture</a> ·
  <a href="./SECURITY.md">Security</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a> ·
  <a href="./ROADMAP.md">Roadmap</a>
</p>

## What is chat2sbx?

`chat2sbx` is a lightweight MCP control plane that gives ChatGPT a capable development environment inside disposable [Docker Sandbox](https://docs.docker.com/ai/sandboxes/) microVMs.

Each sandbox gets its own shell, chat2sbx-managed workspace, CodexPro process, and private Docker Engine. The host shell, host Docker daemon, and arbitrary host paths stay outside the execution boundary.

CodexPro is the in-sandbox MCP adapter chat2sbx uses for file, repository, and shell tools. `chat2sbx setup` installs the pinned CodexPro version into the local sandbox template, so no separate CodexPro installation is required on the host.

### Why use it?

- **Capable by default** — run shell commands, install packages, start servers, and use Docker inside the sandbox.
- **Isolated from the host** — ChatGPT never receives raw host shell, host sudo, or host Docker access.
- **Persistent managed workspaces** — sandbox files survive sandbox replacement without exposing arbitrary host paths.
- **Built for agent workflows** — stable sandbox/workspace IDs, long-running Bash sessions, port exposure, and reusable global instructions work across conversations.

## How it works

```text
ChatGPT
  │
  │ MCP
  ▼
Secure MCP Tunnel (external, recommended)
  │
  ▼
chat2sbx (host, loopback only)
  │
  ├─ workspace / sandbox registry
  │
  └─ Docker Sandbox microVM
       ├─ managed workspace
       ├─ CodexPro
       ├─ unrestricted sandbox shell
       └─ private Docker Engine
```

The diagram is intentionally simplified. See [Architecture](./docs/architecture.md) for the trust boundaries, lifecycle rules, Bash session contract, and workspace model.

## Prerequisites

- **Node.js 24+**
- **[Docker Sandboxes](https://docs.docker.com/ai/sandboxes/install/)** (`sbx`), signed in with `sbx login`
- For ChatGPT access: **OpenAI Secure MCP Tunnel** access and the tunnel client configured for your account

Docker Sandboxes requires a global network-policy preset before it can create sandboxes. On an interactive machine Docker prompts for one on first use. On a headless/non-interactive host, initialize it explicitly before running chat2sbx; Docker recommends `balanced` for most development workflows:

```bash
sbx login
sbx policy init balanced
```

Choose a different Docker Sandboxes policy if your environment requires it; chat2sbx does not override Docker's network policy.

## Quick start

### 1. Install chat2sbx

```bash
npm install --global chat2sbx
```

### 2. Prepare the sandbox template

```bash
chat2sbx setup
```

`setup` checks Docker Sandboxes and creates the pinned `chat2sbx-codexpro:0.30.0` template when needed.

### 3. Start the local MCP server

```bash
chat2sbx serve
```

In another terminal:

```bash
chat2sbx status
```

The MCP endpoint binds to loopback at `http://127.0.0.1:18788/mcp` by default. `chat2sbx serve` intentionally stays in the foreground and exits on Ctrl+C or SIGTERM. For always-on use, supervise it with the operating system's service manager rather than relying on chat2sbx to daemonize itself. chat2sbx does not expose or authenticate the MCP endpoint for you.

### 4. Connect ChatGPT

For ChatGPT, the recommended transport is OpenAI Secure MCP Tunnel. chat2sbx does not install, configure, authenticate, or supervise `tunnel-client`; use OpenAI's [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) and run the official client separately.

The simplest environment-variable flow is:

```bash
export CONTROL_PLANE_TUNNEL_ID='tunnel_...'
export CONTROL_PLANE_API_KEY='...'
export MCP_SERVER_URL='http://127.0.0.1:18788/mcp'
tunnel-client doctor --explain
tunnel-client run
```

`tunnel-client` also supports its official profile/`init` workflow. Keep tunnel credentials in the mechanism recommended by OpenAI rather than in chat2sbx configuration.

## Example workflow

Once connected, ChatGPT can create an isolated workspace and use the returned `sandbox_id` for subsequent tools:

```text
sandbox_create
  -> bash / read / write / search / ...
  -> bash_poll for long-running commands
  -> sandbox_expose to preview a web service
  -> sandbox_destroy when the environment is no longer needed
```

`sandbox_expose` uses direct port-mapping fields: `sandbox_port` is required, `host` defaults to `127.0.0.1`, and `host_port` is automatically assigned when omitted. Set an explicit host IPv4 address such as `0.0.0.0` and/or host port when you intentionally want a different mapping.

`sandbox_create` can optionally set a memory ceiling such as `512m` or `4g`. When reopening an existing sandbox, call `sandbox_get` first so its current state and any global sandbox instructions are loaded.

A typical long-running command looks like:

```text
bash
  -> { session_id: "bash_...", status: "running", output: "..." }

bash_poll
  -> { sandbox_id: "sbx_...", session_id: "bash_..." }
```

## Workspaces

chat2sbx uses one workspace model: every workspace is owned by chat2sbx and stored under `~/.chat2sbx/workspaces` by default. `sandbox_create` creates a new workspace when `workspace_id` is omitted, or reuses an existing managed workspace when `workspace_id` is provided.

For repository work, clone the repository from inside the sandbox and authenticate Git there. chat2sbx does not let MCP callers request, clone, or mount arbitrary host paths.

After a sandbox is removed, its workspace remains reusable for 30 days. When that retention period expires, chat2sbx moves the workspace to `~/.chat2sbx/archive` and keeps it there indefinitely. chat2sbx does not automatically delete archived workspace data.

## Resource controls and global instructions

Resource controls are optional. By default chat2sbx leaves Docker Sandboxes resource sizing unchanged and allows any number of active sandboxes. Operators can:

- pass `memory` to `sandbox_create` with values such as `512m` or `4g`;
- set `maxActiveSandboxes` in `~/.chat2sbx/config.json` or override it with `CHAT2SBX_MAX_ACTIVE_SANDBOXES`;
- add `~/.chat2sbx/AGENTS.md` to provide global agent instructions returned by `sandbox_create` and `sandbox_get`.

Global instructions are advisory text for agents. They are not copied into a workspace, interpreted as commands, or enforced as security policy. See [Architecture](./docs/architecture.md) for the exact lifecycle and resource semantics.

## Security model

chat2sbx is designed around a simple boundary: **the agent is powerful inside the microVM, not on the host.**

- CodexPro and unrestricted Bash run inside Docker Sandboxes, never directly on the host.
- MCP callers cannot request arbitrary host paths; they only receive chat2sbx-owned managed workspaces.
- The MCP server has no built-in authentication and binds to loopback by default. Do not expose it directly to an untrusted network.
- `sandbox_expose` publishes a sandbox port without adding authentication; treat the exposed service accordingly.
- chat2sbx does not read tunnel credentials; internal CodexPro bearer tokens are not returned through MCP.

Read [Architecture](./docs/architecture.md) for the canonical technical model and [Security](./SECURITY.md) for vulnerability reporting and expected security boundaries.

## CLI

```text
chat2sbx setup                         Check prerequisites and prepare the sandbox template
chat2sbx serve                         Run the local MCP gateway in the foreground
chat2sbx status                        Show service and MCP readiness
chat2sbx workspace list                List managed workspaces
chat2sbx sandbox list                  List sandboxes through the local MCP gateway
chat2sbx sandbox destroy <id>          Destroy a sandbox through the local MCP gateway
```

The sandbox CLI commands are intentionally thin local-MCP clients. They require `chat2sbx serve` to be running, but do not depend on the external Secure MCP Tunnel. Docker Sandbox diagnostics and reset/prune operations remain the responsibility of the underlying `sbx` CLI.

## Configuration

The defaults are intentionally small. `.env.example` contains the complete set of environment overrides.

| Variable                        | Default                       | Purpose                       |
| ------------------------------- | ----------------------------- | ----------------------------- |
| `CHAT2SBX_HOST`                 | `127.0.0.1`                   | MCP bind address              |
| `CHAT2SBX_PORT`                 | `18788`                       | MCP port                      |
| `CHAT2SBX_DATA_ROOT`            | `~/.chat2sbx`                 | Persistent chat2sbx data      |
| `CHAT2SBX_STATE_DIR`            | `<data root>/state`           | Runtime state directory       |
| `CHAT2SBX_WORKSPACE_ROOT`       | `<data root>/workspaces`      | Managed workspace directory   |
| `CHAT2SBX_DATABASE_PATH`        | `<state dir>/chat2sbx.sqlite` | SQLite state database         |
| `CHAT2SBX_MAX_ACTIVE_SANDBOXES` | `unlimited`                   | Optional active sandbox limit |

The same sandbox limit can be stored in `~/.chat2sbx/config.json` as `maxActiveSandboxes`; the environment variable takes precedence. `chat2sbx status` shows the effective limit and active count. Configuration is read when `chat2sbx serve` starts.

Global sandbox instructions live at `~/.chat2sbx/AGENTS.md` by default. Changes to that file are read on the next `sandbox_create` or `sandbox_get` and do not require a server restart.

## Documentation

| Document                                | Purpose                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------- |
| [Architecture](./docs/architecture.md)  | Trust boundaries, runtime ownership, workspace lifecycle, and Bash sessions |
| [Security](./SECURITY.md)               | Vulnerability reporting and security scope                                  |
| [Contributing](./CONTRIBUTING.md)       | Development setup, validation, and contribution workflow                    |
| [Tests](./test/README.md)               | Unit/integration/E2E boundaries and commands                                |
| [Roadmap](./ROADMAP.md)                 | Intended product direction                                                  |
| [Code of Conduct](./CODE_OF_CONDUCT.md) | Community participation expectations                                        |

## Project status

chat2sbx is early-stage software. The core sandbox boundary and workflow are usable, but interfaces may still change as the project is tested with real users.

If you try it, bug reports and concrete workflow feedback are especially useful. Use the repository's issue templates so reports include enough context to reproduce the problem.

## License

[MIT](./LICENSE). Third-party notices are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
