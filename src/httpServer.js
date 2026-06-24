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
  <title>Sign In - ADA Reach</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-color: #eef2f6;
      --card-bg: #ffffff;
      --primary: #0b72a6;
      --primary-hover: #095c86;
      --text-main: #1e293b;
      --text-muted: #64748b;
      --border-color: #cbd5e1;
      --border-focus: #0b72a6;
      --error-color: #d32f2f;
      --error-bg: #fde8e8;
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
      flex-direction: column;
      justify-content: space-between;
      color: var(--text-main);
    }

    .main-container {
      flex: 1;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 24px;
    }

    .login-card {
      background: var(--card-bg);
      border-radius: 12px;
      width: 100%;
      max-width: 450px;
      padding: 40px;
      box-shadow: 0px 8px 24px rgba(0, 0, 0, 0.05);
      border: 1px solid rgba(0, 0, 0, 0.08);
      text-align: center;
    }

    .logo-container {
      margin-bottom: 24px;
    }

    .logo-img {
      height: 48px;
      object-fit: contain;
    }

    .title {
      font-size: 24px;
      font-weight: 700;
      color: var(--text-main);
      margin-bottom: 8px;
    }

    .subtitle {
      font-size: 14px;
      color: var(--text-muted);
      margin-bottom: 32px;
    }

    .error-msg {
      background-color: var(--error-bg);
      border: 1px solid rgba(211, 47, 47, 0.2);
      border-radius: 8px;
      padding: 12px;
      font-size: 14px;
      color: var(--error-color);
      margin-bottom: 24px;
      text-align: left;
    }

    .form-group {
      margin-bottom: 20px;
      text-align: left;
    }

    .form-label {
      display: block;
      font-size: 14px;
      font-weight: 500;
      color: var(--text-main);
      margin-bottom: 8px;
    }

    .input-container {
      position: relative;
      display: flex;
      align-items: center;
    }

    .form-input {
      width: 100%;
      padding: 12px 14px;
      font-size: 15px;
      font-family: inherit;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    .form-input:focus {
      border-color: var(--border-focus);
      box-shadow: 0 0 0 2px rgba(11, 114, 166, 0.2);
    }

    .password-toggle {
      position: absolute;
      right: 14px;
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 4px;
    }

    .password-toggle:hover {
      color: var(--text-main);
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
      color: var(--text-muted);
    }

    .remember-me input {
      cursor: pointer;
      accent-color: var(--primary);
      width: 16px;
      height: 16px;
    }

    .forgot-link {
      color: var(--primary);
      text-decoration: none;
      font-weight: 500;
    }

    .forgot-link:hover {
      text-decoration: underline;
    }

    .submit-btn {
      width: 100%;
      padding: 12px;
      background-color: var(--primary);
      color: #ffffff;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      transition: background-color 0.2s;
      margin-bottom: 24px;
    }

    .submit-btn:hover {
      background-color: var(--primary-hover);
    }

    .register-divider {
      display: flex;
      align-items: center;
      color: var(--text-muted);
      font-size: 14px;
      margin-bottom: 20px;
    }

    .register-divider::before,
    .register-divider::after {
      content: "";
      flex: 1;
      border-bottom: 1px solid #cbd5e1;
    }

    .register-divider::before {
      margin-right: 12px;
    }

    .register-divider::after {
      margin-left: 12px;
    }

    .register-btn {
      width: 100%;
      padding: 10px;
      background-color: #ffffff;
      color: #334155;
      border: 1px solid var(--border-color);
      border-radius: 8px;
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

    /* Footer Band styling */
    .footer-band {
      background-color: #d6e4f0;
      padding: 32px 48px;
      border-top: 1px solid rgba(0, 0, 0, 0.05);
      font-size: 14px;
      color: #334155;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 16px;
    }

    @media (min-width: 768px) {
      .footer-band {
        flex-direction: row;
        justify-content: space-between;
        align-items: center;
      }
    }

    .footer-left {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .footer-logo {
      height: 32px;
      align-self: flex-start;
    }

    .footer-divider {
      height: 1px;
      background-color: rgba(255, 255, 255, 0.4);
      width: 100%;
    }

    .copyright {
      color: #334155;
    }

    .copyright-link {
      color: #334155;
      text-decoration: none;
      font-weight: 500;
    }

    .copyright-link:hover {
      text-decoration: underline;
    }

    .social-links {
      display: flex;
      gap: 16px;
    }

    .social-icon {
      color: #334155;
      text-decoration: none;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background-color: rgba(255, 255, 255, 0.4);
      transition: background-color 0.2s;
    }

    .social-icon:hover {
      background-color: rgba(255, 255, 255, 0.8);
    }
  </style>
</head>
<body>
  <div class="main-container">
    <div class="login-card">
      <div class="logo-container">
        <img class="logo-img" src="https://adareach.adeonatech.net/logo192.png" alt="ADA Logo">
      </div>
      <h1 class="title">Hi, Welcome Back</h1>
      <p class="subtitle">Enter your credentials to continue</p>

      <form action="/oauth/approve" method="POST">
        <!-- Hidden params passed from authorize -->
        <input type="hidden" name="client_id" value="${clientId}">
        <input type="hidden" name="redirect_uri" value="${redirectUri}">
        <input type="hidden" name="state" value="${state}">
        <input type="hidden" name="code_challenge" value="${codeChallenge}">
        <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">

        ${errorHtml}

        <div class="form-group">
          <label class="form-label" for="outlined-adornment-username-login">Username</label>
          <div class="input-container">
            <input class="form-input" type="text" id="outlined-adornment-mobile-login" name="ada_username" placeholder="testapiuser" value="${adaUsername}" required autocomplete="username">
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="outlined-adornment-password-login">Password</label>
          <div class="input-container">
            <input class="form-input" type="password" id="outlined-adornment-password-login" name="ada_password" placeholder="••••••••" required autocomplete="current-password">
            <button type="button" class="password-toggle" onclick="togglePasswordVisibility()" aria-label="Toggle password visibility">
              <!-- Eye open icon SVG -->
              <svg id="eye-icon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </button>
          </div>
        </div>

        <div class="remember-forgot-row">
          <label class="remember-me">
            <input type="checkbox" name="remember"> Remember me
          </label>
          <a class="forgot-link" href="https://adareach.adeonatech.net/forgot-password" target="_blank">Forgot Password?</a>
        </div>

        <button type="submit" class="submit-btn">Sign in</button>

        <div class="register-divider">Don't have an account?</div>
        <a class="register-btn" href="https://adareach.adeonatech.net/register" target="_blank">Register Here</a>
      </form>
    </div>
  </div>

  <footer class="footer-band">
    <div class="footer-left">
      <img class="footer-logo" src="https://adareach.adeonatech.net/logo192.png" alt="ADA Logo">
      <div class="footer-divider"></div>
      <p class="copyright">
        &copy; 2026 Copyright: <a class="copyright-link" href="https://adaglobal-legal.com/reach-sl/" target="_blank">ADA Digital Singapore PTE. (LTD).</a> All Rights Reserved.
      </p>
    </div>
    <div class="social-links">
      <a class="social-icon" href="https://www.adaglobal.com/offices/srilanka" target="_blank" aria-label="Website">🌐</a>
      <a class="social-icon" href="https://www.facebook.com/weareadaglobal" target="_blank" aria-label="Facebook">FB</a>
      <a class="social-icon" href="https://www.instagram.com/adaasia.lk/?hl=en" target="_blank" aria-label="Instagram">IG</a>
      <a class="social-icon" href="https://www.youtube.com/@weareadaglobal" target="_blank" aria-label="YouTube">YT</a>
      <a class="social-icon" href="https://www.linkedin.com/company/weareada/?originalSubdomain=my" target="_blank" aria-label="LinkedIn">IN</a>
    </div>
  </footer>

  <script>
    function togglePasswordVisibility() {
      const passwordInput = document.getElementById('outlined-adornment-password-login');
      const eyeIcon = document.getElementById('eye-icon');
      if (passwordInput.type === 'password') {
        passwordInput.type = 'text';
        // Change to Eye Closed icon SVG
        eyeIcon.innerHTML = \`<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />\`;
      } else {
        passwordInput.type = 'password';
        // Change to Eye Open icon SVG
        eyeIcon.innerHTML = \`<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />\`;
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
    ada_username,
    ada_password
  } = req.body;

  const expectedClientId = process.env.MCP_CLIENT_ID;

  if (client_id !== expectedClientId) {
    return res.status(400).send("Invalid client ID.");
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
    code_verifier
  } = req.body;

  const expectedClientId = process.env.MCP_CLIENT_ID;

  if (client_id !== expectedClientId) {
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
