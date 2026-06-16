import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logFilePath = path.join(__dirname, "..", "api.log");

function logToFile(message, data = null) {
  const timestamp = new Date().toISOString();
  let logMessage = `[${timestamp}] ${message}\n`;
  if (data) {
    logMessage += `${JSON.stringify(data, null, 2)}\n`;
  }
  try {
    fs.appendFileSync(logFilePath, logMessage, "utf8");
  } catch (err) {
    console.error("Failed to write to log file:", err);
  }
}

class AdaClient {
  constructor() {
    // Strip trailing slashes from base URL
    this.baseUrl = (process.env.ADA_BASE_URL || "").replace(/\/+$/, "");
    this.username = process.env.ADA_USERNAME;
    this.password = process.env.ADA_PASSWORD;
    this.tokenUrl = process.env.ADA_TOKEN_URL;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  _buildUrl(endpointPath) {
    // Strip leading slashes from endpoint path
    const cleanPath = endpointPath.replace(/^\/+/, "");
    return `${this.baseUrl}/${cleanPath}`;
  }

  async getToken(forceRefresh = false) {
    if (!forceRefresh && this.token && Date.now() < this.tokenExpiresAt) {
      return this.token;
    }

    const targetUrl = this._buildUrl(this.tokenUrl);
    const response = await axios.post(targetUrl, {
      u_name: this.username,
      passwd: this.password,
    });

    this.token = response.data?.access_token || response.data?.token;
    if (!this.token) {
      throw new Error("Failed to obtain authentication token from ADA");
    }

    // Cache token for 24 hours
    this.tokenExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    return this.token;
  }

  async _request(method, url, data = null, params = null) {
    let isRetry = false;
    
    while (true) {
      const token = await this.getToken();
      const fullUrl = this._buildUrl(url);
      const config = { 
        method, 
        url: fullUrl,
        headers: { Authorization: token }
      };

      if (data) config.data = data;
      if (params) config.params = params;

      logToFile(`[ADA Client] Request: ${method.toUpperCase()} ${fullUrl}`);
      if (params) logToFile(`[ADA Client] Request Params:`, params);
      if (data) logToFile(`[ADA Client] Request Data:`, data);

      try {
        const response = await axios(config);

        logToFile(`[ADA Client] Response Status: ${response.status}`);
        logToFile(`[ADA Client] Response Data:`, response.data);

        // Some APIs return 200 OK but have an error code in the response body
        const errVal = response.data?.error;
        if (errVal !== undefined && errVal !== "0" && errVal !== 0) {
          const responseCode = parseInt(errVal, 10);

          if (responseCode === 104 || responseCode === 105) {
            if (!isRetry) {
              this.token = null;
              await this.getToken(true);
              isRetry = true;
              continue;
            }
            throw new Error(`Authentication failed with code ${responseCode}: Invalid/Expired token after retry`);
          }

          if (responseCode === 114 || responseCode === 115) {
            throw new Error(
              `Wallet issue (${responseCode}): Stop and alert. Please check your account balance.`
            );
          }

          throw new Error(`ADA API Error (${responseCode}): Request failed.`);
        }

        return response.data;
      } catch (error) {
        logToFile(`[ADA Client] Request Failed: ${error.message}`);
        if (error.response) {
          logToFile(
            `[ADA Client] Error Response Status: ${error.response.status}`
          );
          logToFile(`[ADA Client] Error Response Data:`, error.response.data);
        }

        const errVal = error.response?.data?.error;
        if (errVal !== undefined) {
          const code = parseInt(errVal, 10);
          
          if (!isRetry && (code === 104 || code === 105)) {
            this.token = null; 
            await this.getToken(true);
            isRetry = true;
            continue;
          }

          if (code === 114 || code === 115) {
            throw new Error(
              `Wallet issue (${code}): Stop and alert. Please check your account balance. ${error.message}`
            );
          }
        }

        throw error;
      }
    }
  }

  _getFormattedDate(date) {
    const pad = (n) => (n < 10 ? "0" + n : n);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
      date.getDate()
    )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
      date.getSeconds()
    )}`;
  }

  async sendSingleSms(phoneNumber, message, senderId, channel, callbackUrl = "") {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const finalSenderId = senderId || process.env.ADA_DEFAULT_SENDER_ID;
    const finalChannel = channel || process.env.ADA_DEFAULT_CHANNEL || "1";

    const payload = {
      msisdn: phoneNumber,
      channel: String(finalChannel),
      mt_port: finalSenderId,
      s_time: this._getFormattedDate(now),
      e_time: this._getFormattedDate(tomorrow),
      msg: message,
      callback_url: callbackUrl || ".",
    };

    const smsUrl = process.env.ADA_SMS_URL || "/sms-campaign/send-sms";
    return this._request("post", smsUrl, payload);
  }

  async sendBulkSms(phoneNumbers, message, senderId, channel, callbackUrl = "") {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const finalSenderId = senderId || process.env.ADA_DEFAULT_SENDER_ID;
    const finalChannel = channel || process.env.ADA_DEFAULT_CHANNEL || "1";

    const payload = {
      msisdn: phoneNumbers,
      channel: String(finalChannel),
      mt_port: finalSenderId,
      s_time: this._getFormattedDate(now),
      e_time: this._getFormattedDate(tomorrow),
      msg: message,
      callback_url: callbackUrl || ".",
    };

    const bulkUrl = process.env.ADA_BULK_SMS_URL || "/sms-campaign/send-bulk-sms";
    return this._request("post", bulkUrl, payload);
  }

  async sendDataBulkSms(phoneNumbers, message, senderId, channel, callbackUrl = "", endTime = "") {
    const finalSenderId = senderId || process.env.ADA_DEFAULT_SENDER_ID;
    const finalChannel = channel || process.env.ADA_DEFAULT_CHANNEL || "1";

    let finalEndTime = endTime;
    if (!finalEndTime) {
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      finalEndTime = this._getFormattedDate(tomorrow);
    }

    const payload = {
      msisdn: phoneNumbers,
      channel: String(finalChannel),
      mt_port: finalSenderId,
      e_time: finalEndTime,
      msg: message,
      callback_url: callbackUrl || ".",
    };

    const dataBulkUrl = process.env.ADA_DATA_BULK_SMS_URL || "/sms-campaign/data/send-bulk-sms";
    return this._request("post", dataBulkUrl, payload);
  }

  async sendDataSms(phoneNumber, message, senderId, channel, callbackUrl = "", endTime = "", startTime = "") {
    const finalSenderId = senderId || process.env.ADA_DEFAULT_SENDER_ID;
    const finalChannel = channel || process.env.ADA_DEFAULT_CHANNEL || "1";

    const now = new Date();
    let finalStartTime = startTime;
    if (!finalStartTime) {
      finalStartTime = this._getFormattedDate(now);
    }

    let finalEndTime = endTime;
    if (!finalEndTime) {
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      finalEndTime = this._getFormattedDate(tomorrow);
    }

    const payload = {
      msisdn: phoneNumber,
      channel: String(finalChannel),
      mt_port: finalSenderId,
      s_time: finalStartTime,
      e_time: finalEndTime,
      msg: message,
      callback_url: callbackUrl || ".",
    };

    const dataUrl = process.env.ADA_DATA_SMS_URL || "/sms-campaign/data/send-sms";
    return this._request("post", dataUrl, payload);
  }

  async getDeliveryStatus(campaignId) {
    const deliveryUrl = process.env.ADA_DELIVERY_URL || "/delivery-status";
    return this._request("get", deliveryUrl, null, { campaignId });
  }
}

export default new AdaClient();