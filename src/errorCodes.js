/**
 * ADA Digital Reach API — Error Code Registry
 *
 * Maps every known API response code to a human-readable message,
 * severity level, and suggested action so that AI agents can relay
 * clear, actionable feedback to end users.
 *
 * Source: ADA Digital Reach API Documentation v2.1 (2026-06-03)
 */

/** @typedef {"success"|"warning"|"error"|"critical"} Severity */

/**
 * @typedef {Object} ErrorCodeEntry
 * @property {string}   message   — Human-readable description.
 * @property {Severity} severity  — How serious the issue is.
 * @property {string}   action    — Suggested next step for the user / AI.
 * @property {boolean}  retryable — Whether the operation can be retried.
 */

/** @type {Record<number, ErrorCodeEntry>} */
const ERROR_CODES = {
  0: {
    message: "Request completed successfully.",
    severity: "success",
    action: "No action required.",
    retryable: false,
  },
  100: {
    message: "SMS sent successfully.",
    severity: "success",
    action: "No action required.",
    retryable: false,
  },
  101: {
    message: "Authentication failed — invalid credentials.",
    severity: "error",
    action: "Verify the ADA_USERNAME and ADA_PASSWORD in your environment configuration.",
    retryable: false,
  },
  102: {
    message: "Account is inactive or suspended.",
    severity: "critical",
    action: "Contact ADA Digital Reach support to reactivate your account.",
    retryable: false,
  },
  103: {
    message: "Invalid phone number format.",
    severity: "error",
    action: "Ensure the phone number follows the Sri Lankan format: 94XXXXXXXXX (e.g., 94771234567).",
    retryable: false,
  },
  104: {
    message: "Authentication token has expired.",
    severity: "warning",
    action: "The server will automatically re-authenticate. Retry your request.",
    retryable: true,
  },
  105: {
    message: "Authentication token is invalid.",
    severity: "warning",
    action: "The server will automatically re-authenticate. Retry your request.",
    retryable: true,
  },
  106: {
    message: "Required parameters are missing from the request.",
    severity: "error",
    action: "Ensure all required fields (phone number, message) are provided.",
    retryable: false,
  },
  107: {
    message: "Invalid channel ID.",
    severity: "error",
    action: "Use channel '61' for standard SMS or '55' for data campaigns.",
    retryable: false,
  },
  108: {
    message: "The phone number is blocked or blacklisted.",
    severity: "error",
    action: "This number cannot receive messages. Try a different number or contact support.",
    retryable: false,
  },
  109: {
    message: "Rate limit exceeded — too many requests.",
    severity: "warning",
    action: "Wait a few seconds before sending the next message.",
    retryable: true,
  },
  110: {
    message: "Campaign time window has expired.",
    severity: "error",
    action: "Set a future end time (e_time) and try again.",
    retryable: false,
  },
  111: {
    message: "Duplicate campaign detected.",
    severity: "warning",
    action: "A campaign with the same parameters was already sent. Change the content or recipients if this is intentional.",
    retryable: false,
  },
  112: {
    message: "Invalid or empty message content.",
    severity: "error",
    action: "Provide a non-empty message body.",
    retryable: false,
  },
  113: {
    message: "SMS gateway encountered an internal error.",
    severity: "error",
    action: "This is a temporary gateway issue. Wait a minute and try again.",
    retryable: true,
  },
  114: {
    message: "⚠️ Insufficient wallet balance.",
    severity: "critical",
    action: "Your ADA account does not have enough credit to send this message. Please top up your balance before retrying.",
    retryable: false,
  },
  115: {
    message: "⚠️ Wallet is suspended.",
    severity: "critical",
    action: "Your wallet has been suspended. Contact ADA Digital Reach support immediately for assistance.",
    retryable: false,
  },
};

/**
 * Look up the error entry for a given API response code.
 *
 * @param {number|string} code — The `error` field from the API response.
 * @returns {ErrorCodeEntry}
 */
export function getErrorEntry(code) {
  const numericCode = typeof code === "string" ? parseInt(code, 10) : code;

  if (ERROR_CODES[numericCode]) {
    return { code: numericCode, ...ERROR_CODES[numericCode] };
  }

  return {
    code: numericCode,
    message: `Unknown API error (code ${numericCode}).`,
    severity: "error",
    action: "Contact ADA Digital Reach support with this error code for assistance.",
    retryable: false,
  };
}

/**
 * Get just the human-readable message for a code.
 */
export function getErrorMessage(code) {
  return getErrorEntry(code).message;
}

/**
 * Check whether the error is an auth issue that can be auto-retried.
 */
export function isAuthError(code) {
  const numericCode = typeof code === "string" ? parseInt(code, 10) : code;
  return numericCode === 104 || numericCode === 105;
}

/**
 * Check whether the error is a wallet / billing issue.
 */
export function isWalletError(code) {
  const numericCode = typeof code === "string" ? parseInt(code, 10) : code;
  return numericCode === 114 || numericCode === 115;
}

/**
 * Check whether the failed operation can be retried.
 */
export function isRetryableError(code) {
  return getErrorEntry(code).retryable;
}

export default ERROR_CODES;
