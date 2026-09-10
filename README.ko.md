<h1 align="center">chat2sbx</h1>

<p align="center"><strong>ChatGPT에게 마음 놓고 버릴 수 있는 컴퓨터를 주세요.</strong></p>

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
  <a href="#동작-방식">동작 방식</a> ·
  <a href="./docs/architecture.md">Architecture</a> ·
  <a href="./SECURITY.md">Security</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

`chat2sbx`는 내 컴퓨터에서 돌아가는 일회성 [Docker Sandbox](https://docs.docker.com/ai/sandboxes/) microVM을 ChatGPT에 연결합니다. ChatGPT는 sandbox 안에서 셸, 파일, 패키지, 서버, Docker를 자유롭게 쓸 수 있지만 호스트 셸이나 호스트 Docker daemon에는 접근하지 않습니다.

Docker Sandboxes가 격리된 컴퓨터를 만든다면, chat2sbx는 그 환경을 ChatGPT에서 만들고 다시 쓰고 이어서 작업할 수 있게 연결합니다.

## 빠른 시작

### 사전 요구사항

- Node.js 24+
- [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/install/) (`sbx`)
- ChatGPT에서 사용하려면 [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 사용 권한

chat2sbx를 설치하고 Docker Sandboxes에 로그인합니다.

```bash
npm install --global chat2sbx
sbx login
```

헤드리스나 비대화형 환경에서는 setup 전에 Docker Sandboxes의 네트워크 정책을 초기화합니다.

```bash
sbx policy init balanced
```

대화형 환경에서는 처음 사용할 때 네트워크 정책을 직접 선택하라는 안내가 나오므로 위 명령을 생략해도 됩니다. 그다음 샌드박스 템플릿을 준비하고 chat2sbx를 실행합니다.

```bash
chat2sbx setup
chat2sbx serve
```

다른 터미널에서 상태를 확인할 수 있습니다.

```bash
chat2sbx status
```

기본 MCP 주소는 `http://127.0.0.1:18788/mcp`입니다.

### ChatGPT 연결

OpenAI Platform에서 tunnel과 runtime API key를 만든 뒤, 공식 `tunnel-client`를 로컬 MCP 서버에 연결합니다.

```bash
export CONTROL_PLANE_TUNNEL_ID='tunnel_...'
export CONTROL_PLANE_API_KEY='...'
export MCP_SERVER_URL='http://127.0.0.1:18788/mcp'

tunnel-client doctor --explain
tunnel-client run
```

`tunnel-client`는 계속 실행해 둡니다. ChatGPT에서 developer-mode app을 만들고 연결 방식으로 **Tunnel**을 선택한 뒤 같은 tunnel을 고릅니다. Tunnel 생성과 권한 설정은 OpenAI의 [Secure MCP Tunnel 가이드](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)를 참고하세요.

이제 ChatGPT에 이렇게 요청해 볼 수 있습니다.

> 새 sandbox를 만들고 그 안에서 `uname -a`와 `docker version`을 실행한 뒤 결과를 보여줘.

두 명령이 정상적으로 실행되면 연결이 끝난 겁니다.

## 동작 방식

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

에이전트의 작업은 sandbox 안에서 이뤄집니다. 호스트 셸, sudo, Docker daemon, 임의의 호스트 경로는 그 밖에 남습니다. 자세한 구조는 [Architecture](./docs/architecture.md)를 참고하세요.

## 주요 기능

- ChatGPT에서 일회성 Docker Sandbox microVM 생성
- sandbox를 바꿔도 작업 파일 유지
- 파일, 저장소, 셸 작업과 오래 걸리는 명령 실행
- 각 sandbox에서 독립적으로 Docker 사용
- sandbox 안에서 실행한 서비스의 포트 공개

## CLI

```text
chat2sbx setup                         샌드박스 템플릿 준비
chat2sbx serve                         로컬 MCP 서버 실행
chat2sbx status                        로컬 서비스 상태 확인
chat2sbx workspace list                workspace 목록
chat2sbx sandbox list                  sandbox 목록
chat2sbx sandbox destroy <id>          sandbox 제거
```

저장소 작업도 sandbox 안에서 합니다. 호스트 디렉터리를 마운트하는 대신 sandbox 안에서 저장소를 clone하세요.

Sandbox를 바꿔도 workspace는 그대로 남아 이어서 작업할 수 있습니다. 보존 방식이 궁금하다면 [Architecture](./docs/architecture.md)를 참고하세요.

## 설정

대부분은 기본값 그대로 사용할 수 있습니다. 자주 쓰는 설정은 다음 정도입니다.

- `CHAT2SBX_HOST`, `CHAT2SBX_PORT`: 로컬 MCP 주소 변경
- `CHAT2SBX_MAX_ACTIVE_SANDBOXES`: 동시에 사용할 sandbox 수 제한
- `~/.chat2sbx/AGENTS.md`: 모든 sandbox에 공통으로 적용할 지침

기본 데이터 디렉터리는 `~/.chat2sbx`입니다.

## 보안

MCP 서버는 기본적으로 loopback에만 바인딩되며 자체 인증 기능은 없습니다. 신뢰할 수 없는 네트워크에 직접 공개하지 말고 Secure MCP Tunnel 같은 접근 제어된 경로를 사용하세요.

`sandbox_expose`로 공개한 서비스에도 chat2sbx가 인증을 붙이지 않습니다. 외부에 공개하기 전에는 [SECURITY.md](./SECURITY.md)를 확인하세요.

## 문제 해결

ChatGPT가 chat2sbx에 연결되지 않는다면 먼저 다음을 확인합니다.

```bash
chat2sbx status
tunnel-client doctor --explain
```

Sandbox가 `failed` 상태라면:

```bash
chat2sbx sandbox list
chat2sbx sandbox destroy <id>
```

Docker Sandbox 자체 문제는 `sbx` CLI의 진단 및 reset/prune 기능을 사용하세요.

## 문서

- [Architecture](./docs/architecture.md) — 실행 구조, 신뢰 경계, 수명 주기
- [Security](./SECURITY.md) — 보안 범위와 취약점 제보
- [Contributing](./CONTRIBUTING.md) — 개발 및 기여 방법
- [Tests](./test/README.md) — 테스트 구성과 E2E 요구사항
- [Roadmap](./ROADMAP.md) — 앞으로의 방향

## 프로젝트 상태

chat2sbx는 아직 초기 단계입니다. 핵심 흐름은 사용할 수 있지만 실제 사용자 피드백에 따라 인터페이스가 바뀔 수 있습니다. 버그 리포트와 사용 경험에 대한 피드백을 환영합니다.

## 라이선스

[MIT](./LICENSE). 서드파티 고지는 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)에 있습니다.
