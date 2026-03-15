import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import * as fs from "fs";
import * as path from "path";
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

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
];

// ─── In-memory stores ───

interface PendingAuth {
  mcpClientId: string;
  mcpRedirectUri: string;
  mcpState?: string;
  mcpCodeChallenge: string;
  googleState: string;
}

interface TokenRecord {
  googleTokens: any;
  email: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
  refreshToken?: string;
}

export class GmailOAuthProvider implements OAuthServerProvider {
  private dataDir: string;
  private credentialsPath: string;

  // In-memory stores
  private clients: Map<string, OAuthClientInformationFull> = new Map();
  private pendingAuths: Map<string, PendingAuth> = new Map(); // googleState -> PendingAuth
  private authCodes: Map<string, { email: string; googleTokens: any; codeChallenge: string; clientId: string }> = new Map();
  private accessTokens: Map<string, TokenRecord> = new Map();
  private refreshTokens: Map<string, { accessToken: string; email: string; googleTokens: any; clientId: string }> = new Map();

  private serverBaseUrl: string;

  constructor(serverBaseUrl: string, dataDir?: string) {
    this.serverBaseUrl = serverBaseUrl;
    this.dataDir = dataDir || path.join(process.env.HOME || "~", ".gmail-mcp");
    this.credentialsPath = path.join(this.dataDir, "credentials.json");
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  getDataDir(): string {
    return this.dataDir;
  }

  private loadGoogleCredentials(): { client_id: string; client_secret: string } {
    if (!fs.existsSync(this.credentialsPath)) {
      throw new Error(
        `credentials.json not found at ${this.credentialsPath}. ` +
          `Download OAuth credentials from Google Cloud Console and place them there.`
      );
    }
    const creds = JSON.parse(fs.readFileSync(this.credentialsPath, "utf-8"));
    const key = creds.installed || creds.web;
    if (!key) {
      throw new Error("Invalid credentials.json format.");
    }
    return { client_id: key.client_id, client_secret: key.client_secret };
  }

  private createGoogleOAuth2Client(): OAuth2Client {
    const { client_id, client_secret } = this.loadGoogleCredentials();
    // Google redirects back to our server's /google/callback
    return new google.auth.OAuth2(
      client_id,
      client_secret,
      `${this.serverBaseUrl}/google/callback`
    );
  }

  // ─── OAuthServerProvider implementation ───

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.clients.get(clientId),
      registerClient: (client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) => {
        const clientId = randomUUID();
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        this.clients.set(clientId, full);
        console.log(`Registered MCP client: ${clientId} (${client.client_name || "unnamed"})`);
        return full;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    // Generate a unique state for Google OAuth that we'll use to link back
    const googleState = randomBytes(32).toString("hex");

    // Save the MCP client's params so we can redirect back after Google auth
    this.pendingAuths.set(googleState, {
      mcpClientId: client.client_id,
      mcpRedirectUri: params.redirectUri,
      mcpState: params.state,
      mcpCodeChallenge: params.codeChallenge,
      googleState,
    });

    // Redirect user to Google OAuth
    const oauth2Client = this.createGoogleOAuth2Client();
    const googleAuthUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: GMAIL_SCOPES,
      prompt: "consent",
      state: googleState,
    });

