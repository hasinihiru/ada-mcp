import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import adaClient from "./adaClient.js";
import {
  normalizePhoneNumber,
  validatePhoneNumber,
  validatePhoneNumbers,
  validateMessage,
  validateDateTime,
  validateChannel,
} from "./validators.js";
import {
  formatSmsResponse,
  formatDeliveryStatusResponse,
  formatValidationError,
  formatExecutionError,
} from "./responseFormatter.js";

// ─── Server Initialization ──────────────────────────────────────────────────

const server = new Server(
  {
    name: "ada-digital-reach-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// ─── System Prompt Resource ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `# ADA Digital Reach — AI Agent Guide

You are connected to the **ADA Digital Reach** SMS platform via MCP. This platform enables sending SMS messages to Sri Lankan mobile numbers through Adeona Technologies' gateway.

## Platform Overview
ADA Digital Reach is an enterprise SMS gateway serving Sri Lanka. It supports:
- **Standard SMS** — Plain text messages via mobile networks (channel 61)
- **Data Campaign SMS** — Unicode/Sinhala-capable messages via data channels (channel 55)
- Both **single** and **bulk** sending modes
- **Delivery tracking** via campaign IDs

## Available Tools

### 1. send_single_sms
Send a standard SMS to ONE Sri Lankan mobile number.
- Best for: Transactional messages, OTP, alerts, notifications
- Channel: 61 (standard SMS)
- Limitation: 160 character limit per segment (English only)

### 2. send_bulk_sms
Send a standard SMS to MULTIPLE Sri Lankan mobile numbers at once.
- Best for: Promotional campaigns, mass notifications
- Channel: 61 (standard SMS)
- All recipients receive the same message

### 3. send_data_sms
Send a data campaign SMS to ONE number. Supports Unicode/Sinhala text.
- Best for: Sinhala messages, long messages, rich text
- Channel: 55 (data campaign)
- No 160-char limit (uses data channel)

### 4. send_data_bulk_sms
Send a data campaign SMS to MULTIPLE numbers. Supports Unicode/Sinhala text.
- Best for: Bulk Sinhala messages, large campaign blasts
- Channel: 55 (data campaign)

### 5. get_delivery_status
Check whether an SMS campaign was delivered successfully.
- Requires a campaign ID (returned when you send an SMS)

## Phone Number Format
All phone numbers MUST be Sri Lankan mobile numbers in this format:
- **Required format**: 94XXXXXXXXX (e.g., 94771234567)
- Country code 94 + 9-digit mobile number
- The system auto-normalizes: +94..., 07..., 7... formats are converted automatically
- Example conversions:
  - +94771234567 → 94771234567
  - 0771234567 → 94771234567
  - 771234567 → 94771234567

## Best Practices
1. **Always confirm before sending** — Ask the user to verify the phone number and message before sending
2. **Validate phone numbers** — Ensure numbers look like valid Sri Lankan mobiles
3. **Use data campaigns for Sinhala** — Standard SMS (channel 61) doesn't support Unicode; use data campaigns (channel 55)
4. **Track delivery** — After sending, offer to check delivery status using the campaign ID
5. **Handle errors gracefully** — If sending fails, explain the error clearly and suggest fixes
6. **Respect wallet balance** — If you see error codes 114/115, stop sending and alert the user about insufficient balance

## Error Handling
The system provides clear error messages. Key error codes:
- **104/105**: Token expired — automatic retry happens
- **114**: Insufficient wallet balance — STOP and alert the user
- **115**: Wallet suspended — STOP and alert the user
- **103**: Invalid phone format — ask the user to correct the number
- **106**: Missing parameters — check that phone number and message are provided

## Channel Reference
| Channel | Type | Use Case | Unicode Support |
|---------|------|----------|-----------------|
| 61 | Standard SMS | Transactional, alerts | No (English/digits only) |
| 55 | Data Campaign | Sinhala, long messages | Yes (full Unicode) |
`;

// ─── Tool Definitions ───────────────────────────────────────────────────────

const tools = [
  {
    name: "send_single_sms",
    description:
      "Send a standard SMS to a single Sri Lankan mobile number via ADA Digital Reach. " +
      "Use this for transactional messages, OTP codes, alerts, or notifications. " +
      "This uses the standard SMS channel (61) which supports English text up to 160 characters per segment. " +
      "For Sinhala/Unicode messages, use send_data_sms instead. " +
      "Phone numbers are auto-normalized (e.g., +94771234567, 0771234567 → 94771234567).",
    inputSchema: {
      type: "object",
      properties: {
        phoneNumber: {
          type: "string",
          description:
            "Sri Lankan mobile number. Accepted formats: 94XXXXXXXXX, +94XXXXXXXXX, 07XXXXXXXX, or 7XXXXXXXX. " +
            "Auto-normalized to 94XXXXXXXXX. Example: 94771234567",
        },
        message: {
          type: "string",
          description:
            "The SMS message text. Standard SMS supports up to 160 English characters per segment. " +
            "Longer messages are split into multiple segments (higher cost). " +
            "For Sinhala or Unicode text, use send_data_sms instead.",
        },
        senderId: {
          type: "string",
          description:
            'Sender name displayed on the recipient\'s phone. Defaults to the configured sender ID (typically "R trans"). ' +
            "Must be pre-registered with the gateway.",
        },
        channel: {
          type: "string",
          description:
            "SMS gateway channel ID. Defaults to '61' (standard SMS). " +
            "Only change this if you have a specific channel assigned to your account.",
        },
        callbackUrl: {
          type: "string",
          description:
            "URL to receive delivery status callbacks via HTTP POST. " +
            'Defaults to "." (no callback). Provide a publicly accessible URL to receive real-time delivery updates.',
        },
      },
      required: ["phoneNumber", "message"],
    },
  },
  {
    name: "send_bulk_sms",
    description:
      "Send the same standard SMS to multiple Sri Lankan mobile numbers at once via ADA Digital Reach. " +
      "Use this for promotional campaigns, mass notifications, or group alerts. " +
      "All recipients receive the identical message. This uses the standard SMS channel (61). " +
      "For bulk Sinhala/Unicode messages, use send_data_bulk_sms instead. " +
      "Phone numbers are auto-normalized.",
    inputSchema: {
      type: "object",
      properties: {
        phoneNumbers: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of Sri Lankan mobile numbers. Each can be in any accepted format " +
            "(94XXXXXXXXX, +94XXXXXXXXX, 07XXXXXXXX). All are auto-normalized. " +
            "Example: [\"94771234567\", \"94761234567\"]",
        },
        message: {
          type: "string",
          description:
            "The SMS message text sent to ALL recipients. Standard SMS supports up to 160 English characters. " +
            "For Sinhala or Unicode text, use send_data_bulk_sms instead.",
        },
        senderId: {
          type: "string",
          description:
            'Sender name displayed on recipients\' phones. Defaults to the configured sender ID (typically "R trans").',
        },
        channel: {
          type: "string",
          description:
            "SMS gateway channel ID. Defaults to '61' (standard SMS).",
        },
        callbackUrl: {
          type: "string",
          description:
            'URL to receive delivery status callbacks. Defaults to "." (no callback).',
        },
      },
      required: ["phoneNumbers", "message"],
    },
  },
  {
    name: "send_data_sms",
    description:
      "Send a data campaign SMS to a single Sri Lankan mobile number via ADA Digital Reach. " +
      "Use this for messages containing Sinhala (සිංහල), Tamil, or other Unicode characters, " +
      "or for longer messages that exceed the 160-character standard SMS limit. " +
      "This uses the data campaign channel (55) which supports full Unicode. " +
      "Phone numbers are auto-normalized.",
    inputSchema: {
      type: "object",
      properties: {
        phoneNumber: {
          type: "string",
          description:
            "Sri Lankan mobile number. Accepted formats: 94XXXXXXXXX, +94XXXXXXXXX, 07XXXXXXXX, or 7XXXXXXXX. " +
            "Auto-normalized to 94XXXXXXXXX. Example: 94771234567",
        },
        message: {
          type: "string",
          description:
            "The SMS message text. Supports full Unicode including Sinhala (සිංහල), Tamil, and special characters. " +
            "No practical character limit via data channel.",
        },
        senderId: {
          type: "string",
          description:
            'Sender name displayed on the recipient\'s phone. Defaults to the configured sender ID (typically "R trans").',
        },
        channel: {
          type: "string",
          description:
            "Data campaign channel ID. Defaults to '55' (data campaign). Only change if you have a custom data channel.",
        },
        callbackUrl: {
          type: "string",
          description:
            'URL to receive delivery status callbacks. Defaults to "." (no callback).',
        },
        startTime: {
          type: "string",
          description:
            'When to start sending. Format: "YYYY-MM-DD HH:mm:ss" (e.g., "2026-06-16 14:30:00"). ' +
            "Defaults to now. Use this to schedule future sends.",
        },
        endTime: {
          type: "string",
          description:
            'Campaign expiry time. Format: "YYYY-MM-DD HH:mm:ss". ' +
            "Defaults to 24 hours from now. Messages not delivered by this time are discarded.",
        },
      },
      required: ["phoneNumber", "message"],
    },
  },
  {
    name: "send_data_bulk_sms",
    description:
      "Send a data campaign SMS to multiple Sri Lankan mobile numbers at once via ADA Digital Reach. " +
      "Use this for bulk campaigns with Sinhala (සිංහල), Tamil, or Unicode content, " +
      "or for longer messages. This uses the data campaign channel (55). " +
      "All recipients receive the identical message. Phone numbers are auto-normalized.",
    inputSchema: {
      type: "object",
      properties: {
        phoneNumbers: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of Sri Lankan mobile numbers. Each can be in any accepted format. " +
            "All are auto-normalized to 94XXXXXXXXX. Example: [\"94771234567\", \"94761234567\"]",
        },
        message: {
          type: "string",
          description:
            "The SMS message text sent to ALL recipients. Supports full Unicode including Sinhala (සිංහල) and Tamil.",
        },
        senderId: {
          type: "string",
          description:
            'Sender name displayed on recipients\' phones. Defaults to the configured sender ID (typically "R trans").',
        },
        channel: {
          type: "string",
          description:
            "Data campaign channel ID. Defaults to '55' (data campaign).",
        },
        callbackUrl: {
          type: "string",
          description:
            'URL to receive delivery status callbacks. Defaults to "." (no callback).',
        },
        endTime: {
          type: "string",
          description:
            'Campaign expiry time. Format: "YYYY-MM-DD HH:mm:ss". Defaults to 24 hours from now.',
        },
      },
      required: ["phoneNumbers", "message"],
    },
  },
  {
    name: "get_delivery_status",
    description:
      "Check the delivery status of a previously sent SMS campaign via ADA Digital Reach. " +
      "Use the campaign ID that was returned when you sent the SMS. " +
      "This shows how many messages were delivered, failed, or are still pending.",
    inputSchema: {
      type: "object",
      properties: {
        campaignId: {
          type: "string",
          description:
            "The campaign ID returned from a previous send_single_sms, send_bulk_sms, " +
            "send_data_sms, or send_data_bulk_sms call. This is the unique identifier for the campaign.",
        },
      },
      required: ["campaignId"],
    },
  },
];

// ─── Tool Handlers ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "send_single_sms":
        return await _handleSendSingleSms(args);

      case "send_bulk_sms":
        return await _handleSendBulkSms(args);

      case "send_data_sms":
        return await _handleSendDataSms(args);

      case "send_data_bulk_sms":
        return await _handleSendDataBulkSms(args);

      case "get_delivery_status":
        return await _handleGetDeliveryStatus(args);

      default:
        return _errorResponse(`Unknown tool: "${name}". Available tools: ${tools.map((t) => t.name).join(", ")}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: formatExecutionError(name, error),
        },
      ],
      isError: true,
    };
  }
});

