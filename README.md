# Better Auth Telegram

[![npm version](https://img.shields.io/npm/v/better-auth-telegram)](https://www.npmjs.com/package/better-auth-telegram)
[![npm downloads](https://img.shields.io/npm/dm/better-auth-telegram)](https://www.npmjs.com/package/better-auth-telegram)
[![CI](https://github.com/vcode-sh/better-auth-telegram/actions/workflows/ci.yml/badge.svg)](https://github.com/vcode-sh/better-auth-telegram/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/vcode-sh/better-auth-telegram/branch/main/graph/badge.svg)](https://codecov.io/gh/vcode-sh/better-auth-telegram)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Telegram authentication plugin for [Better Auth](https://better-auth.com). Login Widget. Mini Apps. OIDC. Link/unlink. HMAC-SHA-256 verification. The whole circus.

Built on Web Crypto API — works in Node, Bun, Cloudflare Workers, and whatever edge runtime you're pretending to need. No `node:crypto` tantrums.

344 tests. If it breaks, roast me on [X](https://x.com/vcode_sh). If it works, also roast me. I'm there either way, posting through the pain.

## Requirements

- Node.js >= 24 (as declared by this package), or a supported runtime with Web Crypto API
- `better-auth@>=1.7.6 <1.8.0`

## Install

```bash
npm install better-auth-telegram
```

## Setup

### 1. Talk to a bot to create a bot

Message [@BotFather](https://t.me/botfather), send `/newbot`, save the token, then `/setdomain` with your domain.

For local dev you'll need [ngrok](https://ngrok.com) because Telegram demands HTTPS. Localhost? Never heard of it.

### 2. Server

```typescript
import { betterAuth } from "better-auth";
import { telegram } from "better-auth-telegram";

export const auth = betterAuth({
  plugins: [
    telegram({
      botToken: process.env.TELEGRAM_BOT_TOKEN!,
      botUsername: "your_bot_username", // without @
    }),
  ],
});
```

### 3. Client

```typescript
import { createAuthClient } from "better-auth/client";
import { telegramClient } from "better-auth-telegram/client";

export const authClient = createAuthClient({
  fetchOptions: {
    credentials: "include", // required when widget link/unlink uses cross-origin requests
  },
  plugins: [telegramClient()],
});
```

### 4. Database

The plugin adds `telegramId`, `telegramUsername`, and `telegramPhoneNumber` to the `user` table, and `telegramId` and `telegramUsername` to `account` when Login Widget or Mini App flows are enabled (the default). OIDC-only setups (`loginWidget: false`) skip these fields entirely. If using Prisma:

```prisma
model User {
  // ... existing fields
  telegramId          String?
  telegramUsername    String?
  telegramPhoneNumber String?  // persist claims.phone_number via a custom OIDC mapper
}

model Account {
  // ... existing fields
  telegramId       String?
  telegramUsername  String?
}
```

Then `npx prisma migrate dev` and pray.

## Usage

### Sign in

```tsx
authClient.initTelegramWidget(
  "telegram-login-container",
  { size: "large", cornerRadius: 20 },
  async (authData) => {
    const result = await authClient.signInWithTelegram(authData);
    if (!result.error) router.push("/dashboard");
  }
);
```

### Link / Unlink

```typescript
// link (user must be authenticated)
await authClient.linkTelegram(authData);

// unlink
await authClient.unlinkTelegram();
```

Getting "Not authenticated"? You forgot `credentials: "include"`. Go back to [Client setup](#3-client).

All API-calling client methods accept an optional `fetchOptions` parameter for custom headers, cache control, etc:

```typescript
await authClient.signInWithTelegram(authData, {
  headers: { "x-custom-header": "value" },
});
```

### Redirect flow

```typescript
authClient.initTelegramWidgetRedirect(
  "telegram-login-container",
  "/auth/telegram/callback",
  { size: "large" }
);
```

### Mini Apps

Enable on server:

```typescript
telegram({
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  botUsername: "your_bot_username",
  miniApp: {
    enabled: true,
    validateInitData: true,
    allowAutoSignin: true,
  },
});
```

Then on client:

```typescript
// auto sign-in (one less click, revolutionary)
const result = await authClient.autoSignInFromMiniApp();

// or manual
const result = await authClient.signInWithMiniApp(
  window.Telegram.WebApp.initData
);

// or just validate without signing in
const validation = await authClient.validateMiniApp(
  window.Telegram.WebApp.initData
);
```

### OIDC (OpenID Connect)

Standard OAuth 2.0 flow via `oauth.telegram.org`. Phone numbers, PKCE, and signed JWTs — proper grown-up auth instead of widget callbacks. Telegram now labels the old iframe widget as legacy, so use OIDC for new browser integrations.

#### Prerequisites

1. Open [@BotFather](https://t.me/botfather), select your bot, and open **Login Widget**.
2. Register your website origin (for example, `https://example.com`) and the exact Better Auth callback URL (for example, `https://example.com/api/auth/callback/telegram-oidc`) as Allowed URLs.
3. Copy the Client ID and Client Secret shown there. The Client Secret is separate from your bot token.

For local dev, point both URLs at your [ngrok](https://ngrok.com) tunnel (e.g., `https://abc123.ngrok-free.app` and `https://abc123.ngrok-free.app/api/auth/callback/telegram-oidc`). Every time ngrok restarts, you get a new URL. Update BotFather. Repeat until Stockholm syndrome sets in.

See [Telegram's official OIDC docs](https://core.telegram.org/bots/telegram-login) for the spec. It exists now. We're living in the future.

#### Setup

Enable on server:

```typescript
telegram({
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  botUsername: "your_bot_username",
  oidc: {
    enabled: true,
    clientId: process.env.TELEGRAM_OIDC_CLIENT_ID!,
    clientSecret: process.env.TELEGRAM_OIDC_CLIENT_SECRET!, // from BotFather Web Login
    // requestPhone: true, // opt in only if your app needs a phone number
  },
});
```

Then on client:

```typescript
await authClient.signInWithTelegramOIDC({
  callbackURL: "/dashboard",
});
```

That's it. Standard Better Auth social login under the hood. PKCE, state tokens, the works. You don't even need to think about it, which is the whole point.

`signInWithTelegramOIDC()` currently uses the default `telegram-oidc` provider ID. If
you set `oidc.providerId` to another value, call Better Auth's social methods with
that value instead. Register the matching exact callback URL in BotFather:

```typescript
// With oidc.providerId: "telegram" on the server:
await authClient.signIn.social({
  provider: "telegram",
  callbackURL: "/dashboard",
});
// BotFather redirect URI: https://example.com/api/auth/callback/telegram
```

#### Link OIDC to an existing Better Auth account

Telegram OIDC supplies no verified email. This plugin gives Better Auth a placeholder
email and leaves `emailVerified` false. Better Auth therefore rejects explicit
`linkSocial` calls unless Telegram is a trusted provider; it also rejects a link to
an account with a different email unless `allowDifferentEmails` is enabled:

```typescript
// Better Auth server configuration, alongside the telegram(...) plugin:
export const auth = betterAuth({
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["telegram"], // use your oidc.providerId here
      allowDifferentEmails: true,
    },
  },
  plugins: [telegram({
    loginWidget: false,
    oidc: {
      enabled: true,
      clientId: process.env.TELEGRAM_OIDC_CLIENT_ID!,
      clientSecret: process.env.TELEGRAM_OIDC_CLIENT_SECRET!,
      providerId: "telegram",
    },
  })],
});
```

Then, from a signed-in client with `oidc.providerId: "telegram"`:

```typescript
await authClient.linkSocial({
  provider: "telegram",
  callbackURL: "/account",
});
```

`allowDifferentEmails` applies to all providers in that Better Auth instance.
Only enable it when your app permits an authenticated user to explicitly link a
different provider email. Keep placeholder addresses unverified and exclude them
from email delivery. An identity already linked to another user cannot be linked
again; resolve that account conflict separately.

#### OIDC-only mode

Don't need the Login Widget? Set `loginWidget: false` and skip the widget endpoints, rate limits, and the 5 Telegram-specific database columns entirely. Pure OIDC, no baggage:

```typescript
// OIDC-only (no widget endpoints, no extra schema fields)
telegram({
  loginWidget: false,
  oidc: {
    enabled: true,
    clientId: process.env.TELEGRAM_OIDC_CLIENT_ID!,
    clientSecret: process.env.TELEGRAM_OIDC_CLIENT_SECRET!,
  },
});
```

When using only Better Auth's `signIn.social()` and `linkSocial()` for OIDC,
the `telegramClient()` client plugin is optional. Add it if you use
`signInWithTelegramOIDC()` or the plugin's Widget and Mini App client methods.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `botToken` | — | Required at runtime for Login Widget and Mini App HMAC verification; can provide the OIDC client ID fallback |
| `botUsername` | — | Required only when rendering the Login Widget; without the @ |
| `allowUserToLink` | `true` | Let users link Telegram to existing accounts |
| `autoCreateUser` | `true` | Create user on first sign-in |
| `maxAuthAge` | `86400` | Auth data TTL in seconds (replay attack prevention) |
| `testMode` | `false` | Enable Telegram test server mode |
| `loginWidget` | `true` | Enable Login Widget endpoints and schema fields |
| `mapTelegramDataToUser` | — | Custom user data mapper |
| `miniApp.enabled` | `false` | Enable Mini Apps endpoints |
| `miniApp.validateInitData` | `true` | Verify Mini App initData |
| `miniApp.allowAutoSignin` | `true` | Allow auto sign-in from Mini Apps |
| `miniApp.mapMiniAppDataToUser` | — | Custom Mini App user mapper |
| `oidc.enabled` | `false` | Enable Telegram OIDC flow |
| `oidc.clientId` | — | Client ID from BotFather Web Login; falls back to the bot ID in `botToken` |
| `oidc.clientSecret` | — | Required Client Secret from BotFather Web Login (not the bot token) |
| `oidc.providerId` | `telegram-oidc` | Better Auth provider ID; use an existing Telegram provider ID to share accounts |
| `oidc.accountIdClaim` | `sub` | Use `id` to match existing Widget or Mini App account IDs |
| `oidc.scopes` | `["openid", "profile"]` | OIDC scopes to request |
| `oidc.requestPhone` | `false` | Request phone number (adds `phone` scope) |
| `oidc.requestBotAccess` | `false` | Request bot access (adds `telegram:bot_access` scope) |
| `oidc.mapOIDCProfileToUser` | — | Custom OIDC claims mapper |

Full types in [`src/types.ts`](./src/types.ts).

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/telegram/signin` | No | Sign in with widget data (when `loginWidget` enabled) |
| POST | `/telegram/link` | Session | Link Telegram to account (when `loginWidget` enabled) |
| POST | `/telegram/unlink` | Session | Unlink Telegram (when `loginWidget` enabled) |
| GET | `/telegram/config` | No | Get bot config (username, testMode, flags) |
| POST | `/telegram/miniapp/signin` | No | Sign in from Mini App |
| POST | `/telegram/miniapp/validate` | No | Validate initData |

OIDC uses Better Auth's social login routes: `POST /sign-in/social` and `GET /callback/<providerId>`. The default provider ID is `telegram-oidc`; configure `oidc.providerId` when joining an existing Telegram account namespace.

All endpoints are rate-limited. Signin/miniapp: 10 req/60s. Link/unlink: 5 req/60s. Validate: 20 req/60s. Brute-forcing was never a strategy, now it's also a throttled one.

## Error Handling

All endpoints throw `APIError` via `APIError.from()`. The plugin exposes `$ERROR_CODES` — each code is a `RawError` object with `code` and `message` properties:

```typescript
import { telegram } from "better-auth-telegram";

const plugin = telegram({ botToken: "...", botUsername: "..." });

// In your error handler:
if (error.code === plugin.$ERROR_CODES.NOT_AUTHENTICATED.code) {
  // handle it
}
```

No more comparing against magic strings. You're welcome.

## Security

HMAC-SHA-256 verification on all auth data via Web Crypto API (`crypto.subtle`). Timestamp validation against replay attacks. Bot token never touches the client. Works in every runtime that implements the Web Crypto standard — which is all of them now, congratulations internet.

Login Widget uses `SHA256(botToken)` as secret key. Mini Apps use `HMAC-SHA256("WebAppData", botToken)`. Different derivation paths, same level of paranoia.

OIDC verifies Telegram's `RS256`, `ES256`, and `EdDSA` JWT signatures via its JWKS endpoint, checks issuer, audience, expiry and request nonce, and uses PKCE and state for the authorization code flow. The token exchange uses HTTP Basic authentication with the separate OIDC client secret.

Is it bulletproof? No. Is it better than storing passwords in plain text? Significantly.

## Troubleshooting

**Widget not showing?** Did you `/setdomain` with @BotFather? Is `botUsername` correct (no @)? Does the container exist in DOM? Are you on HTTPS?

**Auth fails?** Wrong bot token, domain mismatch with BotFather, or `auth_date` expired (24h default). Check browser console.

**Local dev?** `ngrok http 3000`, use the ngrok URL in BotFather's `/setdomain` and as your app URL. Yes, it's annoying. Welcome to OAuth.

**OIDC returns `invalid_client`?** You haven't registered Web Login in @BotFather (Bot Settings > Web Login). Or you're using the bot token as client secret instead of the separate secret BotFather provides. See [OIDC Prerequisites](#prerequisites).

**OIDC redirects with `#tgAuthResult` instead of `?code=`?** Your redirect URI isn't registered in BotFather's Web Login Allowed URLs. Telegram falls back to Login Widget redirect mode. Register `https://yourdomain.com/api/auth/callback/telegram-oidc` in the Allowed URLs.

## Examples

See [`examples/nextjs-app/`](./examples/nextjs-app) for a Next.js implementation covering all three auth flows: Login Widget, OIDC, Mini Apps, plus account linking/unlinking. Copy-paste-ready components and server/client setup. There's also a full test playground app in [`test/`](./test) if you want to see everything wired together with a real database.

## Migrating

### To v2.0.0 (from v1.5.0)

- Upgrade Better Auth to `>=1.6.22 <1.7.0`. Better Auth 1.7 is not supported by this release.
- `botToken` and `botUsername` are now flow-aware. Missing values log setup warnings; the affected Widget, Mini App, or OIDC operation rejects if the credential is still missing when used.
- OIDC-only setups can omit both bot fields when `oidc.clientId` and `oidc.clientSecret` are configured explicitly.

### To v1.5.0 (from v1.4.0)

- No breaking changes. New `loginWidget` option defaults to `true` — existing setups are unaffected.
- OIDC-only users can now set `loginWidget: false` to skip Widget endpoints and the 5 Telegram-specific database columns (`telegramId`, `telegramUsername`, `telegramPhoneNumber` on user; `telegramId`, `telegramUsername` on account).
- Config endpoint now returns `loginWidgetEnabled` boolean. Client `getTelegramConfig` type updated accordingly.

### To v1.4.0 (from v1.3.x)

- **OIDC users**: Add `oidc.clientSecret` — the Client Secret from BotFather's Web Login settings (Bot Settings > Web Login). This is NOT the bot token. Register your Allowed URLs there too, including `https://yourdomain.com/api/auth/callback/telegram-oidc`. The plugin falls back to bot token if `clientSecret` is omitted (with a warning), but Telegram rejects bot tokens as OIDC client secrets. Removed non-standard `origin` and `bot_id` params from the auth URL. See [OIDC Prerequisites](#prerequisites).
- Login Widget and Mini App flows are unaffected.

### To v1.3.x (from v1.2.0)

- No breaking changes. v1.3.x added graceful `verifyIdToken` failure, placeholder email generation, diagnostic `getUserInfo` logging, and `origin` param (now removed in v1.4.0). If you're using OIDC, skip straight to v1.4.0.

### To v1.2.0 (from v1.1.0)

- No breaking changes. `testMode` is opt-in (default `false`). `BetterAuthPluginRegistry` module augmentation is type-only — zero runtime impact. Config endpoint now returns `testMode` boolean. Your existing code doesn't care.

### To v1.1.0 (from v1.0.0)

- **Peer dep bumped to `better-auth@^1.5.0`** — upgrade better-auth first, then update the plugin. The `$ERROR_CODES` type changed from `Record<string, string>` to `Record<string, RawError>` and this release follows suit.

### To v1.0.0 (from v0.4.0)

- No breaking changes. OIDC is opt-in (`oidc.enabled: false` by default). Add `telegramPhoneNumber` column to your user table if you plan to use OIDC with phone scope.

### To v0.4.0 (from v0.3.x)

- **Verification functions are now async** — `verifyTelegramAuth()` and `verifyMiniAppInitData()` return `Promise<boolean>`. Slap an `await` in front if you're calling them directly.
- **Errors throw `APIError`** — all endpoints throw `APIError` instead of returning `ctx.json({ error })`. Switch to Better Auth's standard error shape.
- **ESM-first** — `"type": "module"` in package.json. CJS still works via `.cjs` exports.

Full changelog in [CHANGELOG.md](./CHANGELOG.md).

## Links

- [Better Auth](https://better-auth.com)
- [Telegram Login Widget](https://core.telegram.org/widgets/login)
- [Telegram Mini Apps](https://core.telegram.org/bots/webapps)
- [Telegram OIDC](https://core.telegram.org/bots/features#oidc-authorization)
- [GitHub](https://github.com/vcode-sh/better-auth-telegram)
- [Changelog](./CHANGELOG.md)

## License

MIT — do whatever you want. I'm not your lawyer.

Created by [Vibe Code](https://x.com/vcode_sh).
