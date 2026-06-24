/**
 * ADA Digital Reach MCP — HTTP Server (Streamable HTTP Transport)
 *
 * Exposes the MCP server over HTTP for remote clients like Claude.ai
 * custom connectors. Uses Express + StreamableHTTPServerTransport.
 *
 * Environment variables:
 *   PORT              — HTTP port (default: 4000)
 *   MCP_AUTH_TOKEN    — Bearer token for authenticating requests (optional in dev)
 *   MCP_ALLOWED_ORIGINS — Comma-separated allowed origins, or "*" (default: "*")
 */

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./index.js";
import crypto from "crypto";
import { requestContext } from "./context.js";
import axios from "axios";

// ─── Express App Setup ──────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cache for OAuth authorization codes and user sessions
const authCodes = new Map();
const userSessions = new Map(); // token -> { username, password }

// ─── Health Check & OAuth Discovery ─────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server: "ada-digital-reach-mcp-server",
    version: "2.0.1",
    transport: "streamable-http",
    timestamp: new Date().toISOString(),
  });
});

app.get([
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource"
], (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"]
  });
});

// ─── Origin Validation Middleware ───────────────────────────────────────────

function originValidation(req, res, next) {
  const allowedOriginsEnv = process.env.MCP_ALLOWED_ORIGINS || "*";

  // Skip origin validation in permissive mode
  if (allowedOriginsEnv.trim() === "*") {
    return next();
  }

  const origin = req.headers.origin;
  const allowedOrigins = allowedOriginsEnv
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  // If there's an Origin header, it must match the allow-list
  if (origin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({
      error: "Forbidden",
      message: `Origin "${origin}" is not allowed.`,
    });
  }

  next();
}

// ─── Bearer Token Auth Middleware ───────────────────────────────────────────

function authMiddleware(req, res, next) {
  const expectedToken = process.env.MCP_AUTH_TOKEN;

  // 1. Extract token from Authorization header or query parameter
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const [scheme, val] = authHeader.split(" ");
    if (scheme === "Bearer") {
      token = val;
    }
  }
  if (!token && req.query.token) {
    token = req.query.token;
  }

  // If no auth is required (neither static token nor client id is configured), pass through
  if (!expectedToken && !process.env.MCP_CLIENT_ID) {
    return next();
  }

  // 2. Validate token
  if (expectedToken && token === expectedToken) {
    // Matches static token — requestContext will run with undefined (falling back to static credentials)
    res.locals.credentials = null;
    return next();
  }

  const session = userSessions.get(token);
  if (session) {
    // Matches dynamic session — store credentials in res.locals to be bound in the route context
    res.locals.credentials = session;
    return next();
  }

  return res.status(401).json({
    error: "Unauthorized",
    message: "Invalid or missing token. Provide a Bearer token in the Authorization header or use the ?token= query parameter.",
  });
}

// ─── OAuth 2.1 (PKCE) Implementation ────────────────────────────────────────

