import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { randomUUID, randomBytes } from "crypto";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { db } from "./db.js";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
];

// pendingAuths and authCodes now stored in Postgres to survive deploys

export class GmailOAuthProvider implements OAuthServerProvider {
  private serverBaseUrl: string;

  constructor(serverBaseUrl: string) {
    this.serverBaseUrl = serverBaseUrl;
  }

  private getGoogleCredentials(): {
    client_id: string;
    client_secret: string;
  } {
    const client_id = process.env.GOOGLE_CLIENT_ID;
    const client_secret = process.env.GOOGLE_CLIENT_SECRET;
    if (!client_id || !client_secret) {
      throw new Error(
        "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables are required."
      );
    }
    return { client_id, client_secret };
  }

  private createGoogleOAuth2Client(): OAuth2Client {
    const { client_id, client_secret } = this.getGoogleCredentials();
    return new google.auth.OAuth2(
      client_id,
      client_secret,
      `${this.serverBaseUrl}/google/callback`
    );
  }

  // ─── OAuthServerProvider implementation ───

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (
        clientId: string
      ): Promise<OAuthClientInformationFull | undefined> => {
        const result = await db.query(
          "SELECT * FROM oauth_clients WHERE client_id = $1",
          [clientId]
        );
        if (result.rows.length === 0) return undefined;
        const row = result.rows[0];
        return {
          client_id: row.client_id,
          client_secret: row.client_secret || undefined,
          client_name: row.client_name || undefined,
          redirect_uris: row.redirect_uris || [],
          grant_types: row.grant_types || undefined,
          response_types: row.response_types || undefined,
          token_endpoint_auth_method:
            row.token_endpoint_auth_method || undefined,
          client_id_issued_at: row.client_id_issued_at
            ? Number(row.client_id_issued_at)
            : undefined,
          client_secret_expires_at: row.client_secret_expires_at
            ? Number(row.client_secret_expires_at)
            : undefined,
        } as OAuthClientInformationFull;
      },

