# Dominds Auth (Design)

This document specifies the **authentication behavior** for Dominds WebUI + API access.

## Goals

- **Production safety**: prevent accidental exposure of a Dominds instance (especially when bound to non-localhost).
- **Low operational overhead**: a single shared secret, set once, used everywhere.
- **Good UX**: the WebUI can prompt for the key when needed and remember it for future visits.
- **Convenient “auto-auth”**: allow a one-click / copy-paste URL that pre-fills auth for the current session.

## Non-goals

- Multi-user accounts, roles/permissions, OAuth, SSO
- Key rotation workflows, audit logs, or fine-grained access control
- Authentication for development mode (explicitly disabled)

## Terminology

- **Auth key**: the shared secret used to authenticate requests.
- **Dev mode**: development runtime where auth is disabled.
- **Prod mode**: production runtime where auth behavior is enabled/controlled by environment.
- **Auto-auth URL**: a WebUI page URL that includes the auth key as a query parameter for automatic authentication.

## Mode Rules

### Dev mode

- **Auth is always disabled.**
- `DOMINDS_AUTH_KEY` (if present) has **no effect** in dev mode.

### Prod mode

Auth behavior is controlled by the `DOMINDS_AUTH_KEY` environment variable:

| `DOMINDS_AUTH_KEY` value | Effective behavior                                     |
| ------------------------ | ------------------------------------------------------ |
| **unset**                | **Enable auth** with a **randomly generated** auth key |
| **empty string**         | **Disable auth**                                       |
| **non-empty string**     | **Enable auth** using the provided string verbatim     |

Notes:

- The auth key is treated as an **opaque string** (no trimming, normalization, or case folding).
- A generated auth key MUST be **cryptographically strong** and **URL-safe to embed** (after URL encoding).

## Authentication Mechanism (Prod mode, when enabled)

- Every API request MUST authenticate using an HTTP `Authorization` header:
  - `Authorization: Bearer <auth-key>`

- “API request” includes:
  - HTTP endpoints that mutate or reveal workspace/dialog state
  - WebSocket connections used by the WebUI for real-time updates

Implementation note (WebUI): browsers cannot attach custom `Authorization` headers during the WebSocket handshake.
Dominds WebUI therefore transmits the auth key via `Sec-WebSocket-Protocol` as a subprotocol of the form
`dominds-auth.<auth-key>` (plain text), and the server accepts either mechanism.

To make this work without encoding, the auth key MUST be an HTTP token-safe string (RFC 7230 `tchar` set).

If auth is **disabled**, the server MUST accept requests and WebSocket connections without any auth header.
If an auth header is present while auth is disabled, the server MUST ignore it.

## Server-Side Auth Outcomes (Prod mode, when enabled)

The server enforces the following outcomes:

- If the auth header is **missing**, the request/connection MUST be rejected as unauthorized.
- If the auth header is **present but incorrect**, the request/connection MUST be rejected as unauthorized.
- If the auth header is **correct**, the request/connection proceeds normally.

The server SHOULD use a consistent “unauthorized” response so that clients can reliably detect auth failures.

## WebUI Behavior

### Sources of an auth key

The WebUI uses exactly one effective auth key at a time, chosen by this precedence order:

1. **URL query parameter** `auth` (auto-auth mode)
2. **Browser localStorage** (remembered key)
3. **User prompt input** (interactive entry)

### localStorage rules

- If the WebUI uses a key sourced from **localStorage**, it MUST attach that key to all API requests as a Bearer token.
- If the user **manually enters** a key (not sourced from the URL), the WebUI MUST:
  - Use it immediately for API requests
  - Persist it to **localStorage** for later use
- If the key in **localStorage** is rejected by the server, the WebUI MUST:
  - Prompt the user to enter a new key
  - Replace the stored key in localStorage after confirmed success of auth

### Auto-auth URL rules (`?auth=...`)

When an `auth` query parameter is present in the WebUI page URL:

- The WebUI MUST use the `auth` parameter value as the auth key for API requests.
- The WebUI MUST NOT read from localStorage.
- The WebUI MUST NOT write to localStorage.

If authentication fails while `auth` is present in the URL:

- The WebUI MUST remove the `auth` parameter from `window.location` (so it no longer appears in the address bar).
- After removal, the WebUI MUST transition into the normal interactive flow:
  - Prompt the user for an auth key (and then persist it to localStorage after success, as usual).

## CLI Requirements (WebUI subcommand)

### “Auto auth url” console output

When starting the WebUI server in **prod mode**:

- If auth is **enabled** (either generated or explicitly set), the WebUI subcommand MUST log an **“auto auth url”**
  string to the console that includes the auth key as a query parameter.

Example (illustrative):

```txt
auto auth url: http://<host>:<port>/?auth=<urlencoded-auth-key>
```

- If auth is **disabled**, the subcommand SHOULD log that auth is disabled and MUST NOT print an auth key.

### `--nobrowser`

By default, the WebUI subcommand opens a browser automatically.
To opt out, use `--nobrowser`:

- If auth is **enabled**, it MUST open the **auto-auth URL** in the default browser.
- If auth is **disabled**, it MUST open the normal WebUI URL (no `auth` parameter).

`--nobrowser` does not change authentication behavior; it only changes ergonomics.

## Security & Privacy Notes

- The auth key is a **shared secret**; anyone with the key has full access as permitted by the API surface.
- An auto-auth URL contains the auth key in the query string; this can leak via:
  - Copy/paste and screenshots
  - Browser history
  - Referrer headers (depending on navigation)
  - Logs or monitoring that capture URLs

Operators SHOULD treat the auto-auth URL as sensitive and avoid sharing it broadly.
