<h1 align="center">chat2sbx</h1>

<p align="center"><strong>Give ChatGPT a computer you can safely throw away.</strong></p>

<p align="center">
  <strong>English</strong> · <a href="./README.ko.md">한국어</a>
</p>

<p align="center">
  <a href="https://github.com/nbsp1221/chat2sbx/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/nbsp1221/chat2sbx/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://www.npmjs.com/package/chat2sbx"><img alt="npm" src="https://img.shields.io/npm/v/chat2sbx?style=flat-square&logo=npm"></a>
  <a href="https://nodejs.org/"><img alt="Node.js >=24" src="https://img.shields.io/badge/Node.js-%3E%3D24-339933?style=flat-square&logo=nodedotjs&logoColor=white"></a>
  <a href="https://docs.docker.com/ai/sandboxes/"><img alt="Docker Sandboxes" src="https://img.shields.io/badge/isolation-Docker%20Sandboxes-2496ED?style=flat-square&logo=docker&logoColor=white"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/github/license/nbsp1221/chat2sbx?style=flat-square"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="./docs/architecture.md">Architecture</a> ·
  <a href="./SECURITY.md">Security</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

`chat2sbx` connects ChatGPT to disposable [Docker Sandbox](https://docs.docker.com/ai/sandboxes/) microVMs running on your own machine. ChatGPT gets a real shell, files, packages, servers, and Docker without getting your host shell or host Docker daemon.

If you already use Docker Sandboxes, chat2sbx adds the ChatGPT-facing control layer: create and reuse sandboxes, keep workspaces between sandbox instances, run long commands, and expose local ports.

## Quick start

### Prerequisites

- Node.js 24+
- [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/install/) (`sbx`)
- [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) access to use chat2sbx from ChatGPT

Install chat2sbx and prepare its sandbox template:

```bash
npm install --global chat2sbx
sbx login
chat2sbx setup
```

On a headless host, Docker Sandboxes may also need its network policy initialized once, for example with `sbx policy init balanced`.

Start chat2sbx:

```bash
chat2sbx serve
```

You can check it from another terminal:

```bash
chat2sbx status
```

The MCP server listens on `http://127.0.0.1:18788/mcp` by default.

### Connect ChatGPT

Create a tunnel and runtime API key in OpenAI Platform, then run the official `tunnel-client` against the local MCP server:

```bash
export CONTROL_PLANE_TUNNEL_ID='tunnel_...'
export CONTROL_PLANE_API_KEY='...'
export MCP_SERVER_URL='http://127.0.0.1:18788/mcp'

tunnel-client doctor --explain
tunnel-client run
```

Keep the tunnel client running. In ChatGPT, create a developer-mode app, choose **Tunnel** as the connection, and select the same tunnel. OpenAI's [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) covers tunnel setup and permissions.

Then try:

> Create a sandbox, run `uname -a` and `docker version` inside it, and show me the results.

If ChatGPT can run both commands, the connection is ready.

## How it works

```text
ChatGPT
  │
  │ MCP
  ▼
Secure MCP Tunnel
  │
  ▼
chat2sbx
  │
  └─ Docker Sandbox microVM
       ├─ workspace
       ├─ shell and dev tools
       └─ private Docker Engine
```

The sandbox is where the agent does its work. Your host shell, sudo, Docker daemon, and arbitrary host paths stay outside that boundary. See [Architecture](./docs/architecture.md) for the detailed model.

## Features

- Create disposable Docker Sandbox microVMs from ChatGPT
- Keep working files across sandbox replacements
- Run file, repository, and shell tasks, including long-running commands
- Use a private Docker Engine inside each sandbox
- Expose ports for services running inside a sandbox

## CLI

```text
chat2sbx setup                         Prepare the sandbox template
chat2sbx serve                         Run the local MCP server
chat2sbx status                        Check local service status
chat2sbx workspace list                List workspaces
chat2sbx sandbox list                  List sandboxes
chat2sbx sandbox destroy <id>          Destroy a sandbox
```

Repository work happens inside the sandbox. Clone repositories there instead of mounting arbitrary host directories.

Workspaces survive sandbox replacement so you can continue where you left off. See [Architecture](./docs/architecture.md) for retention details.

## Configuration

Most users can use the defaults. Common options are:

- `CHAT2SBX_HOST` and `CHAT2SBX_PORT` to change the local MCP bind address
- `CHAT2SBX_MAX_ACTIVE_SANDBOXES` to limit active sandboxes
- `~/.chat2sbx/AGENTS.md` for instructions shared across sandboxes

The default data directory is `~/.chat2sbx`.

## Security

The MCP server binds to loopback by default and has no built-in authentication. Use an access-controlled transport such as Secure MCP Tunnel instead of exposing it directly to an untrusted network.

Services published with `sandbox_expose` do not get authentication from chat2sbx. Read [SECURITY.md](./SECURITY.md) before exposing chat2sbx or sandbox services beyond your machine.

## Troubleshooting

If ChatGPT cannot reach chat2sbx, start with:

```bash
chat2sbx status
tunnel-client doctor --explain
```

For a failed sandbox:

```bash
chat2sbx sandbox list
chat2sbx sandbox destroy <id>
```

Use the underlying `sbx` CLI for Docker Sandbox diagnostics and reset/prune operations.

## Documentation

- [Architecture](./docs/architecture.md) — runtime model, trust boundaries, and lifecycle details
- [Security](./SECURITY.md) — security scope and vulnerability reporting
- [Contributing](./CONTRIBUTING.md) — development and contribution guide
- [Tests](./test/README.md) — test layout and E2E requirements
- [Roadmap](./ROADMAP.md) — planned product direction

## Project status

chat2sbx is early-stage software. The core workflow is usable, but interfaces may change as the project gets more real-world use. Bug reports and workflow feedback are welcome.

## License

[MIT](./LICENSE). Third-party notices are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
