# Memhub

Memhub is the narrow, private gateway in front of Memmy Memory Core.

It provides one account/project-scoped context service for ChatGPT, Codex, Claude, DevSpace and other MCP-capable hosts without exposing the raw Memory HTTP API.

## Topology

```text
AI host
  |
  | MCP (stdio or authenticated HTTP)
  v
Memhub
  |- account identity / allowlist
  |- conversation -> project binding
  |- Context Router
  |- Normify read-only adapter
  |
  +---- loopback HTTP ----> Memmy Memory Core :18960
```

Memory Core stays loopback-only. Memhub also refuses a non-loopback Memory endpoint at construction time.

## MCP tools

### `memmy_context`

Returns a Context Capsule with separately labelled:

- global remembered context;
- current-project remembered context;
- authoritative Normify architecture;
- project-resolution status and ambiguities.

If a unique project cannot be resolved, project memory is not returned.

### `memmy_remember`

Stores an explicit durable fact/decision. `scope=project` requires either an explicit project or an existing conversation-to-project binding.

### `memhub_distill`

Stores a reusable artifact produced by an already-authenticated AI Harness. `kind=skill` is written as a real Memory `Skill`; `summary` and `knowledge` are curated L1 memories so they remain useful without pretending to be native L2 policy or L3 World Model output. Scope must be explicitly `global` or `project`, and project artifacts remain project-owned.

### `memmy_project`

Lists projects, inspects/binds/unbinds the current conversation project, and reads the authoritative Normify architecture brief.

## Capture and Local Bridge

Automatic history capture does not depend on the model remembering to call an MCP write tool.

Host adapters send capture fragments or complete turns to the local Memhub Bridge:

```text
host hook/native adapter
        |
        v
127.0.0.1:17861/capture
        |
        v
durable local queue
        |
        v
/memhub/capture
        |
        v
Memory session -> turn complete -> distillation
```

The capture protocol supports monotonic fragments for the same `event_id`. A prompt hook may submit `user_text` first and a later stop/final-response hook may add `assistant_text`. Bridge and Server merge only previously-missing fields; conflicting rewrites are rejected. Memory ingestion runs only after both sides of the turn are present, so no placeholder text is ever distilled.

The Bridge always writes the event to disk before attempting upload. If the server/network is unavailable, the event remains in `~/.memhub/queue/` and can be replayed later.

### Device enrollment

Server Edition uses a separate random device credential for each machine. The server stores only a SHA-256 hash of the credential.

```bash
# On the server; the raw token is shown only at creation time.
node dist/mcp.js device add <account-name-or-account-id> <device-name>

node dist/mcp.js device list <account-name-or-account-id>
node dist/mcp.js device revoke <device-id>
```

### Configure a Bridge

On the client machine, pass the device token through the environment rather than the command line:

```bash
MEMHUB_DEVICE_TOKEN='...' \
  node dist/bridge.js configure \
  --endpoint https://plugin.example.com/memhub/capture
```

If Cloudflare Access requires a service token for non-interactive clients, also provide `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` during configuration. They are persisted only in the local `0600` Bridge config.

The Bridge can be driven either as a CLI from hooks:

```bash
printf '%s' '<capture fragment or complete turn JSON>' | node dist/bridge.js capture
```

or as a loopback daemon:

```bash
node dist/bridge.js serve --port 17861
```

Available local endpoints are `POST /capture`, `POST /flush`, and `GET /status`.

## Local stdio

```bash
node dist/mcp.js \
  --account local \
  --memory-url http://127.0.0.1:18960 \
  --normify-root /home/user/codex-workspace
```

`local` maps to Memmy's existing `local-user`. Other accounts are mapped to stable account-specific Memory user IDs.

## HTTP / Cloudflare Access

Memhub HTTP always binds to `127.0.0.1`:

```bash
node dist/mcp.js \
  --http 3001 \
  --http-path /memhub/mcp \
  --public-host plugin.example.com \
  --memory-url http://127.0.0.1:18960 \
  --normify-root /srv/workspace
```

With `--public-host`, every request must carry a valid Cloudflare Access JWT. Memhub verifies the JWT issuer/audience and then checks the verified email against its local account allowlist.

Unknown emails are denied by default. `--allow-jit` exists only as an explicit opt-in and should normally remain off.

Server Edition exposes two authenticated origin paths on the same loopback service:

```text
/memhub/mcp       model-facing Streamable HTTP MCP
/memhub/capture   device-token authenticated turn capture
```

When Cloudflare is used, route both paths to the same loopback origin. Human/browser MCP clients may use the Access identity flow. Local Memhub Bridges should use a Cloudflare Access Service Token to pass the outer Access layer plus their own per-device Memhub token for account/device identity.

## Local Bridge

Local AI harness plugins connect only to the Bridge. They do not need to know the server credentials or whether the backend is Server Edition or Local Edition.

```text
AI plugin MCP  -> http://127.0.0.1:17861/mcp
AI plugin hook -> http://127.0.0.1:17861/capture
                         |
                         v
                    Memhub Bridge
                         |
            durable queue + credentials
                         |
              Server or Local backend
```

