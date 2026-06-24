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
    registration_endpoint: `${baseUrl}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"]
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

  // If no auth is required (neither static token is configured nor is HTTP transport active), pass through
  if (!expectedToken && process.env.TRANSPORT !== "http") {
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

function renderConsentPage(redirectUri, state, codeChallenge, codeChallengeMethod, errorMsg = "", adaUsername = "") {
  let usernameErrorText = "";
  let passwordErrorText = "";
  let usernameErrorClass = "";
  let passwordErrorClass = "";

  if (errorMsg) {
    if (errorMsg.toLowerCase().includes("username") || errorMsg.toLowerCase().includes("both")) {
      usernameErrorText = `<div class="error-text">Please enter username</div>`;
      usernameErrorClass = "has-error";
    }
    if (errorMsg.toLowerCase().includes("password") || errorMsg.toLowerCase().includes("both")) {
      passwordErrorText = `<div class="error-text">Password is required</div>`;
      passwordErrorClass = "has-error";
    }
    // If it's an API validation failure (invalid credentials)
    if (!usernameErrorClass && !passwordErrorClass) {
      usernameErrorText = `<div class="error-text">Invalid username or password</div>`;
      usernameErrorClass = "has-error";
      passwordErrorClass = "has-error";
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Digital Reach</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-color: #eef2f6;
      --card-bg: #ffffff;
      --primary: #0b72a6;
      --primary-hover: #095c86;
      --text-main: #2c3e50;
      --text-muted: #7f8c8d;
      --border-color: #c4c4c4;
      --border-hover: #232323;
      --border-focus: #0b72a6;
      --error-color: #d32f2f;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Roboto', sans-serif;
      background-color: var(--bg-color);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 24px;
    }

    .login-card {
      background: var(--card-bg);
      border-radius: 8px;
      width: 100%;
      max-width: 480px;
      padding: 40px;
      box-shadow: 0px 8px 24px rgba(0, 0, 0, 0.04);
      border: 1px solid #e0e0e0;
      text-align: center;
    }

    .logo-container {
      margin-bottom: 24px;
      display: flex;
      justify-content: center;
    }

    .logo-img {
      height: 52px;
      object-fit: contain;
    }

    .title {
      font-size: 24px;
      font-weight: 500;
      color: #2c3e50;
      margin-bottom: 8px;
    }

    .subtitle {
      font-size: 14px;
      color: var(--text-muted);
      margin-bottom: 32px;
    }

    .form-group {
      margin-bottom: 24px;
      text-align: left;
    }

    .input-container {
      position: relative;
    }

    .form-input {
      width: 100%;
      height: 56px;
      padding: 16.5px 14px;
      font-size: 16px;
      font-family: inherit;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      outline: none;
      background: transparent;
      box-sizing: border-box;
      color: #1e293b;
      transition: border-color 0.2s, border-width 0.1s;
    }

    .form-input:hover {
      border-color: var(--border-hover);
    }

    .form-input:focus {
      border-color: var(--border-focus);
      border-width: 2px;
      padding: 15.5px 13px;
    }

    .form-label {
      position: absolute;
      left: 14px;
      top: 50%;
      transform: translateY(-50%);
      background: #ffffff;
      padding: 0 4px;
      color: #666666;
      font-size: 16px;
      pointer-events: none;
      transition: transform 150ms cubic-bezier(0.4, 0, 0.2, 1), 
                  font-size 150ms cubic-bezier(0.4, 0, 0.2, 1), 
                  color 150ms cubic-bezier(0.4, 0, 0.2, 1), 
                  top 150ms cubic-bezier(0.4, 0, 0.2, 1);
      transform-origin: top left;
    }

    .form-input:focus ~ .form-label,
    .form-input:not(:placeholder-shown) ~ .form-label {
      top: 0;
      transform: translateY(-50%) scale(0.75);
      color: var(--border-focus);
    }

    /* Password Input adjustments */
    .password-input {
      padding-right: 48px;
    }
    .password-input:focus {
      padding-right: 47px;
    }

    .password-toggle {
      position: absolute;
      right: 14px;
      top: 50%;
      transform: translateY(-50%);
      background: none;
      border: none;
      cursor: pointer;
      color: #666666;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 4px;
    }

    .password-toggle:hover {
      color: #333333;
    }

    /* Error States */
    .form-group.has-error .form-input {
      border-color: var(--error-color);
    }
    .form-group.has-error .form-input:focus {
      border-color: var(--error-color);
      border-width: 2px;
    }
    .form-group.has-error .form-label {
      color: var(--error-color);
    }
    .form-group.has-error .form-input:focus ~ .form-label,
    .form-group.has-error .form-input:not(:placeholder-shown) ~ .form-label {
      color: var(--error-color);
    }

    .error-text {
      color: var(--error-color);
      font-size: 12px;
      margin-top: 4px;
      margin-left: 14px;
      text-align: left;
    }

    .remember-forgot-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      font-size: 14px;
    }

    .remember-me {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      color: #333333;
    }

    .remember-me input {
      cursor: pointer;
      accent-color: var(--primary);
      width: 18px;
      height: 18px;
      border: 1px solid rgba(0, 0, 0, 0.23);
      border-radius: 2px;
    }

    .forgot-link {
      color: var(--primary);
      text-decoration: none;
      font-weight: 700;
    }

    .forgot-link:hover {
      text-decoration: underline;
    }

    .submit-btn {
      width: 100%;
      height: 48px;
      background-color: var(--primary);
      color: #ffffff;
      border: none;
      border-radius: 4px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      transition: background-color 0.2s;
    }

    .submit-btn:hover {
      background-color: var(--primary-hover);
    }

    .register-divider {
      display: flex;
      align-items: center;
      color: var(--text-muted);
      font-size: 14px;
      margin-top: 24px;
      margin-bottom: 16px;
    }

    .register-divider::before,
    .register-divider::after {
      content: "";
      flex: 1;
      border-bottom: 1px solid #e0e0e0;
    }

    .register-divider::before {
      margin-right: 12px;
    }

    .register-divider::after {
      margin-left: 12px;
    }

    .register-container {
      display: flex;
      justify-content: center;
    }

    .register-btn {
      padding: 6px 16px;
      background-color: #ffffff;
      color: #2c3e50;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background-color 0.2s, border-color 0.2s;
      text-decoration: none;
      display: inline-block;
    }

    .register-btn:hover {
      background-color: #f8fafc;
      border-color: #94a3b8;
    }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="logo-container">
      <img class="logo-img" src="https://adareach.adeonatech.net/logo192.png" alt="ADA Logo">
    </div>
    <h1 class="title">Hi, Welcome Back</h1>
    <p class="subtitle">Enter your credentials to continue</p>

    <form action="/oauth/approve" method="POST">
      <!-- Hidden params passed from authorize -->
      <input type="hidden" name="redirect_uri" value="${redirectUri}">
      <input type="hidden" name="state" value="${state}">
      <input type="hidden" name="code_challenge" value="${codeChallenge}">
      <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">

      <div class="form-group ${usernameErrorClass}">
        <div class="input-container">
          <input class="form-input" type="text" id="ada_username" name="ada_username" placeholder=" " value="${adaUsername}" required autocomplete="username">
          <label class="form-label" for="ada_username">Username</label>
        </div>
        ${usernameErrorText}
      </div>

      <div class="form-group ${passwordErrorClass}">
        <div class="input-container">
          <input class="form-input password-input" type="password" id="ada_password" name="ada_password" placeholder=" " required autocomplete="current-password">
          <label class="form-label" for="ada_password">Password</label>
          <button type="button" class="password-toggle" onclick="togglePasswordVisibility()" aria-label="Toggle password visibility">
            <!-- Eye slash/off icon SVG -->
            <svg id="eye-icon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
            </svg>
          </button>
        </div>
        ${passwordErrorText}
      </div>

      <div class="remember-forgot-row">
        <label class="remember-me">
          <input type="checkbox" name="remember"> Remember me
        </label>
        <a class="forgot-link" href="https://adareach.adeonatech.net/forgot-password" target="_blank">Forgot Password?</a>
      </div>

      <button type="submit" class="submit-btn">Sign In</button>

      <div class="register-divider">Don't have an account?</div>
      <div class="register-container">
        <a class="register-btn" href="https://adareach.adeonatech.net/register" target="_blank">Register Here</a>
      </div>
    </form>
  </div>

  <script>
    function togglePasswordVisibility() {
      const passwordInput = document.getElementById('ada_password');
      const eyeIcon = document.getElementById('eye-icon');
      if (passwordInput.type === 'password') {
        passwordInput.type = 'text';
        // Eye open icon SVG
        eyeIcon.innerHTML = \`<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />\`;
      } else {
        passwordInput.type = 'password';
        // Eye slash/off icon SVG
        eyeIcon.innerHTML = \`<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />\`;
      }
    }
  </script>
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
    redirect_uri,
    state,
    code_challenge,
    code_challenge_method
  } = req.query;

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
    redirect_uri,
    state,
    code_challenge,
    code_challenge_method,
    ada_username,
    ada_password
  } = req.body;

  if (!ada_username || !ada_password) {
    const html = renderConsentPage(
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
    code_verifier
  } = req.body;

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

// 4. Dynamic Client Registration Endpoint (RFC 7591)
app.post("/oauth/register", (req, res) => {
  const {
    redirect_uris,
    token_endpoint_auth_method
  } = req.body;

  // Generate a random client ID
  const clientId = crypto.randomBytes(16).toString("hex");

  res.status(201).json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirect_uris || [],
    token_endpoint_auth_method: token_endpoint_auth_method || "none"
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
