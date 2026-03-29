// src/routes/orders.js — FarmAd Orders API (PostgreSQL)
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute, withTransaction } = require('../db/database');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const DELIVERY_FEE = 200; // KSh flat fee

function formatOrder(order) {
  return {
    ...order,
    items: order.items
      ? (typeof order.items === 'string' ? JSON.parse(order.items) : order.items)
      : []
  };
}

async function getOrderWithItems(orderId) {
  const order = await queryOne(`
    SELECT
      o.*,
      ub.name          AS buyer_name,
      ub.phone         AS buyer_phone,
      ub.email         AS buyer_email,
      bp.business_name AS buyer_business,
      bp.buyer_type,
      uf.name          AS farmer_name,
      uf.phone         AS farmer_phone,
      fp.farm_name,
      fp.farm_location,
      (SELECT status FROM payments WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1) AS payment_status,
      (SELECT mpesa_receipt FROM payments WHERE order_id = o.id AND status = 'completed' LIMIT 1) AS mpesa_receipt
    FROM orders o
    JOIN users ub ON ub.id = o.buyer_id
    JOIN users uf ON uf.id = o.farmer_id
    LEFT JOIN buyer_profiles  bp ON bp.user_id = o.buyer_id
    LEFT JOIN farmer_profiles fp ON fp.user_id = o.farmer_id
    WHERE o.id = $1
  `, [orderId]);

  if (!order) return null;

  const items = await query(`
    SELECT oi.*, l.image_urls, l.category
    FROM order_items oi
    LEFT JOIN listings l ON l.id = oi.listing_id
    WHERE oi.order_id = $1
    ORDER BY oi.created_at ASC
  `, [orderId]);

  return { ...order, items };
}

