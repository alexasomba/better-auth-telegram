import type { OAuthProvider } from "@better-auth/core/oauth2";
import {
  createAuthorizationURL,
  validateAuthorizationCode,
} from "@better-auth/core/oauth2";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import {
  TELEGRAM_OIDC_AUTH_ENDPOINT,
  TELEGRAM_OIDC_ISSUER,
  TELEGRAM_OIDC_JWKS_URI,
  TELEGRAM_OIDC_PROVIDER_ID,
  TELEGRAM_OIDC_TOKEN_ENDPOINT,
} from "./constants";
import type { TelegramOIDCClaims, TelegramOIDCOptions } from "./types";

/** Build the permissions requested from Telegram. */
export function buildScopes(options: TelegramOIDCOptions): string[] {
  const scopes = new Set<string>(["openid"]);
  for (const scope of options.scopes ?? ["profile"]) {
    scopes.add(scope);
  }
  if (options.requestPhone) {
    scopes.add("phone");
  }
  if (options.requestBotAccess) {
    scopes.add("telegram:bot_access");
  }
  return [...scopes];
}

/** Telegram OIDC provider for Better Auth 1.7. */
export function createTelegramOIDCProvider(
  botToken: string,
  options: TelegramOIDCOptions = {}
): OAuthProvider<TelegramOIDCClaims> {
  const providerId = options.providerId ?? TELEGRAM_OIDC_PROVIDER_ID;
  const clientId = options.clientId ?? botToken.split(":")[0] ?? "";
  const clientSecret = options.clientSecret ?? "";
  const providerOptions = {
    clientId,
    clientSecret,
    disableIdTokenSignIn: true,
  };
  const jwks = createRemoteJWKSet(new URL(TELEGRAM_OIDC_JWKS_URI));

  function requireCredentials(): void {
    if (!(clientId && clientSecret)) {
      throw new Error(
        "[better-auth-telegram] OIDC requires the client ID and separate client secret from BotFather."
      );
    }
  }

  const provider: OAuthProvider<TelegramOIDCClaims> = {
    id: providerId,
    name: "Telegram",
    issuer: TELEGRAM_OIDC_ISSUER,
    requiresIdTokenNonce: true,
    idToken: {
      jwks,
      issuer: TELEGRAM_OIDC_ISSUER,
      audience: clientId,
      algorithms: ["RS256", "ES256", "EdDSA"],
    },
    accountSubject: ({ profile }) => {
      if (options.accountIdClaim === "id") {
        if (
          typeof profile.id !== "number" ||
          !Number.isSafeInteger(profile.id) ||
          profile.id <= 0
        ) {
          throw new Error(
            "Telegram OIDC profile has no valid numeric user ID."
          );
        }
        return profile.id;
      }
      if (typeof profile.sub !== "string" || !profile.sub) {
        throw new Error("Telegram OIDC profile has no subject.");
      }
      return profile.sub;
    },
    createAuthorizationURL({
      state,
      codeVerifier,
      scopes,
      redirectURI,
      idTokenNonce,
      additionalParams,
    }) {
      requireCredentials();
      if (!idTokenNonce) {
        throw new Error("Telegram OIDC requires an authorization nonce.");
      }
      return createAuthorizationURL({
        id: providerId,
        options: providerOptions,
        authorizationEndpoint: TELEGRAM_OIDC_AUTH_ENDPOINT,
        scopes: [...new Set([...buildScopes(options), ...(scopes ?? [])])],
        state,
        codeVerifier,
        redirectURI,
        nonce: idTokenNonce,
        additionalParams,
      });
    },
    validateAuthorizationCode({ code, codeVerifier, redirectURI }) {
      requireCredentials();
      return validateAuthorizationCode({
        code,
        codeVerifier,
        redirectURI,
        options: providerOptions,
        tokenEndpoint: TELEGRAM_OIDC_TOKEN_ENDPOINT,
        authentication: "basic",
      });
    },
    async getUserInfo(tokens) {
      if (!(tokens.idToken && tokens.expectedIdTokenNonce && clientId)) {
        return null;
      }
      try {
        const { payload } = await jwtVerify(tokens.idToken, jwks, {
          issuer: TELEGRAM_OIDC_ISSUER,
          audience: clientId,
          algorithms: ["RS256", "ES256", "EdDSA"],
        });
        if (payload.nonce !== tokens.expectedIdTokenNonce) {
          return null;
        }
      } catch {
        return null;
      }
      let claims: TelegramOIDCClaims;
      try {
        claims = decodeJwt<TelegramOIDCClaims>(tokens.idToken);
      } catch {
        return null;
      }
      if (typeof claims.sub !== "string" || !claims.sub) {
        return null;
      }
      if (
        options.accountIdClaim === "id" &&
        (typeof claims.id !== "number" ||
          !Number.isSafeInteger(claims.id) ||
          claims.id <= 0)
      ) {
        return null;
      }

      const mapped = options.mapOIDCProfileToUser?.(claims);
      return {
        user: {
          name: mapped?.name ?? claims.name,
          image: mapped?.image ?? claims.picture,
          email: mapped?.email ?? `${claims.sub}@telegram.oidc`,
          emailVerified: false,
        },
        data: claims,
      };
    },
    options: providerOptions,
  };

  return provider;
}
