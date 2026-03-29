// src/services/mpesa.js
// Safaricom Daraja API integration for FarmAd
//
// SETUP (add these to your .env):
//   MPESA_CONSUMER_KEY       – from Daraja app
//   MPESA_CONSUMER_SECRET    – from Daraja app
//   MPESA_SHORTCODE          – your Till/Paybill number (or 174379 for sandbox)
//   MPESA_PASSKEY            – from Daraja portal (or sandbox passkey)
//   MPESA_CALLBACK_URL       – public HTTPS URL e.g. https://yourdomain.com/api/payments/mpesa/callback
//   MPESA_ENV                – 'sandbox' | 'production'
//
// SANDBOX TESTING:
//   Use phone: 254708374149  (Safaricom test number that always succeeds)
//   Shortcode: 174379
//   Passkey: bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919

require('dotenv').config();

const MPESA_ENV        = process.env.MPESA_ENV || 'sandbox';
const BASE_URL         = MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

const CONSUMER_KEY     = process.env.MPESA_CONSUMER_KEY    || 'YOUR_CONSUMER_KEY';
const CONSUMER_SECRET  = process.env.MPESA_CONSUMER_SECRET || 'YOUR_CONSUMER_SECRET';
const SHORTCODE        = process.env.MPESA_SHORTCODE       || '174379';
const PASSKEY          = process.env.MPESA_PASSKEY         || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const CALLBACK_URL     = process.env.MPESA_CALLBACK_URL    || 'https://your-server.com/api/payments/mpesa/callback';

// ─── Get OAuth Access Token ───────────────────────────────────────────────────
async function getAccessToken() {
  const credentials = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');

  const response = await fetch(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    method: 'GET',
    headers: { Authorization: `Basic ${credentials}` }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`M-Pesa token error: ${response.status} — ${text}`);
  }

  const data = await response.json();
  return data.access_token;
}

// ─── Build timestamp and password ────────────────────────────────────────────
function getTimestampAndPassword() {
  const now       = new Date();
  const pad       = n => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}` +
                    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const password  = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');
  return { timestamp, password };
}

// ─── Normalise phone to 2547XXXXXXXX format ──────────────────────────────────
function normaliseMpesaPhone(phone) {
  const cleaned = String(phone).replace(/\s+/g, '');
  if (cleaned.startsWith('+254')) return cleaned.slice(1);   // +254... → 254...
  if (cleaned.startsWith('07'))   return '254' + cleaned.slice(1);  // 07... → 2547...
  if (cleaned.startsWith('01'))   return '254' + cleaned.slice(1);  // 01... → 2541...
  if (cleaned.startsWith('254'))  return cleaned;
  return cleaned;
}

// ─── STK Push (Lipa Na M-Pesa Online) ────────────────────────────────────────
// Initiates a payment prompt on the customer's phone
async function stkPush({ phone, amount, orderId, description }) {
  const accessToken            = await getAccessToken();
  const { timestamp, password } = getTimestampAndPassword();
  const normalisedPhone        = normaliseMpesaPhone(phone);
  const roundedAmount          = Math.ceil(amount); // M-Pesa requires whole numbers

  const payload = {
    BusinessShortCode: SHORTCODE,
    Password:          password,
    Timestamp:         timestamp,
    TransactionType:   'CustomerPayBillOnline',    // or 'CustomerBuyGoodsOnline' for Till
    Amount:            roundedAmount,
    PartyA:            normalisedPhone,            // customer phone
    PartyB:            SHORTCODE,
    PhoneNumber:       normalisedPhone,            // phone to prompt
    CallBackURL:       CALLBACK_URL,
    AccountReference:  `FARMAD-${orderId.slice(0,8).toUpperCase()}`,
    TransactionDesc:   description || 'FarmAd Payment'
  };

  const response = await fetch(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok || data.ResponseCode !== '0') {
    throw new Error(data.errorMessage || data.CustomerMessage || 'STK push failed');
  }

  return {
    checkoutRequestId: data.CheckoutRequestID,
    merchantRequestId: data.MerchantRequestID,
    responseDescription: data.ResponseDescription,
    customerMessage:     data.CustomerMessage
  };
}

// ─── STK Push Query (check status of a pending payment) ──────────────────────
async function stkQuery(checkoutRequestId) {
  const accessToken            = await getAccessToken();
  const { timestamp, password } = getTimestampAndPassword();

  const response = await fetch(`${BASE_URL}/mpesa/stkpushquery/v1/query`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      BusinessShortCode: SHORTCODE,
      Password:          password,
      Timestamp:         timestamp,
      CheckoutRequestID: checkoutRequestId
    })
  });

  const data = await response.json();
  return data;
}

// ─── Parse M-Pesa callback body ───────────────────────────────────────────────
// Returns a clean object from Safaricom's callback JSON
function parseCallback(body) {
  try {
    const stk         = body.Body?.stkCallback;
    const resultCode  = stk?.ResultCode;
    const resultDesc  = stk?.ResultDesc;
    const checkoutId  = stk?.CheckoutRequestID;
    const merchantId  = stk?.MerchantRequestID;

    // Success: ResultCode === 0
    if (resultCode !== 0) {
      return { success: false, resultCode, resultDesc, checkoutId, merchantId };
    }

    // Extract metadata items
    const items = stk?.CallbackMetadata?.Item || [];
    const meta  = {};
    for (const item of items) {
      meta[item.Name] = item.Value;
    }

    return {
      success:         true,
      resultCode,
      resultDesc,
      checkoutId,
      merchantId,
      amount:          meta.Amount,
      mpesaReceipt:    meta.MpesaReceiptNumber,
      transactionDate: String(meta.TransactionDate),
      phoneUsed:       String(meta.PhoneNumber)
    };
  } catch (err) {
    throw new Error(`Failed to parse M-Pesa callback: ${err.message}`);
  }
}

module.exports = { stkPush, stkQuery, parseCallback, normaliseMpesaPhone };