// ─── Resource Handlers ──────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "ada://system-prompt",
      name: "ADA Digital Reach — AI Agent Guide",
      description:
        "Comprehensive guide for AI agents on how to use the ADA Digital Reach SMS platform. " +
        "Includes tool selection guidance, phone number formats, channel reference, " +
        "error handling, and best practices.",
      mimeType: "text/plain",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === "ada://system-prompt") {
    return {
      contents: [
        {
          uri: "ada://system-prompt",
          mimeType: "text/plain",
          text: SYSTEM_PROMPT,
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// ─── Tool Handler Implementations ───────────────────────────────────────────

async function _handleSendSingleSms(args) {
  // Normalize phone number
  const normalized = normalizePhoneNumber(args.phoneNumber);

  // Validate inputs
  const phoneValidation = validatePhoneNumber(normalized.value);
  if (!phoneValidation.valid) {
    return _errorResponse(formatValidationError("send_single_sms", phoneValidation.error));
  }

  const msgValidation = validateMessage(args.message, false);
  if (!msgValidation.valid) {
    return _errorResponse(formatValidationError("send_single_sms", msgValidation.error));
  }

  const channelValidation = validateChannel(args.channel);

  // Collect warnings
  const warnings = [
    ...(msgValidation.warnings || []),
    ...(channelValidation.warnings || []),
  ];
  if (normalized.normalized) {
    warnings.push(`Phone number auto-normalized: "${normalized.original}" → "${normalized.value}"`);
  }

  // Send
  const result = await adaClient.sendSingleSms(
    normalized.value,
    args.message,
    args.senderId,
    args.channel,
    args.callbackUrl
  );

  return _successResponse(
    formatSmsResponse("send_single_sms", result, {
      phoneNumber: normalized.value,
      messagePreview: args.message,
      channel: args.channel || process.env.ADA_DEFAULT_CHANNEL || "61",
      warnings,
    })
  );
}

async function _handleSendBulkSms(args) {
  // Normalize all phone numbers
  const normalizedNums = args.phoneNumbers.map((n) => normalizePhoneNumber(n));
  const normalizedValues = normalizedNums.map((n) => n.value);
  const wasNormalized = normalizedNums.filter((n) => n.normalized);

  // Validate
  const phoneValidation = validatePhoneNumbers(normalizedValues);
  if (!phoneValidation.valid) {
    return _errorResponse(formatValidationError("send_bulk_sms", phoneValidation.error));
  }

  const msgValidation = validateMessage(args.message, false);
  if (!msgValidation.valid) {
    return _errorResponse(formatValidationError("send_bulk_sms", msgValidation.error));
  }

  const channelValidation = validateChannel(args.channel);

  const warnings = [
    ...(msgValidation.warnings || []),
    ...(channelValidation.warnings || []),
  ];
  if (wasNormalized.length > 0) {
    warnings.push(
      `${wasNormalized.length} phone number(s) were auto-normalized to 94XXXXXXXXX format.`
    );
  }

  const result = await adaClient.sendBulkSms(
    normalizedValues,
    args.message,
    args.senderId,
    args.channel,
    args.callbackUrl
  );

  return _successResponse(
    formatSmsResponse("send_bulk_sms", result, {
      recipientCount: normalizedValues.length,
      messagePreview: args.message,
      channel: args.channel || process.env.ADA_DEFAULT_CHANNEL || "61",
      warnings,
    })
  );
}

async function _handleSendDataSms(args) {
  const normalized = normalizePhoneNumber(args.phoneNumber);

  const phoneValidation = validatePhoneNumber(normalized.value);
  if (!phoneValidation.valid) {
    return _errorResponse(formatValidationError("send_data_sms", phoneValidation.error));
  }

  const msgValidation = validateMessage(args.message, true);
  if (!msgValidation.valid) {
    return _errorResponse(formatValidationError("send_data_sms", msgValidation.error));
  }

  const startTimeValidation = validateDateTime(args.startTime, "startTime");
  if (!startTimeValidation.valid) {
    return _errorResponse(formatValidationError("send_data_sms", startTimeValidation.error));
  }

  const endTimeValidation = validateDateTime(args.endTime, "endTime");
  if (!endTimeValidation.valid) {
    return _errorResponse(formatValidationError("send_data_sms", endTimeValidation.error));
  }

  const channelValidation = validateChannel(args.channel);

  const warnings = [
    ...(channelValidation.warnings || []),
  ];
  if (normalized.normalized) {
    warnings.push(`Phone number auto-normalized: "${normalized.original}" → "${normalized.value}"`);
  }

  const result = await adaClient.sendDataSms(
    normalized.value,
    args.message,
    args.senderId,
    args.channel,
    args.callbackUrl,
    args.endTime,
    args.startTime
  );

  return _successResponse(
    formatSmsResponse("send_data_sms", result, {
      phoneNumber: normalized.value,
      messagePreview: args.message,
      channel: args.channel || "55",
      warnings,
    })
  );
}

async function _handleSendDataBulkSms(args) {
  const normalizedNums = args.phoneNumbers.map((n) => normalizePhoneNumber(n));
  const normalizedValues = normalizedNums.map((n) => n.value);
  const wasNormalized = normalizedNums.filter((n) => n.normalized);

  const phoneValidation = validatePhoneNumbers(normalizedValues);
  if (!phoneValidation.valid) {
    return _errorResponse(formatValidationError("send_data_bulk_sms", phoneValidation.error));
  }

  const msgValidation = validateMessage(args.message, true);
  if (!msgValidation.valid) {
    return _errorResponse(formatValidationError("send_data_bulk_sms", msgValidation.error));
  }

  const endTimeValidation = validateDateTime(args.endTime, "endTime");
  if (!endTimeValidation.valid) {
    return _errorResponse(formatValidationError("send_data_bulk_sms", endTimeValidation.error));
  }

  const channelValidation = validateChannel(args.channel);

  const warnings = [
    ...(channelValidation.warnings || []),
  ];
  if (wasNormalized.length > 0) {
    warnings.push(
      `${wasNormalized.length} phone number(s) were auto-normalized to 94XXXXXXXXX format.`
    );
  }

  const result = await adaClient.sendDataBulkSms(
    normalizedValues,
    args.message,
    args.senderId,
    args.channel,
    args.callbackUrl,
    args.endTime
  );

  return _successResponse(
    formatSmsResponse("send_data_bulk_sms", result, {
      recipientCount: normalizedValues.length,
      messagePreview: args.message,
      channel: args.channel || "55",
      warnings,
    })
  );
}

async function _handleGetDeliveryStatus(args) {
  if (!args.campaignId || typeof args.campaignId !== "string" || args.campaignId.trim().length === 0) {
    return _errorResponse(
      formatValidationError(
        "get_delivery_status",
        "Campaign ID is required. Provide the ID returned from a previous SMS send operation."
      )
    );
  }

  const result = await adaClient.getDeliveryStatus(args.campaignId.trim());

  return _successResponse(formatDeliveryStatusResponse(result));
}

// ─── Response Helpers ───────────────────────────────────────────────────────

function _successResponse(text) {
  return {
    content: [{ type: "text", text }],
  };
}

function _errorResponse(text) {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

// ─── Server Start ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ADA Digital Reach MCP Server v2.0.0 running on stdio");
}

main().catch(console.error);
