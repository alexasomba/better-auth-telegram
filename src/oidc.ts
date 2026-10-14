import type { OAuthProvider } from "@better-auth/core/oauth2";
import {
  createAuthorizationURL,
  validateAuthorizationCode,
} from "@better-auth/core/oauth2";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  TELEGRAM_OIDC_AUTH_ENDPOINT,
  TELEGRAM_OIDC_ISSUER,
  TELEGRAM_OIDC_JWKS_URI,
  TELEGRAM_OIDC_PROVIDER_ID,
  TELEGRAM_OIDC_TOKEN_ENDPOINT,
} from "./constants";
import type {
  TelegramOIDCClaims,
  TelegramOIDCOptions,
  TelegramOIDCValidationFailure,
} from "./types";

function classifyJWTFailure(error: unknown): TelegramOIDCValidationFailure {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "jwt_validation_failed";
  }
  switch (error.code) {
    case "ERR_JWT_EXPIRED":
      return "jwt_expired";
    case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
      return "jwt_signature_invalid";
    case "ERR_JWKS_NO_MATCHING_KEY":
      return "jwks_no_matching_key";
    case "ERR_JWKS_TIMEOUT":
      return "jwks_timeout";
    case "ERR_JWT_CLAIM_VALIDATION_FAILED":
      if ("claim" in error && error.claim === "aud") return "jwt_audience_invalid";
      if ("claim" in error && error.claim === "iss") return "jwt_issuer_invalid";
      return "jwt_validation_failed";
    default:
      return "jwt_validation_failed";
  }
}

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

/** Normalize only an exact, safely representable Telegram user ID. */
function numericTelegramUserId(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
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

  function reportFailure(reason: TelegramOIDCValidationFailure): null {
    try {
      options.onValidationFailure?.(reason);
    } catch {
      // Diagnostics must never alter the authentication result.
    }
    return null;
  }

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
        const userId = numericTelegramUserId(profile.id);
        if (userId === null) {
          throw new Error(
            "Telegram OIDC profile has no valid numeric user ID."
          );
        }
        return userId;
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
      if (!tokens.idToken) return reportFailure("missing_id_token");
      if (!tokens.expectedIdTokenNonce) return reportFailure("missing_expected_nonce");
      if (!clientId) return reportFailure("missing_client_id");
      let claims: TelegramOIDCClaims;
      try {
        const { payload } = await jwtVerify(tokens.idToken, jwks, {
          issuer: TELEGRAM_OIDC_ISSUER,
          audience: clientId,
          algorithms: ["RS256", "ES256", "EdDSA"],
        });
        if (payload.nonce !== tokens.expectedIdTokenNonce) {
          return reportFailure("nonce_mismatch");
        }
        claims = payload as unknown as TelegramOIDCClaims;
      } catch (error) {
        return reportFailure(classifyJWTFailure(error));
      }
      if (typeof claims.sub !== "string" || !claims.sub) {
        return reportFailure("missing_subject");
      }
      if (options.accountIdClaim === "id") {
        if (claims.id === undefined || claims.id === null) {
          return reportFailure("missing_numeric_id");
        }
        const userId = numericTelegramUserId(claims.id);
        if (userId === null) return reportFailure("invalid_numeric_id");
        claims = { ...claims, id: userId };
      }

      const mapped = options.mapOIDCProfileToUser?.(claims);
      const mappedUserFields = { ...(mapped ?? {}) };
      // The mapper may add fields defined in Better Auth's user schema, but it
      // must not replace Better Auth's primary key or Telegram's unverified
      // email status.
      delete mappedUserFields.id;
      return {
        user: {
          ...mappedUserFields,
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
