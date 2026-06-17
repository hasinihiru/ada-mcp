/**
 * ADA Digital Reach MCP — Response Formatter
 *
 * Converts raw API responses into structured, human-readable text
 * that AI agents can easily relay to users. Each response includes
 * a clear status, key details, and suggested next steps.
 */

import { getErrorEntry } from "./errorCodes.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function divider() {
  return "─".repeat(48);
}

function statusIcon(severity) {
  const icons = {
    success: "✅",
    warning: "⚠️",
    error: "❌",
    critical: "🚨",
  };
  return icons[severity] || "ℹ️";
}

/**
 * Extract the campaign/reference ID from various API response shapes.
 */
function extractCampaignId(data) {
  return (
    data?.campaign_id ||
    data?.campaignId ||
    data?.id ||
    data?.reference_id ||
    data?.ref_id ||
    null
  );
}

// ─── SMS Send Response ──────────────────────────────────────────────────────

/**
 * Format a successful SMS send response.
 *
 * @param {string} toolName   — The tool that was called.
 * @param {object} apiResult  — Raw API response data.
 * @param {object} context    — Additional context (recipient count, etc.).
 * @returns {string} Formatted response text.
 */
export function formatSmsResponse(toolName, apiResult, context = {}) {
  const errorCode = apiResult?.error;
  const isSuccess =
    errorCode === undefined ||
    errorCode === "0" ||
    errorCode === 0 ||
    errorCode === "100" ||
    errorCode === 100;

  if (!isSuccess) {
    return formatApiErrorResponse(toolName, apiResult);
  }

  const campId = apiResult?.camp_id || apiResult?.campaign_id || apiResult?.campaignId || apiResult?.id || null;
  const refId = apiResult?.ref_id || apiResult?.reference_id || apiResult?.referenceId || null;
  const lines = [];

  lines.push(`✅ SMS ${_friendlyToolAction(toolName)} — Success`);
  lines.push(divider());

  if (context.recipientCount) {
    lines.push(`📱 Recipients: ${context.recipientCount}`);
  }
  if (context.phoneNumber) {
    lines.push(`📱 Recipient: ${context.phoneNumber}`);
  }
  if (context.messagePreview) {
    const preview =
      context.messagePreview.length > 80
        ? context.messagePreview.slice(0, 77) + "..."
        : context.messagePreview;
    lines.push(`💬 Message: "${preview}"`);
  }
  if (campId) {
    lines.push(`🆔 Campaign ID: ${campId}`);
  }
  if (refId) {
    lines.push(`🔑 Reference ID: ${refId}`);
  }
  if (context.channel) {
    lines.push(`📡 Channel: ${context.channel}`);
  }

  // Warnings (e.g., message length)
  if (context.warnings && context.warnings.length > 0) {
    lines.push("");
    lines.push("⚠️ Warnings:");
    for (const w of context.warnings) {
      lines.push(`   • ${w}`);
    }
  }

  // Next steps
  lines.push("");
  lines.push("📋 Next Steps:");
  lines.push("   • Send another message using any of the SMS tools");

  // Include raw response for transparency
  lines.push("");
  lines.push("📦 Raw API Response:");
  lines.push(JSON.stringify(apiResult, null, 2));

  return lines.join("\n");
}

// ─── API Error Response ─────────────────────────────────────────────────────

/**
 * Format an API error response using the error code registry.
 *
 * @param {string} toolName  — The tool that was called.
 * @param {object} apiResult — Raw API response containing an `error` field.
 * @returns {string}
 */
export function formatApiErrorResponse(toolName, apiResult) {
  const code = apiResult?.error;
  const entry = getErrorEntry(code);
  const icon = statusIcon(entry.severity);
  const lines = [];

  lines.push(`${icon} SMS ${_friendlyToolAction(toolName)} — Failed`);
  lines.push(divider());
  lines.push(`Error Code: ${entry.code}`);
  lines.push(`Message: ${entry.message}`);
  lines.push(`Severity: ${entry.severity}`);
  lines.push("");
  lines.push(`💡 Suggested Action: ${entry.action}`);

  if (entry.retryable) {
    lines.push("🔄 This error is retryable — you can try the same request again.");
  }

  lines.push("");
  lines.push("📦 Raw API Response:");
  lines.push(JSON.stringify(apiResult, null, 2));

  return lines.join("\n");
}



// ─── Validation Error Response ──────────────────────────────────────────────

/**
 * Format a pre-flight validation error (before API call).
 *
 * @param {string} toolName — The tool that was called.
 * @param {string} error    — Validation error message.
 * @returns {string}
 */
export function formatValidationError(toolName, error) {
  const lines = [];

  lines.push(`❌ Validation Failed — ${_friendlyToolAction(toolName)}`);
  lines.push(divider());
  lines.push(error);
  lines.push("");
  lines.push("💡 Fix the input and try again. No message was sent.");

  return lines.join("\n");
}

// ─── Tool Execution Error Response ──────────────────────────────────────────

/**
 * Format a runtime/network error.
 *
 * @param {string} toolName — The tool that was called.
 * @param {Error}  error    — The caught error.
 * @returns {string}
 */
export function formatExecutionError(toolName, error) {
  const lines = [];

  lines.push(`❌ Error — ${_friendlyToolAction(toolName)}`);
  lines.push(divider());
  lines.push(`Message: ${error.message}`);

  if (error.response?.data) {
    const apiError = error.response.data?.error;
    if (apiError !== undefined) {
      const entry = getErrorEntry(apiError);
      lines.push("");
      lines.push(`API Error Code: ${entry.code}`);
      lines.push(`API Message: ${entry.message}`);
      lines.push(`💡 Suggested Action: ${entry.action}`);
    }
  }

  lines.push("");
  lines.push("💡 If this issue persists, check your network connection and ADA API credentials.");

  return lines.join("\n");
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

const TOOL_ACTION_MAP = {
  send_single_sms: "Single SMS Send",
  send_bulk_sms: "Bulk SMS Send",
  send_data_sms: "Data Campaign Send",
  send_data_bulk_sms: "Data Campaign Bulk Send",
};

function _friendlyToolAction(toolName) {
  return TOOL_ACTION_MAP[toolName] || toolName;
}