      registerClient: async (
        client: Omit<
          OAuthClientInformationFull,
          "client_id" | "client_id_issued_at"
        >
      ): Promise<OAuthClientInformationFull> => {
        const clientId = randomUUID();
        const issuedAt = Math.floor(Date.now() / 1000);

        await db.query(
          `INSERT INTO oauth_clients (client_id, client_secret, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method, client_id_issued_at, client_secret_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            clientId,
            (client as any).client_secret || null,
            (client as any).client_name || null,
            (client as any).redirect_uris || [],
            (client as any).grant_types || null,
            (client as any).response_types || null,
            (client as any).token_endpoint_auth_method || null,
            issuedAt,
            (client as any).client_secret_expires_at || null,
          ]
        );

        console.log(
          `Registered MCP client: ${clientId} (${(client as any).client_name || "unnamed"})`
        );

        return {
          ...client,
          client_id: clientId,
          client_id_issued_at: issuedAt,
        } as OAuthClientInformationFull;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const googleState = randomBytes(32).toString("hex");

    await db.query(
      `INSERT INTO oauth_pending_auths (google_state, mcp_client_id, mcp_redirect_uri, mcp_state, mcp_code_challenge)
       VALUES ($1, $2, $3, $4, $5)`,
      [googleState, client.client_id, params.redirectUri, params.state || null, params.codeChallenge]
    );

    const oauth2Client = this.createGoogleOAuth2Client();
    const googleAuthUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: GMAIL_SCOPES,
      prompt: "consent",
      state: googleState,
    });

    console.log(
      `Redirecting to Google OAuth for client ${client.client_id}`
    );
    res.redirect(googleAuthUrl);
  }

  async handleGoogleCallback(
    code: string,
    state: string
  ): Promise<{ redirectUrl: string }> {
    const pendingResult = await db.query(
      "SELECT * FROM oauth_pending_auths WHERE google_state = $1",
      [state]
    );
    if (pendingResult.rows.length === 0) {
      throw new Error("Invalid or expired OAuth state");
    }
    const pending = pendingResult.rows[0];
    await db.query("DELETE FROM oauth_pending_auths WHERE google_state = $1", [state]);

    const oauth2Client = this.createGoogleOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress!;

    const mcpAuthCode = randomBytes(32).toString("hex");
    await db.query(
      `INSERT INTO oauth_auth_codes (code, user_email, google_access_token, google_refresh_token, google_expiry_date, code_challenge, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        mcpAuthCode,
        email,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expiry_date,
        pending.mcp_code_challenge,
        pending.mcp_client_id,
      ]
    );

    const redirectUrl = new URL(pending.mcp_redirect_uri);
    redirectUrl.searchParams.set("code", mcpAuthCode);
    if (pending.mcp_state) {
      redirectUrl.searchParams.set("state", pending.mcp_state);
    }

    console.log(
      `Google OAuth complete for ${email}, redirecting to MCP client`
    );
    return { redirectUrl: redirectUrl.toString() };
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const codeResult = await db.query(
      "SELECT * FROM oauth_auth_codes WHERE code = $1",
      [authorizationCode]
    );
    if (codeResult.rows.length === 0) {
      throw new Error("Invalid authorization code");
    }
    return codeResult.rows[0].code_challenge;
  }

  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<OAuthTokens> {
    const codeResult = await db.query(
      "SELECT * FROM oauth_auth_codes WHERE code = $1",
      [authorizationCode]
    );
    if (codeResult.rows.length === 0) {
      throw new Error("Invalid authorization code");
    }
    const record = codeResult.rows[0];
    await db.query("DELETE FROM oauth_auth_codes WHERE code = $1", [authorizationCode]);

    const accessToken = randomBytes(32).toString("hex");
    const mcpRefreshToken = randomBytes(32).toString("hex");
    const expiresIn = 3600; // 1 hour
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    // Store both tokens in Postgres
    await db.query(
      `INSERT INTO oauth_tokens (token, token_type, client_id, user_email, google_access_token, google_refresh_token, google_expiry_date, scopes, expires_at, related_token)
       VALUES ($1, 'access', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        accessToken,
        record.client_id,
        record.user_email,
        record.google_access_token,
        record.google_refresh_token,
        record.google_expiry_date,
        ["gmail"],
        expiresAt,
        mcpRefreshToken,
      ]
    );

    await db.query(
      `INSERT INTO oauth_tokens (token, token_type, client_id, user_email, google_access_token, google_refresh_token, google_expiry_date, scopes, related_token)
       VALUES ($1, 'refresh', $2, $3, $4, $5, $6, $7, $8)`,
      [
        mcpRefreshToken,
        record.client_id,
        record.user_email,
        record.google_access_token,
        record.google_refresh_token,
        record.google_expiry_date,
        ["gmail"],
        accessToken,
      ]
    );

    console.log(`Issued MCP tokens for ${record.user_email}`);

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: mcpRefreshToken,
      scope: "gmail",
    };
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string
  ): Promise<OAuthTokens> {
    const result = await db.query(
      "SELECT * FROM oauth_tokens WHERE token = $1 AND token_type = 'refresh'",
      [refreshToken]
    );
    if (result.rows.length === 0) {
      throw new Error("Invalid refresh token");
    }

    const row = result.rows[0];

    // Delete old access + refresh tokens
    await db.query("DELETE FROM oauth_tokens WHERE token = $1", [
      row.related_token,
    ]);
    await db.query("DELETE FROM oauth_tokens WHERE token = $1", [refreshToken]);

    // Issue new tokens
    const newAccessToken = randomBytes(32).toString("hex");
    const newRefreshToken = randomBytes(32).toString("hex");
    const expiresIn = 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    await db.query(
      `INSERT INTO oauth_tokens (token, token_type, client_id, user_email, google_access_token, google_refresh_token, google_expiry_date, scopes, expires_at, related_token)
       VALUES ($1, 'access', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        newAccessToken,
        row.client_id,
        row.user_email,
        row.google_access_token,
        row.google_refresh_token,
        row.google_expiry_date,
        row.scopes,
        expiresAt,
        newRefreshToken,
      ]
    );

    await db.query(
      `INSERT INTO oauth_tokens (token, token_type, client_id, user_email, google_access_token, google_refresh_token, google_expiry_date, scopes, related_token)
       VALUES ($1, 'refresh', $2, $3, $4, $5, $6, $7, $8)`,
      [
        newRefreshToken,
        row.client_id,
        row.user_email,
        row.google_access_token,
        row.google_refresh_token,
        row.google_expiry_date,
        row.scopes,
        newAccessToken,
      ]
    );

    return {
      access_token: newAccessToken,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: newRefreshToken,
      scope: "gmail",
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const result = await db.query(
      "SELECT * FROM oauth_tokens WHERE token = $1 AND token_type = 'access' AND (expires_at IS NULL OR expires_at > NOW())",
      [token]
    );
    if (result.rows.length === 0) {
      throw new Error("Invalid access token");
    }

    const row = result.rows[0];
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes || ["gmail"],
      expiresAt: row.expires_at
        ? Math.floor(new Date(row.expires_at).getTime() / 1000)
        : undefined,
      extra: {
        email: row.user_email,
      },
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    // Also delete the related token (access ↔ refresh pair)
    const result = await db.query(
      "SELECT related_token FROM oauth_tokens WHERE token = $1",
      [request.token]
    );
    await db.query("DELETE FROM oauth_tokens WHERE token = $1", [
      request.token,
    ]);
    if (result.rows.length > 0 && result.rows[0].related_token) {
      await db.query("DELETE FROM oauth_tokens WHERE token = $1", [
        result.rows[0].related_token,
      ]);
    }
  }

  // ─── Gmail service for tool handlers ───

  async getGmailServiceForToken(token: string): Promise<{
    gmail: ReturnType<typeof google.gmail>;
    email: string;
  }> {
    const result = await db.query(
      "SELECT * FROM oauth_tokens WHERE token = $1 AND token_type = 'access'",
      [token]
    );
    if (result.rows.length === 0) {
      throw new Error(
        "Invalid or expired access token. Please re-authenticate."
      );
    }

    const row = result.rows[0];
    const oauth2Client = this.createGoogleOAuth2Client();
    oauth2Client.setCredentials({
      access_token: row.google_access_token,
      refresh_token: row.google_refresh_token,
      expiry_date: row.google_expiry_date
        ? Number(row.google_expiry_date)
        : undefined,
    });

    // Handle Google token refresh — persist new tokens to Postgres
    oauth2Client.on("tokens", async (newTokens) => {
      try {
        await db.query(
          `UPDATE oauth_tokens
           SET google_access_token = COALESCE($1, google_access_token),
               google_refresh_token = COALESCE($2, google_refresh_token),
               google_expiry_date = COALESCE($3, google_expiry_date)
           WHERE user_email = $4`,
          [
            newTokens.access_token || null,
            newTokens.refresh_token || null,
            newTokens.expiry_date || null,
            row.user_email,
          ]
        );
      } catch (err) {
        console.error("[Auth] Failed to persist refreshed Google tokens:", err);
      }
    });

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    return { gmail, email: row.user_email };
  }

  // Same shape as getGmailServiceForToken but keyed by user_email,
  // for admin/batch endpoints that don't have an MCP access token.
  async getGmailServiceForEmail(email: string): Promise<{
    gmail: ReturnType<typeof google.gmail>;
    email: string;
  }> {
    const result = await db.query(
      `SELECT * FROM oauth_tokens
       WHERE user_email = $1 AND google_refresh_token IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [email]
    );
    if (result.rows.length === 0) {
      throw new Error(
        `No stored Google refresh token for ${email}. Connect this account via the MCP OAuth flow first.`
      );
    }

    const row = result.rows[0];
    const oauth2Client = this.createGoogleOAuth2Client();
    oauth2Client.setCredentials({
      access_token: row.google_access_token,
      refresh_token: row.google_refresh_token,
      expiry_date: row.google_expiry_date
        ? Number(row.google_expiry_date)
        : undefined,
    });

    oauth2Client.on("tokens", async (newTokens) => {
      try {
        await db.query(
          `UPDATE oauth_tokens
           SET google_access_token = COALESCE($1, google_access_token),
               google_refresh_token = COALESCE($2, google_refresh_token),
               google_expiry_date = COALESCE($3, google_expiry_date)
           WHERE user_email = $4`,
          [
            newTokens.access_token || null,
            newTokens.refresh_token || null,
            newTokens.expiry_date || null,
            email,
          ]
        );
      } catch (err) {
        console.error("[Auth] Failed to persist refreshed Google tokens:", err);
      }
    });

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    return { gmail, email };
  }
}
