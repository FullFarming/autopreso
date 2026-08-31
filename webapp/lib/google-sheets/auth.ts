import { GoogleAuth, type GoogleAuthOptions } from "google-auth-library";

import type { GoogleSheetsConfig } from "../live/config";
import { GoogleSheetsRequestError } from "./errors";

export const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

type EnabledGoogleSheetsConfig = Extract<GoogleSheetsConfig, { enabled: true }>;

interface AccessTokenClient {
  getAccessToken(): Promise<string | { token?: string | null } | null>;
}

interface GoogleAuthLike {
  getClient(): Promise<AccessTokenClient>;
}

export function createGoogleAuthOptions(config: EnabledGoogleSheetsConfig): GoogleAuthOptions {
  return {
    credentials: {
      client_email: config.clientEmail,
      private_key: config.privateKey,
    },
    scopes: [GOOGLE_SHEETS_SCOPE],
  };
}

export function createGoogleSheetsAccessTokenProvider(
  config: EnabledGoogleSheetsConfig,
  auth: GoogleAuthLike = new GoogleAuth(createGoogleAuthOptions(config)) as GoogleAuthLike,
): () => Promise<string> {
  let clientPromise: Promise<AccessTokenClient> | null = null;
  return async () => {
    try {
      clientPromise ??= auth.getClient();
      const response = await (await clientPromise).getAccessToken();
      const token = typeof response === "string" ? response : response?.token;
      if (typeof token !== "string" || token.length < 1 || token.length > 8_192 || /\s/u.test(token)) {
        throw new GoogleSheetsRequestError("SHEETS_AUTH_FAILED");
      }
      return token;
    } catch (error: unknown) {
      if (error instanceof GoogleSheetsRequestError) throw error;
      throw new GoogleSheetsRequestError("SHEETS_AUTH_FAILED");
    }
  };
}
