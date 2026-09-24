# Memhub identity linking

OAuth authorization and Memhub account identity are separate concerns.

- OAuth scopes answer **what this connection may do**.
- A verified provider identity answers **who is making the request**.
- `account_id` remains Memhub's stable internal identity and must never be chosen by the plugin client.

## Current Cloudflare Access flow

For the deployed remote MCP path, Cloudflare Access authenticates the human and Memhub verifies the Access JWT before creating an MCP runtime.

The verified identity contains:

- `sub`: stable provider subject;
- `email`: normalized authenticated email.

`resolveCloudflareAccount()` resolves that identity in this order:

1. Exact `sub` match. This is the normal steady-state path.
2. If no `sub` is pinned yet, exact normalized email match against an already-provisioned Memhub account.
3. On the email bootstrap match, pin the new `sub` to the existing `account_id`.
4. If neither matches, reject the request unless JIT account creation was explicitly enabled.

This means a ChatGPT/Codex plugin does not need to learn or choose a Memhub account ID. Once OAuth succeeds, the server resolves the authenticated principal before exposing project or memory data.

Existing accounts created without an email must first be linked administratively with `memhub-mcp account bind-email <username> <email>`. Email is only the first-link bootstrap key; subsequent requests use the stable provider subject.

## Provider-neutral OAuth rule

If Memhub later accepts OAuth directly from another authorization server instead of Cloudflare Access, keep the same contract with a provider-neutral key:

`(issuer, subject) -> account_id`

The resource server should validate the access token's issuer, audience, expiry and scopes, then obtain a verified identity from token claims or the provider's UserInfo/introspection endpoint. The linking algorithm is:

1. Match `(issuer, subject)` exactly.
2. If no binding exists and the provider supplies a verified email, match that email to exactly one pre-existing Memhub account and persist the `(issuer, subject)` binding.
3. Never use email as the permanent identity key because email addresses can change.
4. Never infer an account from OAuth scopes, plugin installation IDs, display names, or conversation metadata.
5. Reject ambiguous or unknown identities unless an administrator explicitly links them or JIT provisioning is enabled.

For providers that do not place email in the access token, Memhub must use a verified OIDC UserInfo/introspection response; the plugin host's permission grant alone is not sufficient identity evidence.

## Account-linking invariant

One external stable identity maps to exactly one Memhub `account_id`, and one verified email may bootstrap at most one active Memhub account. Account linking must not copy or move project/memory data: it only selects the existing account boundary.

