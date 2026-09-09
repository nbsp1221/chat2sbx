<h1 align="center">chat2sbx</h1>

<p align="center"><strong>ChatGPT에게 언제든 버릴 수 있는 안전한 컴퓨터를 주세요.</strong></p>

<p align="center">
  <a href="./README.md">English</a> · <strong>한국어</strong>
</p>

<p align="center">
  <a href="https://github.com/nbsp1221/chat2sbx/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/nbsp1221/chat2sbx/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://www.npmjs.com/package/chat2sbx"><img alt="npm" src="https://img.shields.io/npm/v/chat2sbx?style=flat-square&logo=npm"></a>
  <a href="https://nodejs.org/"><img alt="Node.js >=24" src="https://img.shields.io/badge/Node.js-%3E%3D24-339933?style=flat-square&logo=nodedotjs&logoColor=white"></a>
  <a href="https://docs.docker.com/ai/sandboxes/"><img alt="Docker Sandboxes" src="https://img.shields.io/badge/isolation-Docker%20Sandboxes-2496ED?style=flat-square&logo=docker&logoColor=white"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/github/license/nbsp1221/chat2sbx?style=flat-square"></a>
</p>

<p align="center">
  <a href="#빠른-시작">빠른 시작</a> ·
  <a href="./docs/architecture.md">아키텍처</a> ·
  <a href="./SECURITY.md">보안</a> ·
  <a href="./CONTRIBUTING.md">기여</a> ·
  <a href="./ROADMAP.md">로드맵</a>
</p>

## chat2sbx란?

