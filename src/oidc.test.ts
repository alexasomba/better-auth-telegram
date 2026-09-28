import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TELEGRAM_OIDC_ISSUER } from "./constants";
import { telegram } from "./index";
import { buildScopes, createTelegramOIDCProvider } from "./oidc";
import type { TelegramOIDCClaims } from "./types";

const CLIENT_ID = "123456789";
const CLIENT_SECRET = "botfather-oidc-secret";
const NONCE = "nonce-from-better-auth-state";

function provider(
  options: Parameters<typeof createTelegramOIDCProvider>[1] = {}
) {
  return createTelegramOIDCProvider("123456789:bot-token", {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    ...options,
  });
}

function profile(
  options: Partial<TelegramOIDCClaims> = {}
): TelegramOIDCClaims {
  return {
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    iss: TELEGRAM_OIDC_ISSUER,
    sub: "long-oidc-subject",
    id: 900001,
    name: "Telegram Member",
    ...options,
  };
}

describe("Telegram OIDC provider for Better Auth 1.7", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests only the configured scopes", () => {
    expect(buildScopes({})).toEqual(["openid", "profile"]);
    expect(buildScopes({ requestPhone: true, requestBotAccess: true })).toEqual(
      ["openid", "profile", "phone", "telegram:bot_access"]
    );
  });

  it("binds the redirect to state, PKCE, and an OIDC nonce", async () => {
    const telegramProvider = provider({
      providerId: "telegram",
      accountIdClaim: "id",
    });
    const url = await telegramProvider.createAuthorizationURL({
      state: "server-state",
      codeVerifier: "server-verifier",
      idTokenNonce: NONCE,
      redirectURI: "https://clearaccess.app/api/auth/callback/telegram",
    });
    expect(telegramProvider.id).toBe("telegram");
    expect(telegramProvider.issuer).toBe(TELEGRAM_OIDC_ISSUER);
    expect(telegramProvider.requiresIdTokenNonce).toBe(true);
    expect(telegramProvider.options?.disableIdTokenSignIn).toBe(true);
    expect(url.origin).toBe("https://oauth.telegram.org");
    expect(url.searchParams.get("state")).toBe("server-state");
    expect(url.searchParams.get("nonce")).toBe(NONCE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://clearaccess.app/api/auth/callback/telegram"
    );
  });

  it("rejects OIDC login without BotFather's separate client secret", () => {
    const telegramProvider = createTelegramOIDCProvider("123456789:bot-token", {
      clientId: CLIENT_ID,
    });
    expect(() =>
      telegramProvider.createAuthorizationURL({
        state: "state",
        codeVerifier: "verifier",
        idTokenNonce: NONCE,
        redirectURI: "https://clearaccess.app/api/auth/callback/telegram",
      })
    ).toThrow("separate client secret");
  });

  it("uses the signed numeric ID to reuse Widget and Mini App accounts", async () => {
    const telegramProvider = provider({
      providerId: "telegram",
      accountIdClaim: "id",
    });
    expect(
      await telegramProvider.accountSubject({ tokens: {}, profile: profile() })
    ).toBe(900001);
    expect(
      await telegramProvider.accountSubject({
        tokens: {},
        profile: profile({ id: "900001" }),
      })
    ).toBe(900001);
    expect(() =>
      telegramProvider.accountSubject({
        tokens: {},
        profile: profile({ id: undefined }),
      })
    ).toThrow("numeric user ID");
    for (const id of ["0900001", "9e5", "900001.0", "9007199254740992"]) {
      expect(() =>
        telegramProvider.accountSubject({
          tokens: {},
          profile: profile({ id }),
        })
      ).toThrow("numeric user ID");
    }
    expect(
      await provider().accountSubject({ tokens: {}, profile: profile() })
    ).toBe("long-oidc-subject");
  });

  describe("signed identity token", () => {
    let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
    let jwks: { keys: Record<string, unknown>[] };

    beforeEach(async () => {
      const keyPair = await generateKeyPair("RS256");
      privateKey = keyPair.privateKey;
      jwks = {
        keys: [
          {
            ...(await exportJWK(keyPair.publicKey)),
            kid: "telegram-key",
            alg: "RS256",
            use: "sig",
          },
        ],
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify(jwks), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
        )
      );
    });

    function signedToken(
      overrides: Record<string, unknown> = {},
      audience = CLIENT_ID
    ) {
      return new SignJWT({
        sub: "long-oidc-subject",
        id: 900001,
        name: "Telegram Member",
        nonce: NONCE,
        ...overrides,
      })
        .setProtectedHeader({ alg: "RS256", kid: "telegram-key" })
        .setIssuedAt()
        .setExpirationTime("1h")
        .setIssuer(TELEGRAM_OIDC_ISSUER)
        .setAudience(audience)
        .sign(privateKey);
    }

    it("accepts a signed token and preserves an unverified placeholder email", async () => {
      const telegramProvider = provider({
        providerId: "telegram",
        accountIdClaim: "id",
        mapOIDCProfileToUser: (claims) => ({
          email: `telegram-${claims.id}@telegram.clearaccess.invalid`,
        }),
      });
      const result = await telegramProvider.getUserInfo({
        idToken: await signedToken(),
        expectedIdTokenNonce: NONCE,
      });
      expect(result?.data.id).toBe(900001);
      expect(result?.user.email).toBe(
        "telegram-900001@telegram.clearaccess.invalid"
      );
      expect(result?.user.emailVerified).toBe(false);
    });

    it("normalizes a signed decimal ID to the existing Telegram account key", async () => {
      const telegramProvider = provider({
        accountIdClaim: "id",
        mapOIDCProfileToUser: (claims) => ({
          email: `telegram-${claims.id}@telegram.clearaccess.invalid`,
        }),
      });
      const result = await telegramProvider.getUserInfo({
        idToken: await signedToken({ id: "900001" }),
        expectedIdTokenNonce: NONCE,
      });
      expect(result?.data.id).toBe(900001);
      expect(result?.user.email).toBe(
        "telegram-900001@telegram.clearaccess.invalid"
      );
      expect(
        await telegramProvider.accountSubject({
          tokens: {},
          profile: result?.data ?? profile({ id: undefined }),
        })
      ).toBe(900001);
    });

    it("reports a missing profile ID without falling back to the OIDC subject", async () => {
      const onValidationFailure = vi.fn();
      const telegramProvider = provider({ accountIdClaim: "id", onValidationFailure });
      expect(
        await telegramProvider.getUserInfo({
          idToken: await signedToken({ id: undefined }),
          expectedIdTokenNonce: NONCE,
        })
      ).toBeNull();
      expect(onValidationFailure).toHaveBeenCalledWith("missing_numeric_id");
    });

    it("rejects a missing or mismatched nonce", async () => {
      const telegramProvider = provider();
      const idToken = await signedToken();
      expect(await telegramProvider.getUserInfo({ idToken })).toBeNull();
      expect(
        await telegramProvider.getUserInfo({
          idToken,
          expectedIdTokenNonce: "different-nonce",
        })
      ).toBeNull();
    });

    it("rejects a wrong audience, unsigned payload, and missing numeric ID", async () => {
      const telegramProvider = provider({ accountIdClaim: "id" });
      expect(
        await telegramProvider.getUserInfo({
          idToken: await signedToken({}, "other-client"),
          expectedIdTokenNonce: NONCE,
        })
      ).toBeNull();
      expect(
        await telegramProvider.getUserInfo({
          idToken: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJmb3JnZWQifQ.",
          expectedIdTokenNonce: NONCE,
        })
      ).toBeNull();
      expect(
        await telegramProvider.getUserInfo({
          idToken: await signedToken({ id: undefined }),
          expectedIdTokenNonce: NONCE,
        })
      ).toBeNull();
    });
  });

  it("allows OIDC-only setup alongside a separate Mini App auth plugin", () => {
    const plugin = telegram({
      loginWidget: false,
      oidc: {
        enabled: true,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        providerId: "telegram",
        accountIdClaim: "id",
      },
    });
    expect(plugin.schema).toBeUndefined();
    expect(plugin.endpoints).not.toHaveProperty("signInWithTelegram");
    expect(plugin.init).toBeDefined();
  });
});
