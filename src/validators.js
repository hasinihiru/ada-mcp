/**
 * ADA Digital Reach MCP — Input Validators & Phone Normalization
 *
 * All validation runs BEFORE the API call, so AI agents receive
 * clear, specific feedback they can relay to the user instead of
 * cryptic gateway codes.
 */

/** Regex: 94 followed by exactly 9 digits */
const SRI_LANKAN_PHONE_RE = /^94\d{9}$/;

/** Regex: YYYY-MM-DD HH:mm:ss */
const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Standard SMS character limit (single-segment) */
const STANDARD_SMS_CHAR_LIMIT = 160;

// ─── Phone Number Normalization ──────────────────────────────────────────────

/**
 * Normalize a phone number to the ADA-required `94XXXXXXXXX` format.
 *
 * Handles these common inputs:
 *   +94771234567 → 94771234567
 *   0771234567   → 94771234567
 *   94771234567  → 94771234567 (no change)
 *   771234567    → 94771234567
 *
 * @param {string} raw — The user-provided phone number.
 * @returns {{ value: string, normalized: boolean, original: string }}
 */
export function normalizePhoneNumber(raw) {
  if (!raw || typeof raw !== "string") {
    return { value: raw, normalized: false, original: raw };
  }

  let cleaned = raw.trim().replace(/[\s\-().]/g, "");
  const original = cleaned;

  // Strip leading "+"
  if (cleaned.startsWith("+")) {
    cleaned = cleaned.slice(1);
  }

  // Convert local format (07XXXXXXXX) to international
  if (cleaned.startsWith("0") && cleaned.length === 10) {
    cleaned = "94" + cleaned.slice(1);
  }

  // If only 9 digits starting with 7, prepend country code
  if (/^7\d{8}$/.test(cleaned)) {
    cleaned = "94" + cleaned;
  }

  return {
    value: cleaned,
    normalized: cleaned !== original,
    original: raw.trim(),
  };
}

// ─── Validation Functions ────────────────────────────────────────────────────

/**
 * @typedef {Object} ValidationResult
 * @property {boolean}  valid    — Whether validation passed.
 * @property {string}   [error]  — Error message (only when invalid).
 * @property {string[]} [warnings] — Non-blocking warnings.
 */

/**
 * Validate a single phone number after normalization.
 *
 * @param {string} phoneNumber — Already-normalized number.
 * @returns {ValidationResult}
 */
export function validatePhoneNumber(phoneNumber) {
  if (!phoneNumber || typeof phoneNumber !== "string") {
    return {
      valid: false,
      error: "Phone number is required. Provide a Sri Lankan mobile number (e.g., 94771234567).",
    };
  }

  if (!SRI_LANKAN_PHONE_RE.test(phoneNumber)) {
    return {
      valid: false,
      error:
        `Invalid phone number "${phoneNumber}". ` +
        "Expected format: 94XXXXXXXXX (country code 94 followed by 9 digits). " +
        "Example: 94771234567",
    };
  }

  return { valid: true };
}

/**
 * Validate an array of phone numbers (for bulk operations).
 *
 * @param {string[]} phoneNumbers — Array of already-normalized numbers.
 * @returns {ValidationResult & { invalidNumbers?: string[] }}
 */
export function validatePhoneNumbers(phoneNumbers) {
  if (!Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
    return {
      valid: false,
      error: "At least one phone number is required for bulk SMS. Provide an array of Sri Lankan mobile numbers.",
    };
  }

  const invalid = [];
  for (const num of phoneNumbers) {
    const result = validatePhoneNumber(num);
    if (!result.valid) {
      invalid.push(num);
    }
  }

  if (invalid.length > 0) {
    return {
      valid: false,
      error:
        `${invalid.length} of ${phoneNumbers.length} phone number(s) are invalid: ${invalid.join(", ")}. ` +
        "Each number must be in 94XXXXXXXXX format.",
      invalidNumbers: invalid,
    };
  }

  return { valid: true };
}

/**
 * Validate the SMS message body.
 *
 * @param {string}  message        — The message text.
 * @param {boolean} isDataCampaign — Whether this is a data/Unicode campaign.
 * @returns {ValidationResult}
 */
export function validateMessage(message, isDataCampaign = false) {
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return {
      valid: false,
      error: "Message body is required. Provide the SMS text you want to send.",
    };
  }

  const warnings = [];

  if (!isDataCampaign && message.length > STANDARD_SMS_CHAR_LIMIT) {
    warnings.push(
      `Message is ${message.length} characters (standard SMS limit is ${STANDARD_SMS_CHAR_LIMIT}). ` +
        "It may be split into multiple segments and cost more. Consider using a data campaign for longer or Unicode messages."
    );
  }

  return { valid: true, ...(warnings.length > 0 && { warnings }) };
}

/**
 * Validate a datetime string.
 *
 * @param {string} datetime — Expected format: "YYYY-MM-DD HH:mm:ss"
 * @param {string} fieldName — Name of the field for error messages.
 * @returns {ValidationResult}
 */
export function validateDateTime(datetime, fieldName = "datetime") {
  if (!datetime) {
    // Optional fields — empty is fine
    return { valid: true };
  }

  if (typeof datetime !== "string" || !DATETIME_RE.test(datetime)) {
    return {
      valid: false,
      error:
        `Invalid ${fieldName} format "${datetime}". ` +
        'Expected: "YYYY-MM-DD HH:mm:ss" (e.g., "2026-06-16 14:30:00").',
    };
  }

  // Verify it parses to a real date
  const parsed = new Date(datetime.replace(" ", "T"));
  if (isNaN(parsed.getTime())) {
    return {
      valid: false,
      error: `The ${fieldName} "${datetime}" is not a valid date.`,
    };
  }

  return { valid: true };
}

/**
 * Validate the channel value.
 *
 * @param {string} channel — Channel ID.
 * @returns {ValidationResult}
 */
export function validateChannel(channel) {
  if (!channel) {
    return { valid: true }; // Optional — defaults will apply
  }

  const known = ["55", "61"];
  const warnings = [];

  if (!known.includes(String(channel))) {
    warnings.push(
      `Channel "${channel}" is not one of the standard channels (61 = standard SMS, 55 = data campaign). ` +
        "Proceeding anyway, but verify this channel is configured for your account."
    );
  }

  return { valid: true, ...(warnings.length > 0 && { warnings }) };
}
