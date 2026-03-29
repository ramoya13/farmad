// src/routes/reviews.js — FarmAd Reviews API (PostgreSQL)
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

async function recalcRating(userId, role) {
  const result = await queryOne(`
    SELECT
      COUNT(*)::int                       AS total,
      AVG(rating)                         AS avg_rating,
      AVG(rating_quality)                 AS avg_quality,
      AVG(rating_communication)           AS avg_comm,
      AVG(rating_punctuality)             AS avg_punct
    FROM reviews WHERE reviewee_id = $1 AND is_flagged = FALSE
  `, [userId]);

  const avg   = result.avg_rating ? parseFloat(parseFloat(result.avg_rating).toFixed(2)) : 0;
  const total = result.total || 0;

  if (role === 'farmer') {
    await execute('UPDATE farmer_profiles SET rating = $1, total_reviews = $2 WHERE user_id = $3', [avg, total, userId]);
  } else {
    await execute('UPDATE buyer_profiles SET rating = $1, total_reviews = $2 WHERE user_id = $3', [avg, total, userId]);
  }
  return { avg, total };
}

function fmt(r) {
  return {
    ...r,
    is_flagged: Boolean(r.is_flagged),
    sub_ratings: {
      quality:       r.rating_quality       || null,
      communication: r.rating_communication || null,
      punctuality:   r.rating_punctuality   || null
    }
  };
}

