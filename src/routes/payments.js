// src/routes/payments.js — FarmAd Payments API (PostgreSQL)
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db/database');
const { authenticate, requireRole } = require('../middleware/auth');
const mpesa = require('../services/mpesa');

const router = express.Router();

// ── POST /api/payments/mpesa/initiate ────────────────────────────────────────
router.post('/mpesa/initiate', authenticate, requireRole('buyer'), async (req, res) => {
  const { order_id, phone: overridePhone } = req.body;
  if (!order_id) return res.status(400).json({ success: false, message: 'order_id is required.' });

  try {
    const order = await queryOne('SELECT * FROM orders WHERE id = $1', [order_id]);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.buyer_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (order.status === 'cancelled') return res.status(400).json({ success: false, message: 'Cannot pay for a cancelled order.' });
    if (order.status === 'pending') return res.status(400).json({ success: false, message: 'Wait for the farmer to confirm the order before paying.' });

    const existingPayment = await queryOne(
      "SELECT id FROM payments WHERE order_id = $1 AND status = 'completed'", [order_id]
    );
    if (existingPayment) return res.status(400).json({ success: false, message: 'This order has already been paid.' });

    // Cancel stale pending payments
    await execute(
      "UPDATE payments SET status = 'failed', failure_reason = 'superseded', updated_at = NOW() WHERE order_id = $1 AND status IN ('pending','processing')",
      [order_id]
    );

    const buyer      = await queryOne('SELECT phone FROM users WHERE id = $1', [req.user.id]);
    const phoneToUse = overridePhone || buyer.phone;
    const paymentId  = uuidv4();

    await execute(
      "INSERT INTO payments (id, order_id, payer_id, amount, phone, method, status) VALUES ($1,$2,$3,$4,$5,'mpesa','processing')",
      [paymentId, order_id, req.user.id, order.total_amount, phoneToUse]
    );

    let stkResult;
    try {
      stkResult = await mpesa.stkPush({ phone: phoneToUse, amount: order.total_amount, orderId: order_id, description: 'FarmAd Order Payment' });
    } catch (mpesaErr) {
      await execute(
        "UPDATE payments SET status = 'failed', failure_reason = $1, updated_at = NOW() WHERE id = $2",
        [mpesaErr.message, paymentId]
      );
      return res.status(502).json({ success: false, message: `M-Pesa error: ${mpesaErr.message}`, hint: 'Check your MPESA credentials in .env' });
    }

    await execute(
      'UPDATE payments SET mpesa_checkout_id = $1, mpesa_merchant_ref = $2, updated_at = NOW() WHERE id = $3',
      [stkResult.checkoutRequestId, stkResult.merchantRequestId, paymentId]
    );

    return res.status(200).json({
      success: true,
      message: `M-Pesa prompt sent to ${phoneToUse}. Enter your PIN to complete payment.`,
      data: { payment_id: paymentId, checkout_request_id: stkResult.checkoutRequestId, amount: order.total_amount, phone: phoneToUse, customer_message: stkResult.customerMessage }
    });
  } catch (err) {
    console.error('mpesa/initiate error:', err);
    return res.status(500).json({ success: false, message: 'Server error initiating payment.' });
  }
});

// ── POST /api/payments/mpesa/callback ────────────────────────────────────────
// Public — called by Safaricom. Always ACK immediately.
router.post('/mpesa/callback', async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const parsed  = mpesa.parseCallback(req.body);
    const rawJson = JSON.stringify(req.body);

    if (!parsed.checkoutRequestId) return;

    const payment = await queryOne(
      'SELECT * FROM payments WHERE mpesa_checkout_id = $1', [parsed.checkoutRequestId]
    );
    if (!payment) return;

    if (parsed.resultCode === 0) {
      await execute(`
        UPDATE payments SET
          status = 'completed',
          mpesa_receipt         = $1,
          mpesa_transaction_date = $2,
          mpesa_phone_used      = $3,
          mpesa_raw_callback    = $4,
          paid_at               = NOW(),
          updated_at            = NOW()
        WHERE id = $5
      `, [parsed.mpesaReceipt, parsed.transactionDate, parsed.phoneUsed, rawJson, payment.id]);

      console.log(`✅ Payment ${payment.id} completed. Receipt: ${parsed.mpesaReceipt}`);
    } else {
      await execute(`
        UPDATE payments SET
          status = 'failed',
          failure_reason     = $1,
          mpesa_raw_callback = $2,
          updated_at         = NOW()
        WHERE id = $3
      `, [`Code ${parsed.resultCode}: ${parsed.resultDesc}`, rawJson, payment.id]);

      console.log(`❌ Payment ${payment.id} failed: ${parsed.resultDesc}`);
    }
  } catch (err) {
    console.error('M-Pesa callback processing error:', err);
  }
});

