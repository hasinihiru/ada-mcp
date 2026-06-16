import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const baseUrl = (process.env.ADA_BASE_URL || "").replace(/\/+$/, "");
const username = process.env.ADA_USERNAME || 'testapiuser';
const password = process.env.ADA_PASSWORD || 'Test@1234';
const tokenUrl = process.env.ADA_TOKEN_URL || '/login/api-based';

async function test() {
  console.log("1. Fetching token...");
  const targetTokenUrl = `${baseUrl}/${tokenUrl.replace(/^\/+/, "")}`;
  let token;
  try {
    const res = await axios.post(targetTokenUrl, {
      u_name: username,
      passwd: password,
    });
    token = res.data?.access_token || res.data?.token;
    console.log("Token response:", res.data);
  } catch (e) {
    console.log("Token error:", e.message, e.response?.data);
    return;
  }

  if (!token) return;

  const payload = {
    msisdn: "94766340950",
    channel: "61",
    mt_port: "R trans",
    s_time: "2026-06-15 14:28:22",
    e_time: "2026-06-16 14:28:22",
    msg: "Hello from test script using raw token header",
    callback_url: "."
  };

  const targetSmsUrl = `${baseUrl}/sms-campaign/send-sms`;

  console.log(`2. Testing POST to ${targetSmsUrl} with raw token in Authorization header...`);
  try {
    const res = await axios.post(targetSmsUrl, payload, {
      headers: { Authorization: token } // No 'Bearer ' prefix!
    });
    console.log("Response:", res.data);
  } catch (e) {
    console.log("Error:", e.response?.data || e.message);
  }
}

test();