function renderConsentPage(clientId, redirectUri, state, codeChallenge, codeChallengeMethod, errorMsg = "", adaUsername = "") {
  const errorHtml = errorMsg 
    ? `<div class="error-msg">${errorMsg}</div>` 
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize Claude — ADA Digital Reach</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0B0E14;
      --card-bg: rgba(20, 24, 33, 0.6);
      --primary: #6366F1;
      --primary-hover: #4F46E5;
      --text: #F3F4F6;
      --text-muted: #9CA3AF;
      --border: rgba(255, 255, 255, 0.08);
      --error: #EF4444;
      --success: #10B981;
    }

    body {
      margin: 0;
      padding: 0;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      background-color: var(--bg);
      background-image: 
        radial-gradient(at 0% 0%, hsla(253,16%,7%,1) 0, transparent 50%),
        radial-gradient(at 50% 0%, hsla(225,39%,30%,0.2) 0, transparent 50%),
        radial-gradient(at 100% 100%, hsla(263,45%,20%,0.15) 0, transparent 50%);
      font-family: 'Outfit', sans-serif;
      color: var(--text);
    }

    .container {
      width: 100%;
      max-width: 460px;
      padding: 24px;
    }

    .card {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 40px 32px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    }

    .logo-area {
      display: flex;
      flex-direction: column;
      align-items: center;
      margin-bottom: 32px;
    }

    .logo-icon {
      width: 64px;
      height: 64px;
      background: linear-gradient(135deg, var(--primary), #EC4899);
      border-radius: 16px;
      display: flex;
      justify-content: center;
      align-items: center;
      font-size: 28px;
      color: white;
      box-shadow: 0 0 20px rgba(99, 102, 241, 0.4);
      margin-bottom: 16px;
    }

    h1 {
      font-size: 24px;
      font-weight: 600;
      margin: 0 0 8px 0;
      text-align: center;
      background: linear-gradient(to right, #F3F4F6, #D1D5DB);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .subtitle {
      font-size: 14px;
      color: var(--text-muted);
      margin: 0;
      text-align: center;
    }

    .desc {
      font-size: 14px;
      line-height: 1.6;
      color: var(--text-muted);
      margin-bottom: 28px;
      text-align: center;
    }

    .permissions-list {
      background: rgba(255, 255, 255, 0.03);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 28px;
      border: 1px solid var(--border);
    }

    .permission-item {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 13.5px;
      margin-bottom: 12px;
    }

    .permission-item:last-child {
      margin-bottom: 0;
    }

    .permission-check {
      color: var(--success);
      font-size: 16px;
    }

    .error-msg {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.2);
      border-radius: 10px;
      padding: 12px;
      font-size: 13.5px;
      color: var(--error);
      margin-bottom: 20px;
      text-align: center;
    }

    .form-group {
      margin-bottom: 24px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .input-wrapper {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    label {
      display: block;
      font-size: 12px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }

    input[type="text"], input[type="password"] {
      width: 100%;
      box-sizing: border-box;
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 16px;
      color: white;
      font-family: inherit;
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    input[type="text"]:focus, input[type="password"]:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.25);
    }

    .btn-group {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    button {
      width: 100%;
      padding: 14px;
      border-radius: 10px;
      border: none;
      font-family: inherit;
      font-size: 15px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s, transform 0.1s;
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--primary), #4F46E5);
      color: white;
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.2);
    }

    .btn-primary:hover {
      background: linear-gradient(135deg, var(--primary-hover), #4338CA);
    }

    .btn-primary:active {
      transform: scale(0.98);
    }

    .btn-secondary {
      background: transparent;
      color: var(--text-muted);
      border: 1px solid var(--border);
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.03);
      color: white;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo-area">
        <div class="logo-icon">💬</div>
        <h1>ADA Digital Reach</h1>
        <p class="subtitle">AI Connection Request</p>
      </div>

      <p class="desc">
        An AI assistant (Claude) wants permission to access your ADA SMS gateway. This will enable it to:
      </p>

      <div class="permissions-list">
        <div class="permission-item">
          <span class="permission-check">✓</span>
          <span>Send single SMS messages to recipients</span>
        </div>
        <div class="permission-item">
          <span class="permission-check">✓</span>
          <span>Send bulk SMS campaigns</span>
        </div>
        <div class="permission-item">
          <span class="permission-check">✓</span>
          <span>Send Unicode (Sinhala/Tamil) data campaigns</span>
        </div>
      </div>

      <form action="/oauth/approve" method="POST">
        <!-- Hidden params passed from authorize -->
        <input type="hidden" name="client_id" value="${clientId}">
        <input type="hidden" name="redirect_uri" value="${redirectUri}">
        <input type="hidden" name="state" value="${state}">
        <input type="hidden" name="code_challenge" value="${codeChallenge}">
        <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">

        ${errorHtml}

        <div class="form-group">
          <div class="input-wrapper">
            <label for="ada_username">ADA Gateway Username</label>
            <input type="text" id="ada_username" name="ada_username" placeholder="testapiuser" value="${adaUsername}" required>
          </div>
          <div class="input-wrapper">
            <label for="ada_password">ADA Gateway Password</label>
            <input type="password" id="ada_password" name="ada_password" placeholder="••••••••" required>
          </div>
          <div class="input-wrapper">
            <label for="client_secret">Client Secret</label>
            <input type="password" id="client_secret" name="client_secret" placeholder="••••••••••••••••" required>
          </div>
        </div>

        <div class="btn-group">
          <button type="submit" class="btn-primary">Authorize Agent</button>
          <button type="button" class="btn-secondary" onclick="window.location.href='${redirectUri}?error=access_denied&state=${state}'">Deny Access</button>
        </div>
      </form>
    </div>
  </div>
</body>
</html>`;
}

// Helper to validate ADA credentials by making a test login request
async function validateAdaCredentials(username, password) {
  const baseUrl = (process.env.ADA_BASE_URL || "").replace(/\/+$/, "");
  const tokenUrl = process.env.ADA_TOKEN_URL || "/login/api-based";
  const targetUrl = `${baseUrl}/${tokenUrl.replace(/^\/+/, "")}`;

  try {
    const response = await axios.post(targetUrl, {
      u_name: username,
      passwd: password,
    });
    const token = response.data?.access_token || response.data?.token;
    return !!token;
  } catch (error) {
    return false;
  }
}

// Helper for PKCE verification
function verifyPKCE(verifier, challenge) {
  const hash = crypto.createHash("sha256").update(verifier).digest();
  const base64url = hash.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return base64url === challenge;
}

// 1. Authorization Endpoint
app.get("/oauth/authorize", (req, res) => {
  const {
    response_type,
    client_id,
    redirect_uri,
    state,
    code_challenge,
    code_challenge_method
  } = req.query;

  const expectedClientId = process.env.MCP_CLIENT_ID;
  if (!expectedClientId) {
    return res.status(500).send("OAuth server is not configured. MCP_CLIENT_ID is missing.");
  }

  if (client_id !== expectedClientId) {
    return res.status(400).send(`Invalid client_id: "${client_id}"`);
  }

  if (response_type !== "code") {
    return res.status(400).send("Unsupported response_type. Only 'code' is supported.");
  }

  if (!redirect_uri) {
    return res.status(400).send("Missing redirect_uri.");
  }

  if (!code_challenge) {
    return res.status(400).send("PKCE code_challenge is required.");
  }

  if (code_challenge_method !== "S256") {
    return res.status(400).send("Only S256 code_challenge_method is supported.");
  }

  const html = renderConsentPage(
    client_id,
    redirect_uri,
    state || "",
    code_challenge,
    code_challenge_method
  );

  res.send(html);
});

// 2. Approval Submission Endpoint
app.post("/oauth/approve", async (req, res) => {
  const {
    client_id,
    redirect_uri,
    state,
    code_challenge,
    code_challenge_method,
    client_secret,
    ada_username,
    ada_password
  } = req.body;

  const expectedClientId = process.env.MCP_CLIENT_ID;
  const expectedClientSecret = process.env.MCP_CLIENT_SECRET;

  if (client_id !== expectedClientId) {
    return res.status(400).send("Invalid client ID.");
  }

  if (!client_secret || client_secret !== expectedClientSecret) {
    const html = renderConsentPage(
      client_id,
      redirect_uri,
      state || "",
      code_challenge,
      code_challenge_method,
      "Invalid Client Secret. Please verify and try again.",
      ada_username || ""
    );
    return res.status(401).send(html);
  }

  if (!ada_username || !ada_password) {
    const html = renderConsentPage(
      client_id,
      redirect_uri,
      state || "",
      code_challenge,
      code_challenge_method,
      "Please enter both your ADA Gateway Username and Password.",
      ada_username || ""
    );
    return res.status(400).send(html);
  }

  const isAdaCredsValid = await validateAdaCredentials(ada_username, ada_password);
  if (!isAdaCredsValid) {
    const html = renderConsentPage(
      client_id,
      redirect_uri,
      state || "",
      code_challenge,
      code_challenge_method,
      "Invalid ADA Gateway credentials. Verification failed.",
      ada_username || ""
    );
    return res.status(401).send(html);
  }

  // Generate an authorization code
  const authCode = crypto.randomBytes(32).toString("hex");

  // Cache the authorization code details
  authCodes.set(authCode, {
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    ada_username,
    ada_password,
    expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes validity
  });

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", authCode);
  if (state) {
    redirectUrl.searchParams.set("state", state);
  }

  res.redirect(redirectUrl.toString());
});

// 3. Token Exchange Endpoint
app.post("/oauth/token", (req, res) => {
  const {
    grant_type,
    code,
    redirect_uri,
    client_id,
    client_secret,
    code_verifier
  } = req.body;

  const expectedClientId = process.env.MCP_CLIENT_ID;
  const expectedClientSecret = process.env.MCP_CLIENT_SECRET;

  if (client_id !== expectedClientId || client_secret !== expectedClientSecret) {
    return res.status(401).json({
      error: "invalid_client",
      error_description: "Invalid client credentials."
    });
  }

  if (grant_type !== "authorization_code") {
    return res.status(400).json({
      error: "unsupported_grant_type",
      error_description: "Only 'authorization_code' grant type is supported."
    });
  }

  if (!code) {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "Missing authorization code."
    });
  }

  const cached = authCodes.get(code);
  if (!cached) {
    return res.status(400).json({
      error: "invalid_grant",
      error_description: "Invalid or expired authorization code."
    });
  }

  // Delete code to prevent reuse
  authCodes.delete(code);

  if (cached.expiresAt < Date.now()) {
    return res.status(400).json({
      error: "invalid_grant",
      error_description: "Authorization code has expired."
    });
  }

  if (redirect_uri !== cached.redirect_uri) {
    return res.status(400).json({
      error: "invalid_grant",
      error_description: "redirect_uri mismatch."
    });
  }

  if (!code_verifier) {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "Missing PKCE code_verifier."
    });
  }

  const isPkceValid = verifyPKCE(code_verifier, cached.code_challenge);
  if (!isPkceValid) {
    return res.status(400).json({
      error: "invalid_grant",
      error_description: "PKCE verification failed. code_verifier does not match code_challenge."
    });
  }

  // Generate a unique access token
  const accessToken = crypto.randomBytes(32).toString("hex");

  // Save user credentials mapped to this access token
  userSessions.set(accessToken, {
    username: cached.ada_username,
    password: cached.ada_password
  });

  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 315360000
  });
});

// ─── MCP Endpoint (Streamable HTTP) ─────────────────────────────────────────

// Apply middleware to the /mcp endpoint
app.use("/mcp", originValidation, authMiddleware);

/**
 * POST /mcp — Main MCP request handler.
 */
app.post("/mcp", async (req, res) => {
  const credentials = res.locals.credentials;
  requestContext.run(credentials, async () => {
    try {
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[MCP HTTP] Error handling POST /mcp:", error);
      if (!res.headersSent) {
        res.status(500).json({
          error: "Internal Server Error",
          message: "Failed to process MCP request.",
        });
      }
    }
  });
});

/**
 * GET /mcp — SSE stream endpoint.
 */
app.get("/mcp", async (req, res) => {
  const credentials = res.locals.credentials;
  requestContext.run(credentials, async () => {
    try {
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("[MCP HTTP] Error handling GET /mcp:", error);
      if (!res.headersSent) {
        res.status(500).json({
          error: "Internal Server Error",
          message: "Failed to establish SSE stream.",
        });
      }
    }
  });
});

/**
 * DELETE /mcp — Session cleanup.
 */
app.delete("/mcp", async (req, res) => {
  res.status(200).json({ status: "ok" });
});

// ─── 404 Fallback ───────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({
    error: "Not Found",
    message: "This is an MCP server. Use POST /mcp for tool calls, or GET /health for status.",
  });
});

// ─── Server Start ───────────────────────────────────────────────────────────

export async function startHttpServer() {
  const port = parseInt(process.env.PORT, 10) || 4000;
  const authConfigured = !!process.env.MCP_AUTH_TOKEN;

  app.listen(port, () => {
    console.error(`
╔══════════════════════════════════════════════════════════════╗
║  ADA Digital Reach MCP Server v2.0.1                        ║
║  Transport: Streamable HTTP                                 ║
║  Endpoint:  http://localhost:${String(port).padEnd(5)}                          ║
║  MCP URL:   http://localhost:${String(port).padEnd(5)}/mcp                      ║
║  Health:    http://localhost:${String(port).padEnd(5)}/health                   ║
║  Auth:      ${authConfigured ? "Bearer token (MCP_AUTH_TOKEN)" : "DISABLED (set MCP_AUTH_TOKEN to enable)"}${authConfigured ? "     " : ""}║
╚══════════════════════════════════════════════════════════════╝
`);
  });
}