// ── POST /api/payments/mpesa/query ───────────────────────────────────────────
router.post('/mpesa/query', authenticate, async (req, res) => {
  const { checkout_request_id, payment_id } = req.body;
  if (!checkout_request_id && !payment_id) {
    return res.status(400).json({ success: false, message: 'Provide checkout_request_id or payment_id.' });
  }

  try {
    let checkoutId   = checkout_request_id;
    let localPayment;

    if (payment_id) {
      localPayment = await queryOne('SELECT * FROM payments WHERE id = $1', [payment_id]);
      if (!localPayment) return res.status(404).json({ success: false, message: 'Payment not found.' });
      if (localPayment.payer_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied.' });
      checkoutId = localPayment.mpesa_checkout_id;
    }

    if (localPayment && ['completed','failed'].includes(localPayment.status)) {
      return res.status(200).json({
        success: true,
        data: { status: localPayment.status, mpesa_receipt: localPayment.mpesa_receipt, failure_reason: localPayment.failure_reason, source: 'local' }
      });
    }

    const queryResult = await mpesa.stkQuery(checkoutId);
    const success = queryResult.ResultCode === '0' || queryResult.ResultCode === 0;
    const pending = queryResult.ResultCode === undefined || queryResult.errorCode === '500.001.1001';

    return res.status(200).json({
      success: true,
      data: { status: pending ? 'processing' : (success ? 'completed' : 'failed'), result_code: queryResult.ResultCode, result_desc: queryResult.ResultDesc, source: 'safaricom' }
    });
  } catch (err) {
    return res.status(502).json({ success: false, message: `M-Pesa query error: ${err.message}` });
  }
});

// ── POST /api/payments/cash ──────────────────────────────────────────────────
router.post('/cash', authenticate, requireRole('farmer'), async (req, res) => {
  const { order_id, notes } = req.body;
  if (!order_id) return res.status(400).json({ success: false, message: 'order_id is required.' });

  try {
    const order = await queryOne('SELECT * FROM orders WHERE id = $1', [order_id]);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.farmer_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (!['ready','in_transit','delivered'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Cash payment can only be recorded when order is ready, in transit, or delivered. Current: "${order.status}"` });
    }

    const existing = await queryOne("SELECT id FROM payments WHERE order_id = $1 AND status = 'completed'", [order_id]);
    if (existing) return res.status(400).json({ success: false, message: 'This order already has a completed payment.' });

    const buyer     = await queryOne('SELECT phone FROM users WHERE id = $1', [order.buyer_id]);
    const paymentId = uuidv4();

    await execute(
      "INSERT INTO payments (id, order_id, payer_id, amount, phone, method, status, paid_at) VALUES ($1,$2,$3,$4,$5,'cash','completed',NOW())",
      [paymentId, order_id, order.buyer_id, order.total_amount, buyer.phone]
    );

    return res.status(201).json({ success: true, message: 'Cash payment recorded.', data: { payment_id: paymentId, amount: order.total_amount, method: 'cash' } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/payments/order/:orderId ─────────────────────────────────────────
router.get('/order/:orderId', authenticate, async (req, res) => {
  try {
    const order = await queryOne('SELECT buyer_id, farmer_id FROM orders WHERE id = $1', [req.params.orderId]);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.buyer_id !== req.user.id && order.farmer_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied.' });

    const payments = await query(`
      SELECT p.id, p.amount, p.phone, p.method, p.status,
             p.mpesa_receipt, p.mpesa_transaction_date, p.mpesa_phone_used,
             p.failure_reason, p.paid_at, p.created_at,
             u.name AS payer_name
      FROM payments p
      JOIN users u ON u.id = p.payer_id
      WHERE p.order_id = $1
      ORDER BY p.created_at DESC
    `, [req.params.orderId]);

    return res.status(200).json({ success: true, data: { payments } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/payments/:id ────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const payment = await queryOne(`
      SELECT p.*, o.buyer_id, o.farmer_id, o.total_amount AS order_total, u.name AS payer_name
      FROM payments p
      JOIN orders o ON o.id = p.order_id
      JOIN users  u ON u.id = p.payer_id
      WHERE p.id = $1
    `, [req.params.id]);

    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found.' });
    if (payment.buyer_id !== req.user.id && payment.farmer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const { mpesa_raw_callback, ...safe } = payment;
    return res.status(200).json({ success: true, data: { payment: safe } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