    console.log(`Redirecting to Google OAuth for client ${client.client_id}`);
    res.redirect(googleAuthUrl);
  }

  // Called by our /google/callback route
  async handleGoogleCallback(code: string, state: string): Promise<{ redirectUrl: string }> {
    const pending = this.pendingAuths.get(state);
    if (!pending) {
      throw new Error("Invalid or expired OAuth state");
    }
    this.pendingAuths.delete(state);

    // Exchange Google auth code for tokens
    const oauth2Client = this.createGoogleOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user email
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress!;

    // Save Google tokens to disk for persistence
    const tokenPath = path.join(this.dataDir, `${email.replace(/[^a-zA-Z0-9@.]/g, "_")}_token.json`);
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));

    // Generate an MCP auth code that maps to the Google tokens
    const mcpAuthCode = randomBytes(32).toString("hex");
    this.authCodes.set(mcpAuthCode, {
      email,
      googleTokens: tokens,
      codeChallenge: pending.mcpCodeChallenge,
      clientId: pending.mcpClientId,
    });

    // Auto-expire auth code after 5 minutes
    setTimeout(() => this.authCodes.delete(mcpAuthCode), 300000);

    // Build redirect URL back to MCP client
    const redirectUrl = new URL(pending.mcpRedirectUri);
    redirectUrl.searchParams.set("code", mcpAuthCode);
    if (pending.mcpState) {
      redirectUrl.searchParams.set("state", pending.mcpState);
    }

    console.log(`Google OAuth complete for ${email}, redirecting to MCP client`);
    return { redirectUrl: redirectUrl.toString() };
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const record = this.authCodes.get(authorizationCode);
    if (!record) {
      throw new Error("Invalid authorization code");
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<OAuthTokens> {
    const record = this.authCodes.get(authorizationCode);
    if (!record) {
      throw new Error("Invalid authorization code");
    }
    this.authCodes.delete(authorizationCode);

    // Create our own access token that maps to the Google tokens
    const accessToken = randomBytes(32).toString("hex");
    const mcpRefreshToken = randomBytes(32).toString("hex");
    const expiresIn = 3600; // 1 hour

    this.accessTokens.set(accessToken, {
      googleTokens: record.googleTokens,
      email: record.email,
      clientId: record.clientId,
      scopes: ["gmail"],
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    });

    this.refreshTokens.set(mcpRefreshToken, {
      accessToken,
      email: record.email,
      googleTokens: record.googleTokens,
      clientId: record.clientId,
    });

    console.log(`Issued MCP tokens for ${record.email}`);

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
    const record = this.refreshTokens.get(refreshToken);
    if (!record) {
      throw new Error("Invalid refresh token");
    }

    // Invalidate old access token
    this.accessTokens.delete(record.accessToken);

    // Reload Google tokens from disk (may have been refreshed)
    const email = record.email;
    const tokenPath = path.join(this.dataDir, `${email.replace(/[^a-zA-Z0-9@.]/g, "_")}_token.json`);
    let googleTokens = record.googleTokens;
    if (fs.existsSync(tokenPath)) {
      googleTokens = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
    }

    // Issue new access token
    const newAccessToken = randomBytes(32).toString("hex");
    const newRefreshToken = randomBytes(32).toString("hex");
    const expiresIn = 3600;

    this.accessTokens.set(newAccessToken, {
      googleTokens,
      email,
      clientId: record.clientId,
      scopes: ["gmail"],
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    });

    // Update refresh token mapping
    this.refreshTokens.delete(refreshToken);
    this.refreshTokens.set(newRefreshToken, {
      accessToken: newAccessToken,
      email,
      googleTokens,
      clientId: record.clientId,
    });

    return {
      access_token: newAccessToken,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: newRefreshToken,
      scope: "gmail",
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.accessTokens.get(token);
    if (!record) {
      throw new Error("Invalid access token");
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      extra: {
        email: record.email,
      },
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    this.accessTokens.delete(request.token);
    this.refreshTokens.delete(request.token);
  }

  // ─── Gmail service for tool handlers ───

  async getGmailServiceForToken(token: string): Promise<{
    gmail: ReturnType<typeof google.gmail>;
    email: string;
  }> {
    const record = this.accessTokens.get(token);
    if (!record) {
      throw new Error("Invalid or expired access token. Please re-authenticate.");
    }

    const oauth2Client = this.createGoogleOAuth2Client();
    oauth2Client.setCredentials(record.googleTokens);

    // Handle token refresh
    oauth2Client.on("tokens", (newTokens) => {
      record.googleTokens = { ...record.googleTokens, ...newTokens };
      // Persist refreshed tokens
      const tokenPath = path.join(
        this.dataDir,
        `${record.email.replace(/[^a-zA-Z0-9@.]/g, "_")}_token.json`
      );
      fs.writeFileSync(tokenPath, JSON.stringify(record.googleTokens, null, 2));
    });

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    return { gmail, email: record.email };
  }
}
