import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import adaClient from "./adaClient.js";

const server = new Server(
  {
    name: "ada-digital-reach-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Define all available tools
const tools = [
  {
    name: "send_single_sms",
    description: "Send an SMS to a single phone number via ADA Digital Reach",
    inputSchema: {
      type: "object",
      properties: {
        phoneNumber: {
          type: "string",
          description: "The recipient phone number (e.g., +15551234567)",
        },
        message: {
          type: "string",
          description: "The SMS message text (up to 160 characters)",
        },
        senderId: {
          type: "string",
          description: "Optional sender ID or name to display (defaults to ADA_DEFAULT_SENDER_ID in .env)",
        },
        channel: {
          type: "string",
          description: "Optional channel ID to use (defaults to ADA_DEFAULT_CHANNEL in .env, or '1')",
        },
        callbackUrl: {
          type: "string",
          description: "Optional callback URL for delivery status updates (defaults to '.' if not set)",
        },
      },
      required: ["phoneNumber", "message"],
    },
  },
  {
    name: "send_bulk_sms",
    description: "Send SMS to multiple phone numbers at once",
    inputSchema: {
      type: "object",
      properties: {
        phoneNumbers: {
          type: "array",
          items: { type: "string" },
          description: "Array of phone numbers to send to",
        },
        message: {
          type: "string",
          description: "The SMS message text",
        },
        senderId: {
          type: "string",
          description: "Optional sender ID or name (defaults to ADA_DEFAULT_SENDER_ID in .env)",
        },
        channel: {
          type: "string",
          description: "Optional channel ID to use (defaults to ADA_DEFAULT_CHANNEL in .env, or '1')",
        },
        callbackUrl: {
          type: "string",
          description: "Optional callback URL for delivery status updates (defaults to '.' if not set)",
        },
      },
      required: ["phoneNumbers", "message"],
    },
  },
  {
    name: "get_delivery_status",
    description: "Check the delivery status of an SMS campaign",
    inputSchema: {
      type: "object",
      properties: {
        campaignId: {
          type: "string",
          description: "The campaign ID returned from sending SMS",
        },
      },
      required: ["campaignId"],
    },
  },
  {
    name: "send_data_bulk_sms",
    description: "Send data campaign bulk SMS to multiple phone numbers at once via ADA Digital Reach",
    inputSchema: {
      type: "object",
      properties: {
        phoneNumbers: {
          type: "array",
          items: { type: "string" },
          description: "Array of phone numbers to send to",
        },
        message: {
          type: "string",
          description: "The SMS message text (can include Sinhala/Unicode characters)",
        },
        senderId: {
          type: "string",
          description: "Optional sender ID or name (defaults to ADA_DEFAULT_SENDER_ID in .env)",
        },
        channel: {
          type: "string",
          description: "Optional channel ID to use (defaults to ADA_DEFAULT_CHANNEL in .env, or '1')",
        },
        callbackUrl: {
          type: "string",
          description: "Optional callback URL for delivery status updates (defaults to '.' if not set)",
        },
        endTime: {
          type: "string",
          description: "Optional end time in YYYY-MM-DD HH:mm:ss format (defaults to 24 hours from now)",
        },
      },
      required: ["phoneNumbers", "message"],
    },
  },
  {
    name: "send_data_sms",
    description: "Send a data campaign SMS to a single phone number via ADA Digital Reach",
    inputSchema: {
      type: "object",
      properties: {
        phoneNumber: {
          type: "string",
          description: "The recipient phone number (e.g., +15551234567)",
        },
        message: {
          type: "string",
          description: "The SMS message text (can include Sinhala/Unicode characters)",
        },
        senderId: {
          type: "string",
          description: "Optional sender ID or name (defaults to ADA_DEFAULT_SENDER_ID in .env)",
        },
        channel: {
          type: "string",
          description: "Optional channel ID to use (defaults to ADA_DEFAULT_CHANNEL in .env, or '1')",
        },
        callbackUrl: {
          type: "string",
          description: "Optional callback URL for delivery status updates (defaults to '.' if not set)",
        },
        endTime: {
          type: "string",
          description: "Optional end time in YYYY-MM-DD HH:mm:ss format (defaults to 24 hours from now)",
        },
        startTime: {
          type: "string",
          description: "Optional start time in YYYY-MM-DD HH:mm:ss format (defaults to now)",
        },
      },
      required: ["phoneNumber", "message"],
    },
  },
];

// Handle tool list requests
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

// Handle tool execution requests
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case "send_single_sms":
        result = await adaClient.sendSingleSms(
          args.phoneNumber,
          args.message,
          args.senderId,
          args.channel,
          args.callbackUrl
        );
        break;

      case "send_bulk_sms":
        result = await adaClient.sendBulkSms(
          args.phoneNumbers,
          args.message,
          args.senderId,
          args.channel,
          args.callbackUrl
        );
        break;

      case "send_data_bulk_sms":
        result = await adaClient.sendDataBulkSms(
          args.phoneNumbers,
          args.message,
          args.senderId,
          args.channel,
          args.callbackUrl,
          args.endTime
        );
        break;

      case "send_data_sms":
        result = await adaClient.sendDataSms(
          args.phoneNumber,
          args.message,
          args.senderId,
          args.channel,
          args.callbackUrl,
          args.endTime,
          args.startTime
        );
        break;

      case "get_delivery_status":
        result = await adaClient.getDeliveryStatus(args.campaignId);
        break;

      default:
        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: ${name}`,
            },
          ],
          isError: true,
        };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error executing ${name}: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ADA Digital Reach MCP Server running on stdio");
}

main().catch(console.error);