// ── POST /api/reviews ────────────────────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  const { order_id, rating, comment, rating_quality, rating_communication, rating_punctuality } = req.body;

  const errors = [];
  if (!order_id)                                                errors.push('order_id is required.');
  if (!rating || isNaN(rating) || rating < 1 || rating > 5)    errors.push('rating must be an integer between 1 and 5.');
  if (rating_quality       && (rating_quality < 1       || rating_quality > 5))       errors.push('rating_quality must be 1–5.');
  if (rating_communication && (rating_communication < 1 || rating_communication > 5)) errors.push('rating_communication must be 1–5.');
  if (rating_punctuality   && (rating_punctuality < 1   || rating_punctuality > 5))   errors.push('rating_punctuality must be 1–5.');
  if (comment && comment.trim().length > 1000) errors.push('Comment must be 1000 characters or fewer.');
  if (errors.length) return res.status(400).json({ success: false, message: 'Validation failed.', errors });

  try {
    const order = await queryOne('SELECT * FROM orders WHERE id = $1', [order_id]);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.status !== 'delivered') return res.status(400).json({ success: false, message: 'Reviews can only be submitted for delivered orders.' });

    const isBuyer  = order.buyer_id  === req.user.id;
    const isFarmer = order.farmer_id === req.user.id;
    if (!isBuyer && !isFarmer) return res.status(403).json({ success: false, message: 'You are not part of this order.' });

    const revieweeId = isBuyer ? order.farmer_id : order.buyer_id;

    const existing = await queryOne('SELECT id FROM reviews WHERE order_id = $1 AND reviewer_id = $2', [order_id, req.user.id]);
    if (existing) return res.status(409).json({ success: false, message: 'You have already reviewed this order.' });

    const reviewId = uuidv4();
    await execute(`
      INSERT INTO reviews (
        id, order_id, reviewer_id, reviewee_id, reviewer_role,
        rating, comment, rating_quality, rating_communication, rating_punctuality
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      reviewId, order_id, req.user.id, revieweeId, req.user.role,
      parseInt(rating),
      comment ? comment.trim() : null,
      rating_quality       ? parseInt(rating_quality)       : null,
      rating_communication ? parseInt(rating_communication) : null,
      rating_punctuality   ? parseInt(rating_punctuality)   : null
    ]);

    const reviewee = await queryOne('SELECT role FROM users WHERE id = $1', [revieweeId]);
    const newStats = await recalcRating(revieweeId, reviewee.role);

    const review = await queryOne(`
      SELECT r.*, u.name AS reviewer_name, u.role AS reviewer_role_check
      FROM reviews r JOIN users u ON u.id = r.reviewer_id WHERE r.id = $1
    `, [reviewId]);

    return res.status(201).json({
      success: true, message: 'Review submitted.',
      data: { review: fmt(review), reviewee_new_rating: newStats.avg, reviewee_total_reviews: newStats.total }
    });
  } catch (err) {
    console.error('POST /reviews error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/reviews/pending ─────────────────────────────────────────────────
router.get('/pending', authenticate, async (req, res) => {
  try {
    const pendingOrders = await query(`
      SELECT
        o.id AS order_id,
        o.total_amount,
        o.delivered_at,
        o.created_at,
        CASE WHEN o.buyer_id  = $1 THEN uf.name   ELSE ub.name   END AS reviewee_name,
        CASE WHEN o.buyer_id  = $1 THEN uf.id     ELSE ub.id     END AS reviewee_id,
        CASE WHEN o.buyer_id  = $1 THEN 'farmer'  ELSE 'buyer'   END AS reviewee_role,
        fp.farm_name,
        (SELECT STRING_AGG(title, ', ') FROM order_items WHERE order_id = o.id) AS items_summary
      FROM orders o
      JOIN users ub ON ub.id = o.buyer_id
      JOIN users uf ON uf.id = o.farmer_id
      LEFT JOIN farmer_profiles fp ON fp.user_id = o.farmer_id
      WHERE o.status = 'delivered'
        AND (o.buyer_id = $1 OR o.farmer_id = $1)
        AND o.id NOT IN (SELECT order_id FROM reviews WHERE reviewer_id = $1)
      ORDER BY o.delivered_at DESC
    `, [req.user.id]);

    return res.status(200).json({ success: true, data: { pending_reviews: pendingOrders, count: pendingOrders.length } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/reviews/stats/:userId ───────────────────────────────────────────
router.get('/stats/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const user = await queryOne('SELECT id, name, role FROM users WHERE id = $1', [userId]);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const aggregates = await queryOne(`
      SELECT
        COUNT(*)::int                               AS total_reviews,
        ROUND(AVG(rating)::numeric, 2)              AS avg_rating,
        ROUND(AVG(rating_quality)::numeric, 2)      AS avg_quality,
        ROUND(AVG(rating_communication)::numeric, 2) AS avg_communication,
        ROUND(AVG(rating_punctuality)::numeric, 2)  AS avg_punctuality,
        COUNT(CASE WHEN rating = 5 THEN 1 END)::int AS five_star,
        COUNT(CASE WHEN rating = 4 THEN 1 END)::int AS four_star,
        COUNT(CASE WHEN rating = 3 THEN 1 END)::int AS three_star,
        COUNT(CASE WHEN rating = 2 THEN 1 END)::int AS two_star,
        COUNT(CASE WHEN rating = 1 THEN 1 END)::int AS one_star
      FROM reviews WHERE reviewee_id = $1 AND is_flagged = FALSE
    `, [userId]);

    const trend = await query(`
      SELECT
        to_char(created_at, 'YYYY-MM') AS month,
        ROUND(AVG(rating)::numeric, 2) AS avg_rating,
        COUNT(*)::int                  AS count
      FROM reviews
      WHERE reviewee_id = $1 AND is_flagged = FALSE
        AND created_at >= NOW() - INTERVAL '3 months'
      GROUP BY month ORDER BY month ASC
    `, [userId]);

    return res.status(200).json({ success: true, data: { user, aggregates, trend } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/reviews/user/:userId ────────────────────────────────────────────
router.get('/user/:userId', async (req, res) => {
  const { userId } = req.params;
  const { page = 1, limit = 10, rating: ratingFilter } = req.query;
  const pageNum  = Math.max(1, parseInt(page)  || 1);
  const limitNum = Math.min(50, parseInt(limit) || 10);
  const offset   = (pageNum - 1) * limitNum;

  try {
    const user = await queryOne('SELECT id, name, role FROM users WHERE id = $1', [userId]);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const params = [userId];
    let   idx    = 2;
    let   ratingCond = '';
    if (ratingFilter) { ratingCond = `AND r.rating = $${idx++}`; params.push(parseInt(ratingFilter)); }

    const countRow = await queryOne(
      `SELECT COUNT(*) AS count FROM reviews r WHERE r.reviewee_id = $1 AND r.is_flagged = FALSE ${ratingCond}`,
      params
    );
    const total = parseInt(countRow.count);

    const reviews = await query(`
      SELECT
        r.*,
        u.name       AS reviewer_name,
        u.avatar_url AS reviewer_avatar,
        u.role       AS reviewer_role_label,
        fp.farm_name AS reviewer_farm_name
      FROM reviews r
      JOIN users u ON u.id = r.reviewer_id
      LEFT JOIN farmer_profiles fp ON fp.user_id = r.reviewer_id
      WHERE r.reviewee_id = $1 AND r.is_flagged = FALSE ${ratingCond}
      ORDER BY r.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, limitNum, offset]);

    const breakdown = await query(`
      SELECT rating, COUNT(*)::int AS count
      FROM reviews WHERE reviewee_id = $1 AND is_flagged = FALSE
      GROUP BY rating ORDER BY rating DESC
    `, [userId]);

    const aggregates = await queryOne(`
      SELECT
        COUNT(*)::int                               AS total_reviews,
        ROUND(AVG(rating)::numeric, 2)              AS avg_rating,
        ROUND(AVG(rating_quality)::numeric, 2)      AS avg_quality,
        ROUND(AVG(rating_communication)::numeric, 2) AS avg_communication,
        ROUND(AVG(rating_punctuality)::numeric, 2)  AS avg_punctuality
      FROM reviews WHERE reviewee_id = $1 AND is_flagged = FALSE
    `, [userId]);

    return res.status(200).json({
      success: true,
      data: {
        user: { id: user.id, name: user.name, role: user.role },
        aggregates, breakdown,
        reviews: reviews.map(fmt),
        pagination: { total, page: pageNum, limit: limitNum, total_pages: Math.ceil(total / limitNum), has_next: pageNum < Math.ceil(total / limitNum) }
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/reviews/order/:orderId ─────────────────────────────────────────
router.get('/order/:orderId', authenticate, async (req, res) => {
  try {
    const order = await queryOne('SELECT buyer_id, farmer_id FROM orders WHERE id = $1', [req.params.orderId]);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.buyer_id !== req.user.id && order.farmer_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied.' });

    const reviews = await query(`
      SELECT r.*, u.name AS reviewer_name, u.avatar_url AS reviewer_avatar
      FROM reviews r JOIN users u ON u.id = r.reviewer_id
      WHERE r.order_id = $1 ORDER BY r.created_at ASC
    `, [req.params.orderId]);

    const myReview       = reviews.find(r => r.reviewer_id === req.user.id);
    const canStillReview = !myReview && (order.buyer_id === req.user.id || order.farmer_id === req.user.id);

    return res.status(200).json({
      success: true,
      data: { reviews: reviews.map(fmt), my_review: myReview ? fmt(myReview) : null, can_still_review: canStillReview }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── PATCH /api/reviews/:id/reply ─────────────────────────────────────────────
router.patch('/:id/reply', authenticate, async (req, res) => {
  const { reply } = req.body;
  if (!reply || reply.trim().length < 2)  return res.status(400).json({ success: false, message: 'Reply text is required.' });
  if (reply.trim().length > 500)          return res.status(400).json({ success: false, message: 'Reply must be 500 characters or fewer.' });

  try {
    const review = await queryOne('SELECT * FROM reviews WHERE id = $1', [req.params.id]);
    if (!review) return res.status(404).json({ success: false, message: 'Review not found.' });
    if (review.reviewee_id !== req.user.id) return res.status(403).json({ success: false, message: 'Only the person being reviewed can reply.' });
    if (review.reply) return res.status(409).json({ success: false, message: 'You have already replied to this review.' });

    await execute(
      'UPDATE reviews SET reply = $1, replied_at = NOW(), updated_at = NOW() WHERE id = $2',
      [reply.trim(), req.params.id]
    );
    const updated = await queryOne('SELECT * FROM reviews WHERE id = $1', [req.params.id]);
    return res.status(200).json({ success: true, message: 'Reply posted.', data: { review: fmt(updated) } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── PATCH /api/reviews/:id/flag ──────────────────────────────────────────────
router.patch('/:id/flag', authenticate, async (req, res) => {
  const { reason } = req.body;
  if (!reason || reason.trim().length < 10) return res.status(400).json({ success: false, message: 'A reason (min 10 chars) is required to flag a review.' });

  try {
    const review = await queryOne('SELECT * FROM reviews WHERE id = $1', [req.params.id]);
    if (!review) return res.status(404).json({ success: false, message: 'Review not found.' });
    if (review.reviewee_id !== req.user.id) return res.status(403).json({ success: false, message: 'Only the reviewee can flag a review.' });
    if (review.is_flagged) return res.status(409).json({ success: false, message: 'This review is already flagged.' });

    await execute('UPDATE reviews SET is_flagged = TRUE, flag_reason = $1, updated_at = NOW() WHERE id = $2', [reason.trim(), req.params.id]);

    const reviewee = await queryOne('SELECT role FROM users WHERE id = $1', [req.user.id]);
    await recalcRating(req.user.id, reviewee.role);

    return res.status(200).json({ success: true, message: 'Review flagged and excluded from your rating pending admin review.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── DELETE /api/reviews/:id ───────────────────────────────────────────────────
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const review = await queryOne('SELECT * FROM reviews WHERE id = $1', [req.params.id]);
    if (!review) return res.status(404).json({ success: false, message: 'Review not found.' });
    if (review.reviewer_id !== req.user.id) return res.status(403).json({ success: false, message: 'You can only delete your own reviews.' });

    const hoursAgo = (Date.now() - new Date(review.created_at).getTime()) / 3600000;
    if (hoursAgo > 48) return res.status(403).json({ success: false, message: 'Reviews can only be deleted within 48 hours of submission.' });

    const revieweeId = review.reviewee_id;
    await execute('DELETE FROM reviews WHERE id = $1', [req.params.id]);

    const reviewee = await queryOne('SELECT role FROM users WHERE id = $1', [revieweeId]);
    await recalcRating(revieweeId, reviewee.role);

    return res.status(200).json({ success: true, message: 'Review deleted.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
