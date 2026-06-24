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

// ─── Express App Setup ──────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ─── Health Check ───────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server: "ada-digital-reach-mcp-server",
    version: "2.0.1",
    transport: "streamable-http",
    timestamp: new Date().toISOString(),
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

  // If no token is configured, skip auth (development mode)
  if (!expectedToken) {
    return next();
  }

  // 1. Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const [scheme, token] = authHeader.split(" ");
    if (scheme === "Bearer" && token === expectedToken) {
      return next();
    }
  }

  // 2. Check query parameter fallback (for Claude.ai Custom Connector compatibility)
  const queryToken = req.query.token;
  if (queryToken && queryToken === expectedToken) {
    return next();
  }

  return res.status(401).json({
    error: "Unauthorized",
    message: "Invalid or missing token. Provide a Bearer token in the Authorization header or use the ?token= query parameter.",
  });
}

// ─── MCP Endpoint (Streamable HTTP) ─────────────────────────────────────────

// Apply middleware to the /mcp endpoint
app.use("/mcp", originValidation, authMiddleware);

/**
 * POST /mcp — Main MCP request handler.
 *
 * Each request creates a fresh stateless transport + server pair.
 * This is the recommended approach for serverless / horizontally-scaled
 * deployments where you can't guarantee sticky sessions.
 */
app.post("/mcp", async (req, res) => {
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless — no session tracking
    });

    // Wire the server to this transport
    await server.connect(transport);

    // Let the transport handle the request/response
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

/**
 * GET /mcp — SSE stream endpoint (for server-initiated notifications).
 * Required by the Streamable HTTP spec for bidirectional communication.
 */
app.get("/mcp", async (req, res) => {
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

/**
 * DELETE /mcp — Session cleanup (no-op in stateless mode, but required
 * by the MCP spec for well-behaved clients).
 */
app.delete("/mcp", async (req, res) => {
  // In stateless mode, there's nothing to clean up
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