// ── POST /api/orders ─────────────────────────────────────────────────────────
router.post('/', authenticate, requireRole('buyer'), async (req, res) => {
  const { items, delivery_type = 'pickup', delivery_address, delivery_county, notes } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Order must contain at least one item.' });
  }
  for (const item of items) {
    if (!item.listing_id) return res.status(400).json({ success: false, message: 'Each item must have a listing_id.' });
    if (!item.quantity || isNaN(item.quantity) || parseFloat(item.quantity) <= 0) {
      return res.status(400).json({ success: false, message: `Invalid quantity for listing ${item.listing_id}.` });
    }
  }
  if (!['pickup','delivery'].includes(delivery_type)) {
    return res.status(400).json({ success: false, message: 'delivery_type must be "pickup" or "delivery".' });
  }
  if (delivery_type === 'delivery' && !delivery_address) {
    return res.status(400).json({ success: false, message: 'delivery_address is required for delivery orders.' });
  }

  try {
    const listingRows = [];
    let   farmerId    = null;

    for (const item of items) {
      const listing = await queryOne(
        "SELECT * FROM listings WHERE id = $1 AND status = 'active' AND is_available = TRUE",
        [item.listing_id]
      );
      if (!listing) {
        return res.status(400).json({ success: false, message: `Listing "${item.listing_id}" is not available.` });
      }
      if (farmerId && listing.farmer_id !== farmerId) {
        return res.status(400).json({ success: false, message: 'All items in one order must be from the same farmer.' });
      }
      farmerId = listing.farmer_id;
      if (listing.farmer_id === req.user.id) {
        return res.status(400).json({ success: false, message: 'You cannot order your own listings.' });
      }
      const qty = parseFloat(item.quantity);
      if (qty < listing.min_order_qty) {
        return res.status(400).json({ success: false, message: `Minimum order for "${listing.title}" is ${listing.min_order_qty} ${listing.unit}.` });
      }
      if (qty > listing.quantity) {
        return res.status(400).json({ success: false, message: `Only ${listing.quantity} ${listing.unit} available for "${listing.title}".` });
      }
      listingRows.push({ listing, qty });
    }

    const subtotal = listingRows.reduce((sum, { listing, qty }) => sum + parseFloat(listing.price_per_unit) * qty, 0);
    const farmer   = await queryOne('SELECT county FROM users WHERE id = $1', [farmerId]);
    let   deliveryFee = 0;
    if (delivery_type === 'delivery') {
      deliveryFee = DELIVERY_FEE;
      if (delivery_county && farmer && delivery_county !== farmer.county) deliveryFee += DELIVERY_FEE;
    }
    const totalAmount = subtotal + deliveryFee;
    const orderId = uuidv4();

    await withTransaction(async (client) => {
      await client.query(`
        INSERT INTO orders (
          id, buyer_id, farmer_id, status, subtotal, delivery_fee, total_amount,
          delivery_type, delivery_address, delivery_county, notes
        ) VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10)
      `, [orderId, req.user.id, farmerId, subtotal, deliveryFee, totalAmount,
          delivery_type, delivery_address || null, delivery_county || null, notes || null]);

      for (const { listing, qty } of listingRows) {
        await client.query(`
          INSERT INTO order_items (id, order_id, listing_id, title, quantity, unit, price_per_unit, line_total)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [uuidv4(), orderId, listing.id, listing.title, qty, listing.unit, listing.price_per_unit, listing.price_per_unit * qty]);
      }

      await client.query(
        'UPDATE buyer_profiles SET total_orders = total_orders + 1 WHERE user_id = $1',
        [req.user.id]
      );
    });

    const order = await getOrderWithItems(orderId);
    return res.status(201).json({ success: true, message: 'Order placed. Awaiting farmer confirmation.', data: { order } });
  } catch (err) {
    console.error('POST /orders error:', err);
    return res.status(500).json({ success: false, message: 'Server error placing order.' });
  }
});

// ── GET /api/orders ──────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const pageNum  = Math.max(1, parseInt(page)  || 1);
  const limitNum = Math.min(100, parseInt(limit) || 20);
  const offset   = (pageNum - 1) * limitNum;

  try {
    const roleField  = req.user.role === 'buyer' ? 'o.buyer_id' : 'o.farmer_id';
    const params     = [req.user.id];
    let   idx        = 2;
    let   statusCond = '';
    if (status) { statusCond = `AND o.status = $${idx++}`; params.push(status); }

    const countRow = await queryOne(
      `SELECT COUNT(*) AS count FROM orders o WHERE ${roleField} = $1 ${statusCond}`,
      params
    );
    const total = parseInt(countRow.count);

    const orders = await query(`
      SELECT
        o.id, o.status, o.subtotal, o.delivery_fee, o.total_amount,
        o.delivery_type, o.created_at, o.updated_at,
        ub.name AS buyer_name,
        uf.name AS farmer_name,
        fp.farm_name,
        (SELECT COUNT(*)::int FROM order_items WHERE order_id = o.id) AS item_count,
        (SELECT status FROM payments WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1) AS payment_status
      FROM orders o
      JOIN users ub ON ub.id = o.buyer_id
      JOIN users uf ON uf.id = o.farmer_id
      LEFT JOIN farmer_profiles fp ON fp.user_id = o.farmer_id
      WHERE ${roleField} = $1 ${statusCond}
      ORDER BY o.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, limitNum, offset]);

    return res.status(200).json({
      success: true,
      data: {
        orders,
        pagination: { total, page: pageNum, limit: limitNum, total_pages: Math.ceil(total / limitNum) }
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/orders/summary/me ───────────────────────────────────────────────
router.get('/summary/me', authenticate, async (req, res) => {
  try {
    if (req.user.role === 'buyer') {
      const stats = await queryOne(`
        SELECT
          COUNT(*)::int                                                       AS total_orders,
          COUNT(CASE WHEN status = 'pending'   THEN 1 END)::int              AS pending,
          COUNT(CASE WHEN status = 'confirmed' THEN 1 END)::int              AS confirmed,
          COUNT(CASE WHEN status = 'delivered' THEN 1 END)::int              AS delivered,
          COUNT(CASE WHEN status = 'cancelled' THEN 1 END)::int              AS cancelled,
          COALESCE(SUM(CASE WHEN status = 'delivered' THEN total_amount END), 0) AS total_spent
        FROM orders WHERE buyer_id = $1
      `, [req.user.id]);
      return res.status(200).json({ success: true, data: stats });
    } else {
      const stats = await queryOne(`
        SELECT
          COUNT(*)::int                                                          AS total_orders,
          COUNT(CASE WHEN status = 'pending'   THEN 1 END)::int                 AS pending,
          COUNT(CASE WHEN status = 'confirmed' THEN 1 END)::int                 AS confirmed,
          COUNT(CASE WHEN status = 'delivered' THEN 1 END)::int                 AS delivered,
          COUNT(CASE WHEN status = 'cancelled' THEN 1 END)::int                 AS cancelled,
          COALESCE(SUM(CASE WHEN status = 'delivered' THEN total_amount END), 0) AS total_revenue
        FROM orders WHERE farmer_id = $1
      `, [req.user.id]);
      return res.status(200).json({ success: true, data: stats });
    }
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/orders/:id ──────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const order = await getOrderWithItems(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.buyer_id !== req.user.id && order.farmer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const payments = await query(`
      SELECT id, amount, phone, method, status, mpesa_receipt, mpesa_transaction_date, paid_at, created_at, failure_reason
      FROM payments WHERE order_id = $1 ORDER BY created_at DESC
    `, [req.params.id]);

    return res.status(200).json({ success: true, data: { order, payments } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── PATCH /api/orders/:id/confirm ────────────────────────────────────────────
router.patch('/:id/confirm', authenticate, requireRole('farmer'), async (req, res) => {
  try {
    const order = await queryOne('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.farmer_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (order.status !== 'pending') return res.status(400).json({ success: false, message: `Cannot confirm an order with status "${order.status}".` });

    await execute(
      "UPDATE orders SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );
    const updated = await queryOne('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    return res.status(200).json({ success: true, message: 'Order confirmed.', data: { order: updated } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── PATCH /api/orders/:id/ready ──────────────────────────────────────────────
router.patch('/:id/ready', authenticate, requireRole('farmer'), async (req, res) => {
  try {
    const order = await queryOne('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.farmer_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (order.status !== 'confirmed') return res.status(400).json({ success: false, message: `Order must be confirmed before marking ready. Current: "${order.status}".` });

    await execute(
      "UPDATE orders SET status = 'ready', ready_at = NOW(), updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );
    const updated = await queryOne('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    return res.status(200).json({ success: true, message: 'Order marked as ready.', data: { order: updated } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── PATCH /api/orders/:id/in-transit ─────────────────────────────────────────
router.patch('/:id/in-transit', authenticate, requireRole('farmer'), async (req, res) => {
  try {
    const order = await queryOne('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.farmer_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (order.status !== 'ready') return res.status(400).json({ success: false, message: `Order must be "ready" before dispatch. Current: "${order.status}".` });

    await execute(
      "UPDATE orders SET status = 'in_transit', updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );
    const updated = await queryOne('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    return res.status(200).json({ success: true, message: 'Order is now in transit.', data: { order: updated } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── PATCH /api/orders/:id/delivered ──────────────────────────────────────────
router.patch('/:id/delivered', authenticate, requireRole('buyer'), async (req, res) => {
  try {
    const order = await queryOne('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.buyer_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (!['ready','in_transit'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Cannot mark delivered from status "${order.status}".` });
    }

    await withTransaction(async (client) => {
      await client.query(
        "UPDATE orders SET status = 'delivered', delivered_at = NOW(), updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
      await client.query(
        'UPDATE farmer_profiles SET total_sales = total_sales + 1 WHERE user_id = $1',
        [order.farmer_id]
      );
    });

    const updated = await queryOne('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    return res.status(200).json({ success: true, message: 'Delivery confirmed. Thank you!', data: { order: updated } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── PATCH /api/orders/:id/cancel ─────────────────────────────────────────────
router.patch('/:id/cancel', authenticate, async (req, res) => {
  const { reason } = req.body;
  try {
    const order = await queryOne('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.buyer_id !== req.user.id && order.farmer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    if (['delivered','cancelled'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Cannot cancel an order with status "${order.status}".` });
    }
    if (req.user.role === 'farmer' && order.status === 'in_transit') {
      return res.status(400).json({ success: false, message: 'Cannot cancel an order that is already in transit.' });
    }

    await execute(
      "UPDATE orders SET status = 'cancelled', cancelled_by = $1, cancel_reason = $2, updated_at = NOW() WHERE id = $3",
      [req.user.id, reason || null, req.params.id]
    );
    const updated = await queryOne('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    return res.status(200).json({ success: true, message: 'Order cancelled.', data: { order: updated } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
