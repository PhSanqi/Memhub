# Cloudflare Tunnel stability for Memhub

Memhub should stay bound to loopback and let `cloudflared` own the public edge connection. Do not expose port 3001 directly.

## Canonical production route

The canonical production route for this project is `https://memhub.sanqi.org/`. Production health, MCP, capture, browser UI, and the dedicated Tunnel watchdog must resolve from that hostname. The historical `plugin.sanqi.org/memhub` route is retired and is not a production source of truth.

The `memory.example.com` values used later in this document are intentionally generic placeholders for self-hosted installations; they do not replace the canonical route above for the project deployment.

## Recommended connector transport

- Keep `cloudflared` transport protocol on `auto`. It prefers QUIC and falls back to HTTP/2 when UDP connectivity is unavailable.
- Keep retries near the Cloudflare default (`5`). Tunnel retries already use exponential backoff; increasing the count substantially mainly increases recovery time before a clear failure is surfaced.
- Keep the default global region unless a compliance requirement explicitly needs a fixed region.
- Use IPv4 unless the host has known-good dual-stack connectivity. `edge-ip-version=auto` is useful only when IPv6 is actually healthy.

## Memhub origin settings

For the published route pointing to `http://127.0.0.1:3001`:

- `connectTimeout`: `5s` — the origin is loopback, so a long TCP connect timeout hides a dead local service.
- `keepAliveTimeout`: `90s`.
- `keepAliveConnections`: `100`.
- `tcpKeepAlive`: `30s`.
- `http2Origin`: **off**. Memhub's Tunnel origin is loopback HTTP; Cloudflare HTTP/2-to-origin requires HTTPS.
- Keep TLS verification enabled whenever an HTTPS origin is used. Do not use `noTLSVerify` as a reliability workaround.

Memhub's HTTP server keeps idle sockets for 95 seconds, slightly longer than the recommended 90-second cloudflared origin keepalive. This lets cloudflared retire an idle connection before Memhub does, reducing stale-socket reuse.

For a remotely-managed Tunnel, configure these values on the published application route in the Cloudflare dashboard under **Additional application settings → Connection**. `npm run network:check` reads the running connector's safe `/config` view and warns when a loopback route still uses an unnecessarily long connect timeout.

## Control-plane credential versus Tunnel token

Do not confuse three different Cloudflare secrets:

- The **Tunnel token** (`eyJ...`) lets `cloudflared` run a remotely managed Tunnel. It is not a general control-plane credential and is insufficient for editing the remote ingress configuration.
- A **Cloudflare API token** is the credential Memhub needs for scripted changes to a remotely managed Tunnel configuration. For updating `accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations`, scope it to the owning account and grant the narrowest available Tunnel write permission (`Cloudflare Tunnel Write` / `Cloudflare One Connector: cloudflared Write` / `Cloudflare One Connectors Write`). DNS edit permission is only needed when the automation also changes DNS records.
- A **Tunnel management token** is a short-lived token created for management resources such as streaming Tunnel logs. It is obtained *using* an API token and is not the credential required to update ingress/origin settings.

Create the API token in Cloudflare Dashboard under **My Profile → API Tokens → Create Token → Custom token** (or **Manage Account → API Tokens** for an account-owned service token). Restrict Account Resources to the account that owns the Memhub Tunnel, give only the required Tunnel write permission, and optionally add IP/TTL restrictions. Store the resulting token outside the repository and expose it to administrative tooling as `CLOUDFLARE_API_TOKEN` only for the duration required.

## Observability

Pin the cloudflared Prometheus endpoint to `127.0.0.1:20241` and keep normal logs at `info`. `debug` logs include request/response metadata and should only be enabled temporarily.

Run:

```bash
npm run network:check
```

To include the public route:

```bash
npm run network:check -- --public-host memory.example.com
```

For this project's production deployment, use:

```bash
npm run network:check -- --public-host memhub.sanqi.org --metrics 127.0.0.1:20241
```

On a host running several Tunnel connectors, also pass the connector's fixed metrics address so the report cannot attach to a different Tunnel after process restart:

```bash
npm run network:check -- --public-host memory.example.com --metrics 127.0.0.1:20241
```

