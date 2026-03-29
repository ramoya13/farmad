// src/routes/profiles.js — FarmAd Profiles API (PostgreSQL)
const express = require('express');
const { query, queryOne } = require('../db/database');
const { optionalAuth } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/profiles/farmers ────────────────────────────────────────────────
router.get('/farmers', async (req, res) => {
  const { county, category, min_rating, sort = 'rating', order = 'desc', page = 1, limit = 20 } = req.query;

  const pageNum  = Math.max(1, parseInt(page)  || 1);
  const limitNum = Math.min(50, parseInt(limit) || 20);
  const offset   = (pageNum - 1) * limitNum;

  const validSort = ['rating','total_sales','total_reviews','created_at'];
  const sortField = validSort.includes(sort) ? `fp.${sort}` : 'fp.rating';
  const sortDir   = order === 'asc' ? 'ASC' : 'DESC';

  try {
    const conditions = ["u.role = 'farmer'"];
    const params     = [];
    let   idx        = 1;

    if (county)     { conditions.push(`fp.county = $${idx++}`);                     params.push(county); }
    if (min_rating) { conditions.push(`fp.rating >= $${idx++}`);                    params.push(parseFloat(min_rating)); }
    if (category)   { conditions.push(`fp.produce_types ILIKE $${idx++}`);          params.push(`%${category}%`); }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countRow = await queryOne(
      `SELECT COUNT(*) AS count FROM users u JOIN farmer_profiles fp ON fp.user_id = u.id ${where}`,
      params
    );
    const total = parseInt(countRow.count);

    const farmers = await query(`
      SELECT
        u.id, u.name, u.county, u.avatar_url, u.is_verified,
        u.created_at AS member_since,
        fp.farm_name, fp.farm_location, fp.farm_size_ha,
        fp.produce_types, fp.rating, fp.total_reviews, fp.total_sales,
        (SELECT COUNT(*)::int FROM listings l WHERE l.farmer_id = u.id AND l.status = 'active') AS active_listings,
        (SELECT comment FROM reviews WHERE reviewee_id = u.id AND is_flagged = FALSE ORDER BY created_at DESC LIMIT 1) AS latest_review
      FROM users u
      JOIN farmer_profiles fp ON fp.user_id = u.id
      ${where}
      ORDER BY ${sortField} ${sortDir}
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, limitNum, offset]);

    return res.status(200).json({
      success: true,
      data: {
        farmers,
        pagination: { total, page: pageNum, limit: limitNum, total_pages: Math.ceil(total / limitNum), has_next: pageNum < Math.ceil(total / limitNum) }
      }
    });
  } catch (err) {
    console.error('GET /profiles/farmers error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/profiles/leaderboard ───────────────────────────────────────────
router.get('/leaderboard', async (req, res) => {
  const { county, category, limit = 10 } = req.query;
  const limitNum = Math.min(20, parseInt(limit) || 10);

  try {
    const conditions = ["u.role = 'farmer'", 'fp.total_reviews >= 3'];
    const params     = [];
    let   idx        = 1;

    if (county)   { conditions.push(`fp.county = $${idx++}`);              params.push(county); }
    if (category) { conditions.push(`fp.produce_types ILIKE $${idx++}`);   params.push(`%${category}%`); }

    const farmers = await query(`
      SELECT
        u.id, u.name, u.county, u.avatar_url, u.is_verified,
        fp.farm_name, fp.farm_location, fp.produce_types,
        fp.rating, fp.total_reviews, fp.total_sales,
        (SELECT COUNT(*)::int FROM listings WHERE farmer_id = u.id AND status = 'active') AS active_listings
      FROM users u
      JOIN farmer_profiles fp ON fp.user_id = u.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY fp.rating DESC, fp.total_reviews DESC
      LIMIT $${idx++}
    `, [...params, limitNum]);

    return res.status(200).json({
      success: true,
      data: { leaderboard: farmers.map((f, i) => ({ rank: i + 1, ...f })) }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/profiles/:userId ────────────────────────────────────────────────
router.get('/:userId', optionalAuth, async (req, res) => {
  const { userId } = req.params;

  try {
    const user = await queryOne(
      'SELECT id, name, email, phone, role, county, avatar_url, bio, is_verified, created_at FROM users WHERE id = $1',
      [userId]
    );
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const isSelf = req.user && req.user.id === userId;
    if (!isSelf) {
      user.phone = user.phone.replace(/(\d{4})\d{3}(\d{3})/, '$1***$2');
      delete user.email;
    }

    if (user.role === 'farmer') {
      const profile = await queryOne('SELECT * FROM farmer_profiles WHERE user_id = $1', [userId]);

      const listings = await query(`
        SELECT id, title, category, price_per_unit, unit, quantity, county, location,
               is_organic, image_urls, created_at, views
        FROM listings
        WHERE farmer_id = $1 AND status = 'active' AND is_available = TRUE
        ORDER BY created_at DESC LIMIT 6
      `, [userId]);

      const reviews = await query(`
        SELECT r.id, r.rating, r.comment, r.reply, r.replied_at, r.created_at,
               r.rating_quality, r.rating_communication, r.rating_punctuality,
               u.name AS reviewer_name, u.avatar_url AS reviewer_avatar, u.role AS reviewer_role
        FROM reviews r
        JOIN users u ON u.id = r.reviewer_id
        WHERE r.reviewee_id = $1 AND r.is_flagged = FALSE
        ORDER BY r.created_at DESC LIMIT 5
      `, [userId]);

      const breakdown = await query(`
        SELECT rating, COUNT(*)::int AS count FROM reviews
        WHERE reviewee_id = $1 AND is_flagged = FALSE
        GROUP BY rating ORDER BY rating DESC
      `, [userId]);

      const categoryStats = await query(`
        SELECT category, COUNT(*)::int AS listing_count, ROUND(AVG(price_per_unit)::numeric, 2) AS avg_price
        FROM listings WHERE farmer_id = $1 AND status = 'active'
        GROUP BY category ORDER BY listing_count DESC
      `, [userId]);

      return res.status(200).json({
        success: true,
        data: {
          user, profile,
          listings: listings.map(l => ({ ...l, image_urls: Array.isArray(l.image_urls) ? l.image_urls : [] })),
          reviews, rating_breakdown: breakdown, category_stats: categoryStats
        }
      });
    } else {
      const profile = await queryOne('SELECT * FROM buyer_profiles WHERE user_id = $1', [userId]);

      const reviewsReceived = await query(`
        SELECT r.id, r.rating, r.comment, r.reply, r.created_at,
               u.name AS reviewer_name, u.role AS reviewer_role
        FROM reviews r
        JOIN users u ON u.id = r.reviewer_id
        WHERE r.reviewee_id = $1 AND r.is_flagged = FALSE
        ORDER BY r.created_at DESC LIMIT 5
      `, [userId]);

      const orderStats = await queryOne(`
        SELECT
          COUNT(*)::int                                             AS total_orders,
          COUNT(CASE WHEN status = 'delivered' THEN 1 END)::int    AS completed_orders,
          COUNT(CASE WHEN status = 'cancelled' THEN 1 END)::int    AS cancelled_orders
        FROM orders WHERE buyer_id = $1
      `, [userId]);

      return res.status(200).json({ success: true, data: { user, profile, reviews_received: reviewsReceived, order_stats: orderStats } });
    }
  } catch (err) {
    console.error('GET /profiles/:userId error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