`chat2sbx`는 내 하드웨어에서 실행되는 일회성 [Docker Sandbox](https://docs.docker.com/ai/sandboxes/) microVM을 ChatGPT가 사용할 수 있게 해주는 가벼운 MCP control plane입니다.

Docker Sandboxes가 격리된 컴퓨터를 제공한다면, chat2sbx는 그 위에 지속되는 workspace와 lifecycle control을 더해 ChatGPT 웹 세션에서 사용할 수 있게 연결합니다. 이때 ChatGPT에 호스트 셸, 호스트 Docker daemon, 임의의 호스트 경로를 넘기지 않습니다.

각 sandbox에는 독립된 셸, chat2sbx가 관리하는 workspace, CodexPro 프로세스, private Docker Engine이 있습니다. CodexPro는 chat2sbx가 파일·저장소·셸 도구를 제공하기 위해 sandbox 내부에서 사용하는 MCP adapter입니다. `chat2sbx setup`이 고정된 CodexPro 버전을 로컬 sandbox template에 설치하므로 호스트에 CodexPro를 따로 설치할 필요는 없습니다.

### 왜 사용하나요?

- **처음부터 강력함** — sandbox 안에서 셸 명령, 패키지 설치, 서버 실행, Docker 사용이 가능합니다.
- **호스트와 격리됨** — ChatGPT는 호스트 셸, 호스트 sudo, 호스트 Docker 권한을 직접 받지 않습니다.
- **지속되는 managed workspace** — sandbox를 교체해도 파일은 남고, 임의의 호스트 경로를 노출하지 않습니다.
- **에이전트 워크플로우에 맞춤** — 안정적인 sandbox/workspace ID, 장시간 Bash session, port exposure, 전역 instructions를 여러 대화에서 재사용할 수 있습니다.

## 동작 방식

```text
ChatGPT
  │
  │ MCP
  ▼
Secure MCP Tunnel (외부, 권장)
  │
  ▼
chat2sbx (호스트, 기본 loopback)
  │
  ├─ workspace / sandbox registry
  │
  └─ Docker Sandbox microVM
       ├─ managed workspace
       ├─ CodexPro
       ├─ unrestricted sandbox shell
       └─ private Docker Engine
```

위 그림은 의도적으로 단순화했습니다. 정확한 신뢰 경계, lifecycle 규칙, Bash session contract, workspace 모델은 [Architecture](./docs/architecture.md)를 참고하세요.

## 사전 요구사항

- **Node.js 24+**
- **[Docker Sandboxes](https://docs.docker.com/ai/sandboxes/install/)** (`sbx`), `sbx login`으로 로그인된 상태
- ChatGPT에서 사용하려면 **OpenAI Secure MCP Tunnel** 사용 권한과 설정된 tunnel client

Docker Sandboxes는 sandbox를 만들기 전에 전역 network-policy preset이 필요합니다. 대화형 환경에서는 처음 사용할 때 Docker가 선택을 요청합니다. headless/non-interactive 호스트에서는 chat2sbx를 실행하기 전에 명시적으로 초기화하세요. Docker는 일반적인 개발 용도로 `balanced`를 권장합니다.

```bash
sbx login
sbx policy init balanced
```

환경에 다른 Docker Sandboxes policy가 필요하다면 그 값을 사용하세요. chat2sbx는 Docker의 network policy를 덮어쓰지 않습니다.

## 빠른 시작

### 1. chat2sbx 설치

```bash
npm install --global chat2sbx
```

### 2. Sandbox template 준비

```bash
chat2sbx setup
```

`setup`은 Docker Sandboxes를 확인하고, 필요하면 고정된 `chat2sbx-codexpro:0.30.0` template을 생성합니다.

### 3. 로컬 MCP 서버 시작

```bash
chat2sbx serve
```

다른 터미널에서:

```bash
chat2sbx status
```

service가 running이고 MCP가 ready로 표시되면 됩니다. 기본 endpoint는 `http://127.0.0.1:18788/mcp`입니다.

`chat2sbx serve`는 의도적으로 foreground에서 실행되며 Ctrl+C 또는 SIGTERM으로 종료됩니다. 항상 켜두고 싶다면 chat2sbx 자체를 daemonize하는 대신 운영체제의 service manager로 supervise하세요. chat2sbx 자체는 MCP endpoint를 외부에 공개하거나 인증을 추가하지 않습니다.

### 4. ChatGPT 연결

ChatGPT 연결에는 [OpenAI Secure MCP Tunnel](https://github.com/openai/tunnel-client/blob/master/docs/end-user-guide.md)을 권장합니다. chat2sbx는 `tunnel-client`를 설치·설정·인증·감독하지 않으며, 공식 client를 별도로 실행합니다.

OpenAI Platform에서 서로 다른 두 값이 필요합니다.

- `CONTROL_PLANE_TUNNEL_ID` — [Tunnels 관리](https://platform.openai.com/settings/organization/tunnels)에서 확인하는 tunnel ID입니다.
- `CONTROL_PLANE_API_KEY` — [Runtime API keys](https://platform.openai.com/settings/organization/api-keys)에서 만드는 runtime API key입니다. tunnel ID나 admin key와는 다른 값입니다.

두 값을 준비했다면 가장 짧은 환경변수 방식은 다음과 같습니다.

```bash
export CONTROL_PLANE_TUNNEL_ID='tunnel_...'
export CONTROL_PLANE_API_KEY='...'
export MCP_SERVER_URL='http://127.0.0.1:18788/mcp'

tunnel-client doctor --explain
tunnel-client run
```

`tunnel-client run`은 계속 실행해 두세요. 그다음 [ChatGPT connector 설정](https://chatgpt.com/#settings/Connectors)을 열고 **Connection: Tunnel** 방식으로 connector를 생성하거나 설정한 뒤, 같은 tunnel을 선택하거나 동일한 `tunnel_id`를 입력합니다.

ChatGPT에서 tunnel이 보이지 않는다면 공식 [Tunnel End-User Guide](https://github.com/openai/tunnel-client/blob/master/docs/end-user-guide.md)에서 workspace scope와 **Tunnels Read + Use** 권한을 확인하세요. 환경변수 대신 이름 있는 설정을 선호한다면 `tunnel-client`의 profile/`init` 방식도 사용할 수 있습니다.

### 5. 첫 sandbox 확인

ChatGPT에 다음처럼 요청하세요.

> 새 sandbox를 만들고 그 안에서 `uname -a`와 `docker version`을 실행한 뒤, sandbox ID와 workspace ID를 알려줘.

성공하면 ChatGPT가 sandbox를 생성하고 microVM 안에서 두 명령을 실행한 뒤 안정적인 `sandbox_id`와 `workspace_id`를 반환합니다. 여기까지 되면 ChatGPT → tunnel → chat2sbx → Docker Sandbox 경로가 정상입니다.

## ChatGPT로 할 수 있는 일

연결 후 ChatGPT는 격리된 workspace를 만들고 반환된 `sandbox_id`를 이후 도구 호출에 사용할 수 있습니다.

```text
sandbox_create
  -> bash / read / write / search / ...
  -> bash_poll for long-running commands
  -> sandbox_expose to preview a web service
  -> sandbox_destroy when the environment is no longer needed
```

`sandbox_expose`는 직접적인 port-mapping 필드를 사용합니다. `sandbox_port`는 필수이고, `host` 기본값은 `127.0.0.1`, `host_port`는 생략하면 자동 할당됩니다. 의도적으로 다른 mapping이 필요할 때만 `0.0.0.0` 같은 host IPv4 주소나 고정 host port를 지정하세요.

`sandbox_create`에는 `512m`, `4g` 같은 선택적 memory limit을 줄 수 있습니다. 기존 sandbox를 다시 열 때는 먼저 `sandbox_get`을 호출해 현재 상태와 전역 sandbox instructions를 불러오세요.

장시간 명령은 대략 다음 흐름으로 동작합니다.

```text
bash
  -> { session_id: "bash_...", status: "running", output: "..." }

bash_poll
  -> { sandbox_id: "sbx_...", session_id: "bash_..." }
```

## Workspaces

chat2sbx는 하나의 workspace 모델만 사용합니다. 모든 workspace는 chat2sbx가 소유하고 관리하며 기본적으로 `~/.chat2sbx/workspaces` 아래에 저장됩니다. `sandbox_create`에서 `workspace_id`를 생략하면 새 workspace를 만들고, 기존 managed workspace ID를 지정하면 재사용합니다.

저장소 작업은 sandbox 내부에서 `git clone`하고 Git 인증도 그 안에서 진행하세요. chat2sbx는 MCP caller가 임의의 호스트 경로를 요청하거나 clone/mount하도록 허용하지 않습니다.

sandbox가 제거된 뒤 workspace는 30일 동안 재사용할 수 있습니다. 보존 기간이 지나면 chat2sbx가 `~/.chat2sbx/archive`로 이동시키고 무기한 보관합니다. archived workspace 데이터는 자동 삭제하지 않습니다.

## Resource controls와 전역 instructions

Resource control은 선택 사항입니다. 기본적으로 chat2sbx는 Docker Sandboxes의 resource sizing을 그대로 사용하고 active sandbox 수에도 제한을 두지 않습니다. 운영자는 다음을 설정할 수 있습니다.

- `sandbox_create`에 `512m`, `4g` 같은 `memory` 값 전달
- `~/.chat2sbx/config.json`의 `maxActiveSandboxes` 또는 `CHAT2SBX_MAX_ACTIVE_SANDBOXES` 환경변수로 최대 active sandbox 수 설정
- `~/.chat2sbx/AGENTS.md`에 `sandbox_create`와 `sandbox_get`이 반환할 전역 agent instructions 작성

전역 instructions는 에이전트를 위한 advisory text입니다. workspace에 복사되거나 명령으로 실행되지 않으며 보안 정책으로 강제되지도 않습니다. 정확한 lifecycle/resource semantics는 [Architecture](./docs/architecture.md)를 참고하세요.

## 보안 모델

chat2sbx의 경계는 단순합니다. **에이전트는 microVM 안에서는 강력하지만, 호스트 권한을 직접 받지 않습니다.**

- CodexPro와 unrestricted Bash는 Docker Sandboxes 안에서만 실행됩니다.
- MCP caller는 임의의 호스트 경로를 요청할 수 없고 chat2sbx가 관리하는 workspace만 받습니다.
- MCP server에는 built-in 인증이 없으며 기본적으로 loopback에 bind합니다. 신뢰할 수 없는 네트워크에 직접 노출하지 마세요.
- `sandbox_expose`는 sandbox port를 공개할 뿐 별도 인증을 추가하지 않습니다.
- chat2sbx는 tunnel credential을 읽지 않으며 내부 CodexPro bearer token도 MCP로 반환하지 않습니다.

정확한 기술 모델은 [Architecture](./docs/architecture.md), 취약점 보고와 보안 범위는 [Security](./SECURITY.md)를 참고하세요.

## CLI

```text
chat2sbx setup                         사전 요구사항을 확인하고 sandbox template 준비
chat2sbx serve                         로컬 MCP gateway를 foreground에서 실행
chat2sbx status                        service와 MCP readiness 확인
chat2sbx workspace list                managed workspace 목록 조회
chat2sbx sandbox list                  로컬 MCP gateway를 통해 sandbox 목록 조회
chat2sbx sandbox destroy <id>          로컬 MCP gateway를 통해 sandbox 제거
```

sandbox CLI 명령은 의도적으로 얇은 local-MCP client입니다. `chat2sbx serve`가 실행 중이어야 하지만 외부 Secure MCP Tunnel에는 의존하지 않습니다. Docker Sandbox 수준의 diagnostics/reset/prune은 chat2sbx가 복제하지 않고 기본 `sbx` CLI에 맡깁니다.

## 설정

기본값은 의도적으로 작게 유지합니다. 아래 표가 지원하는 환경변수 override 전체입니다.

| 변수                            | 기본값                        | 용도                        |
| ------------------------------- | ----------------------------- | --------------------------- |
| `CHAT2SBX_HOST`                 | `127.0.0.1`                   | MCP bind address            |
| `CHAT2SBX_PORT`                 | `18788`                       | MCP port                    |
| `CHAT2SBX_DATA_ROOT`            | `~/.chat2sbx`                 | 영구 chat2sbx 데이터        |
| `CHAT2SBX_STATE_DIR`            | `<data root>/state`           | runtime state directory     |
| `CHAT2SBX_WORKSPACE_ROOT`       | `<data root>/workspaces`      | managed workspace directory |
| `CHAT2SBX_DATABASE_PATH`        | `<state dir>/chat2sbx.sqlite` | SQLite state database       |
| `CHAT2SBX_MAX_ACTIVE_SANDBOXES` | `unlimited`                   | 선택적 active sandbox 제한  |

같은 sandbox limit을 `~/.chat2sbx/config.json`의 `maxActiveSandboxes`로 저장할 수도 있으며 환경변수가 우선합니다. `chat2sbx status`는 적용된 limit과 active count를 보여줍니다. 설정은 `chat2sbx serve` 시작 시 읽습니다.

전역 sandbox instructions는 기본적으로 `~/.chat2sbx/AGENTS.md`에 둡니다. 이 파일의 변경은 다음 `sandbox_create` 또는 `sandbox_get` 호출에서 읽히므로 server restart가 필요하지 않습니다.

## 문제 해결

### ChatGPT에서 chat2sbx가 보이지 않거나 사용할 수 없음

1. `chat2sbx status`를 실행해 MCP가 ready인지 확인합니다.
2. `tunnel-client doctor --explain`을 실행하고 `tunnel-client run`을 계속 켜둡니다.
3. ChatGPT connector가 **Connection: Tunnel** 방식이고 `tunnel-client`와 동일한 `tunnel_id`를 사용하는지 확인합니다.
4. tunnel이 보이지 않으면 공식 [Tunnel End-User Guide](https://github.com/openai/tunnel-client/blob/master/docs/end-user-guide.md)에서 ChatGPT workspace scope와 **Tunnels Read + Use** 권한을 확인합니다.

### Sandbox가 stuck/failed 상태임

목록을 확인한 뒤 failed sandbox를 명시적으로 제거합니다.

```bash
chat2sbx sandbox list
chat2sbx sandbox destroy <id>
```

Docker Sandbox runtime 자체를 진단해야 한다면 별도 chat2sbx recovery 계층 대신 `sbx diagnose`, `sbx reset`, `sbx prune` 같은 기본 `sbx` 명령을 사용하세요.

## 문서

| 문서                                    | 용도                                                             |
| --------------------------------------- | ---------------------------------------------------------------- |
| [Architecture](./docs/architecture.md)  | 신뢰 경계, runtime ownership, workspace lifecycle, Bash sessions |
| [Security](./SECURITY.md)               | 취약점 보고와 보안 범위                                          |
| [Contributing](./CONTRIBUTING.md)       | 개발 환경, 검증, 기여 workflow                                   |
| [Tests](./test/README.md)               | Unit/integration/E2E 경계와 실행 명령                            |
| [Roadmap](./ROADMAP.md)                 | 향후 제품 방향                                                   |
| [Code of Conduct](./CODE_OF_CONDUCT.md) | 커뮤니티 참여 규칙                                               |

이 문서들은 현재 영어를 기준으로 관리합니다. 사용자-facing onboarding은 `README.md`와 `README.ko.md`에서 동일한 구조로 제공합니다.

## 프로젝트 상태

chat2sbx는 초기 단계의 소프트웨어입니다. 핵심 sandbox 경계와 workflow는 사용할 수 있지만, 실제 사용자 피드백에 따라 interface가 바뀔 수 있습니다.

직접 사용해 본다면 bug report와 구체적인 workflow feedback이 특히 도움이 됩니다. 재현에 필요한 정보가 포함되도록 저장소의 issue template을 사용해 주세요.

## 라이선스

[MIT](./LICENSE). Third-party notice는 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)에 있습니다.