If Cloudflare Access protects the hostname, set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` for an end-to-end authenticated probe. Without service-token credentials, an Access challenge is reported as protected rather than as an origin failure.

Watch these tunnel metrics:

- `cloudflared_tunnel_ha_connections`: a healthy connector normally maintains four edge connections.
- `cloudflared_tunnel_request_errors`: sustained growth indicates proxy/origin errors.
- `cloudflared_tunnel_timer_retries`: heartbeat retries should not trend upward continuously.
- `quic_client_smoothed_rtt` and `quic_client_lost_packets`: useful when diagnosing unstable QUIC/UDP paths.

`npm run network:check` also reports a **Memhub heuristic** for QUIC connection churn based on `quic_client_closed_connections` divided by connector uptime. This threshold is not a Cloudflare SLA or official alarm level; it exists to surface cases where QUIC repeatedly establishes successfully but then dies with `timeout: no recent network activity`, which may prevent `protocol=auto` from ever reaching its normal HTTP/2 fallback path.

The request-error metric is a process-lifetime counter. A non-zero value by itself is historical evidence, not proof that the connector is failing now. `network:check` samples the connector twice and fails on **new** request errors observed during the check; it still reports the cumulative counter for diagnostics.

If QUIC loss is persistently high, leave transport on `auto` so cloudflared can fall back to HTTP/2 instead of permanently forcing either protocol. If a firewall intentionally blocks UDP, forced `http2` is acceptable, but should be an environment-specific override rather than the Memhub default.

## Controlled QUIC versus HTTP/2 A/B

Do not switch protocols solely because a tunnel has ever reconnected. Use an A/B only when all of the following are true:

1. `cloudflared_tunnel_ha_connections` repeatedly falls below four or `quic_client_closed_connections` grows quickly relative to process age;
2. the connector journal contains repeated QUIC failures such as `timeout: no recent network activity`;
3. origin health is independently healthy, so the problem is not Memhub itself;
4. TCP egress to Cloudflare on port 7844 is known to work.

Baseline with the normal `auto` transport first:

```bash
npm run network:check -- --public-host memory.example.com --metrics 127.0.0.1:20241
```

For an A/B, temporarily add `--protocol http2` (or `TUNNEL_TRANSPORT_PROTOCOL=http2`) to the connector service, restart only that connector, collect the same health/latency/error metrics for a comparable window, then remove the override to return to `auto`. Compare at least:

- public health success rate and p50/max latency;
- `cloudflared_tunnel_ha_connections`;
- `cloudflared_tunnel_request_errors`;
- connector reconnect/register rate;
- QUIC inactivity errors in the `auto` window versus HTTP/2 connection errors in the test window.

Keep HTTP/2 only if it materially reduces reconnect/error rate without making latency or availability worse. Otherwise return to `auto`, which preserves Cloudflare's QUIC-first behavior plus automatic HTTP/2 fallback. TCP reachability to port 7844 is only a prerequisite; it does **not** prove that an HTTP/2 Tunnel can complete its TLS/edge registration. Treat 5xx responses, reduced HA, or repeated TLS handshake failures during the trial as an immediate rollback signal.

For loopback Memhub origins, reducing `connectTimeout` from Cloudflare's generic 30-second default to about 5 seconds is reasonable because a failed TCP connect to `127.0.0.1` should be surfaced quickly. This is independent of the edge transport protocol.

If `auto` repeatedly reconnects over QUIC without ever falling back, perform a controlled A/B test with `--protocol http2` on that connector. Compare public health latency, request errors, HA connection stability and reconnect count over the same observation window, then keep the protocol with the stronger evidence. Do not change the machine-wide proxy or firewall merely to make Tunnel prefer one transport.

## Dedicated recovery watchdog

Memhub ships an optional connector watchdog based on the same recovery pattern used by DevSpace Forge: observe the **dedicated** connector only, require repeated failure before restarting, suppress tunnel recovery when the local origin is unhealthy, enforce a restart cooldown, and verify recovery after the restart rather than treating `systemctl restart` as proof of health.

The Memhub variant also performs a full-body Landing probe. This catches the failure mode where Cloudflare has already returned HTTP 200 but the HTML stream stalls or terminates before the page body finishes, which a small `/health` request can miss.

Install it only on a host where Memhub owns a dedicated cloudflared service:

```bash
export MEMHUB_TUNNEL_WATCHDOG_PUBLIC_URL=https://memory.example.com/
export MEMHUB_TUNNEL_WATCHDOG_METRICS_URL=http://127.0.0.1:20241/metrics
export MEMHUB_TUNNEL_WATCHDOG_SERVICE=cloudflared.service
./deploy/install-tunnel-watchdog.sh
systemctl --user enable --now memhub-tunnel-watchdog.timer
```

The installed production watchdog for this project must set `MEMHUB_TUNNEL_WATCHDOG_PUBLIC_URL=https://memhub.sanqi.org/`.

The default policy is three consecutive observations before recovery and a ten-minute restart cooldown. Unknown/malformed connector metrics never trigger a restart. The watchdog restarts only the configured Tunnel service; it does not change the machine-wide proxy, firewall, DNS, or unrelated Cloudflare connectors.

## Availability boundary

One cloudflared connector already maintains multiple edge connections. Running a second Memhub origin is not currently an automatic HA solution because Memhub owns stateful local storage. Do not put two independent Memhub state roots behind the same hostname unless storage replication and write ownership are explicitly designed.