Configure a Server Edition bridge without putting secrets in command-line arguments:

```bash
export MEMHUB_DEVICE_TOKEN='<device token>'
export CF_ACCESS_CLIENT_ID='<Cloudflare Access service-token client id>'
export CF_ACCESS_CLIENT_SECRET='<Cloudflare Access service-token client secret>'

memhub-bridge configure \
  --mcp-endpoint https://plugin.example.com/memhub/mcp \
  --endpoint https://plugin.example.com/memhub/capture
```

The resulting bridge config is stored locally with private file permissions. Host plugins continue pointing at localhost.

On Linux, `deploy/install-bridge-user-service.sh` installs a loopback-only user service on port `17861`.

The same server also exposes the device-authenticated capture endpoint:

```text
/memhub/capture
```

Local plugins should normally not call either public endpoint directly. They talk to Memhub Bridge on loopback; Bridge proxies MCP and queues/uploads capture events.

Machine-installed Bridges are ready to use Cloudflare Access service-token headers plus a Memhub device token. Hosted/browser MCP clients require a standards-compliant MCP OAuth 2.1 flow before direct public MCP use; see `docs/REMOTE_AUTH.md`.

## Memhub Bridge

Memhub Bridge is the stable local interface for installed AI plugins:

```text
MCP:     http://127.0.0.1:17861/mcp
Capture: http://127.0.0.1:17861/capture
Status:  http://127.0.0.1:17861/status
```

In Server Edition, Bridge forwards to the authenticated remote Memhub server. In Local Edition, it forwards to the loopback Memhub server. Plugin packages therefore do not need separate server/local endpoint definitions.

Bridge always queues a capture event to disk before attempting upload. Failed uploads remain queued and are retried later. Server-side `event_id` deduplication makes replay safe.

Configure Bridge without putting secrets on command-line arguments:

```bash
export MEMHUB_DEVICE_TOKEN='mhdev_...'
export CF_ACCESS_CLIENT_ID='...'
export CF_ACCESS_CLIENT_SECRET='...'

memhub-bridge configure \
  --mcp-endpoint https://plugin.example.com/memhub/mcp \
  --endpoint https://plugin.example.com/memhub/capture

memhub-bridge serve
```

For a local-only installation, use loopback URLs instead and omit the Cloudflare credentials.

## Device enrollment

Each installed Bridge receives its own revocable device token. The plaintext token is shown only at enrollment time; the server stores only its hash.

```bash
memhub-mcp device add <username-or-account-id> <device-name>
memhub-mcp device list
memhub-mcp device revoke <device-id>
```

Do not share one device token across multiple machines.

## Automatic capture

The portable Agent Plugin includes an OpenAI/Codex lifecycle overlay. `UserPromptSubmit` stages the user prompt and `Stop` receives the latest assistant message; the hook combines them into one normalized capture event and sends it to Bridge.

Capture is not equivalent to immediate durable memory. The server submits captured turns into the existing Memory Core session/turn pipeline, where the normal L1/evolution/distillation behavior applies.

## Accounts

The account database defaults to `~/.memmy/memhub/accounts.json` and is written mode `0600`.

```bash
# Add an allowed person and bind the Cloudflare email immediately
node dist/mcp.js account add yihong yihong@example.com

# Or bind/change an email later
node dist/mcp.js account bind-email yihong yihong@example.com

# Inspect the local allowlist
node dist/mcp.js account list

# Import existing Normify identities while preserving account_id
node dist/mcp.js account import-normify /home/user/codex-workspace
```

Preserving `account_id` matters because Normify project directories are keyed by a SHA-256 hash of that ID.

## Cloudflare pinning

On first successful public authentication, Memhub pins the Cloudflare Access issuer and audience in `~/.memmy/memhub/cloudflare-access.json`. Later requests must match the pin.

For deterministic deployment, these may also be set explicitly:

```text
MEMHUB_CF_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
MEMHUB_CF_AUD=<access-application-audience>
```

The user service also reads `~/.memmy/memhub/memhub.env` when present. A typical public configuration is:

```text
MEMHUB_PUBLIC_HOST=plugin.example.com
MEMHUB_CF_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
MEMHUB_CF_AUD=<access-application-audience>
MEMHUB_OWNER_ACCOUNT_ID=<your existing account_id>
```

Do not put conversation history, project architecture or model API keys in this file.

## Normify

Normify remains the authoritative owner of project architecture. Memhub invokes `normify_brief` read-only and labels the returned data `authority=authoritative`; it is not copied into ordinary long-term memory.

For local account mode, root-level `normify-*` projects are used. Authenticated accounts use Normify's existing account-hashed project directories.

## Tests

```bash
npm test
```

The tests cover project ambiguity isolation, Context Capsule filtering, account allowlisting, preservation of imported Normify account IDs, loopback Memory enforcement, and both stdio and Streamable HTTP MCP transports using a fake loopback Memory service.
