// src/routes/listings.js — FarmAd Listings API (PostgreSQL)
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db/database');
const { authenticate, requireRole, optionalAuth } = require('../middleware/auth');

const router = express.Router();

const VALID_CATEGORIES = ['vegetables','fruits','grains','dairy','legumes','livestock','other'];
const VALID_UNITS       = ['kg','bags','crates','litres','pieces','tonnes'];
const VALID_STATUSES    = ['active','sold','expired','draft'];
const VALID_SORT        = ['created_at','price_per_unit','quantity','views'];

function validateListing(body, isUpdate = false) {
  const errors = [];
  const { title, category, quantity, unit, price_per_unit, county, location } = body;

  if (!isUpdate) {
    if (!title || title.trim().length < 3)   errors.push('Title must be at least 3 characters.');
    if (!category || !VALID_CATEGORIES.includes(category)) errors.push(`Category must be one of: ${VALID_CATEGORIES.join(', ')}.`);
    if (quantity === undefined || isNaN(parseFloat(quantity)) || parseFloat(quantity) <= 0) errors.push('Quantity must be a positive number.');
    if (!unit || !VALID_UNITS.includes(unit)) errors.push(`Unit must be one of: ${VALID_UNITS.join(', ')}.`);
    if (price_per_unit === undefined || isNaN(parseFloat(price_per_unit)) || parseFloat(price_per_unit) <= 0) errors.push('Price per unit must be a positive number.');
    if (!county || county.trim().length < 2)   errors.push('County is required.');
    if (!location || location.trim().length < 2) errors.push('Location/village is required.');
  } else {
    if (category  && !VALID_CATEGORIES.includes(category))  errors.push(`Category must be one of: ${VALID_CATEGORIES.join(', ')}.`);
    if (unit      && !VALID_UNITS.includes(unit))           errors.push(`Unit must be one of: ${VALID_UNITS.join(', ')}.`);
    if (quantity  !== undefined && (isNaN(parseFloat(quantity)) || parseFloat(quantity) <= 0)) errors.push('Quantity must be a positive number.');
    if (price_per_unit !== undefined && (isNaN(parseFloat(price_per_unit)) || parseFloat(price_per_unit) <= 0)) errors.push('Price per unit must be a positive number.');
  }
  return errors;
}

function formatListing(row) {
  return {
    ...row,
    is_organic:   Boolean(row.is_organic),
    is_available: Boolean(row.is_available),
    image_urls:   Array.isArray(row.image_urls) ? row.image_urls
                : (row.image_urls ? JSON.parse(row.image_urls) : []),
  };
}

// ── GET /api/listings ────────────────────────────────────────────────────────
router.get('/', optionalAuth, async (req, res) => {
  try {
    const {
      q, category, county, unit, is_organic,
      min_price, max_price,
      sort = 'created_at', order = 'desc',
      page = 1, limit = 20
    } = req.query;

    const pageNum  = Math.max(1, parseInt(page)  || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const offset   = (pageNum - 1) * limitNum;

    const sortField = VALID_SORT.includes(sort) ? `l.${sort}` : 'l.created_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

    const conditions = ["l.status = 'active'", 'l.is_available = TRUE'];
    const params = [];
    let   idx   = 1;

    if (q) {
      conditions.push(`(l.title ILIKE $${idx} OR l.description ILIKE $${idx} OR l.location ILIKE $${idx})`);
      params.push(`%${q}%`); idx++;
    }
    if (category && VALID_CATEGORIES.includes(category)) {
      conditions.push(`l.category = $${idx++}`); params.push(category);
    }
    if (county) {
      conditions.push(`l.county = $${idx++}`); params.push(county);
    }
    if (unit && VALID_UNITS.includes(unit)) {
      conditions.push(`l.unit = $${idx++}`); params.push(unit);
    }
    if (is_organic === '1') {
      conditions.push('l.is_organic = TRUE');
    }
    if (min_price && !isNaN(min_price)) {
      conditions.push(`l.price_per_unit >= $${idx++}`); params.push(parseFloat(min_price));
    }
    if (max_price && !isNaN(max_price)) {
      conditions.push(`l.price_per_unit <= $${idx++}`); params.push(parseFloat(max_price));
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = await queryOne(
      `SELECT COUNT(*) AS count FROM listings l ${where}`,
      params
    );
    const total = parseInt(countRow.count);

    const savedSubquery = req.user
      ? `(SELECT 1 FROM saved_listings sl WHERE sl.user_id = $${idx++} AND sl.listing_id = l.id) AS is_saved`
      : '0::int AS is_saved';
    if (req.user) params.push(req.user.id);

    const rows = await query(`
      SELECT
        l.*,
        u.name           AS farmer_name,
        u.phone          AS farmer_phone,
        u.county         AS farmer_county,
        fp.farm_name,
        fp.farm_location,
        fp.rating        AS farmer_rating,
        fp.total_reviews AS farmer_total_reviews,
        ${savedSubquery}
      FROM listings l
      JOIN users u            ON u.id = l.farmer_id
      JOIN farmer_profiles fp ON fp.user_id = l.farmer_id
      ${where}
      ORDER BY ${sortField} ${sortOrder}
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, limitNum, offset]);

    // Bump view counts (fire and forget)
    if (rows.length > 0) {
      const ids = rows.map(r => `'${r.id}'`).join(',');
      execute(`UPDATE listings SET views = views + 1 WHERE id IN (${ids})`).catch(() => {});
    }

    return res.status(200).json({
      success: true,
      data: {
        listings: rows.map(formatListing),
        pagination: {
          total,
          page:        pageNum,
          limit:       limitNum,
          total_pages: Math.ceil(total / limitNum),
          has_next:    pageNum < Math.ceil(total / limitNum),
          has_prev:    pageNum > 1
        },
        filters_applied: { q, category, county, unit, is_organic, min_price, max_price }
      }
    });
  } catch (err) {
    console.error('GET /listings error:', err);
    return res.status(500).json({ success: false, message: 'Server error fetching listings.' });
  }
});

// ── GET /api/listings/saved/me ───────────────────────────────────────────────
router.get('/saved/me', authenticate, async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        l.*,
        u.name      AS farmer_name,
        u.phone     AS farmer_phone,
        fp.farm_name,
        fp.farm_location,
        fp.rating   AS farmer_rating,
        sl.created_at AS saved_at,
        TRUE AS is_saved
      FROM saved_listings sl
      JOIN listings l ON l.id = sl.listing_id
      JOIN users u    ON u.id = l.farmer_id
      JOIN farmer_profiles fp ON fp.user_id = l.farmer_id
      WHERE sl.user_id = $1
      ORDER BY sl.created_at DESC
    `, [req.user.id]);

    return res.status(200).json({ success: true, data: { listings: rows.map(formatListing), total: rows.length } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/listings/stats/categories ──────────────────────────────────────
router.get('/stats/categories', async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        l.category,
        COUNT(*)::int                                         AS listing_count,
        COUNT(DISTINCT l.farmer_id)::int                     AS farmer_count,
        ROUND(AVG(l.price_per_unit)::numeric, 2)             AS avg_price
      FROM listings l
      WHERE l.status = 'active' AND l.is_available = TRUE
      GROUP BY l.category
      ORDER BY listing_count DESC
    `);
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/listings/farmer/:farmerId ───────────────────────────────────────
router.get('/farmer/:farmerId', optionalAuth, async (req, res) => {
  const { farmerId } = req.params;
  try {
    const farmer = await queryOne(`
      SELECT u.id, u.name, u.county, u.is_verified,
             fp.farm_name, fp.farm_location, fp.rating, fp.total_reviews, fp.total_sales
      FROM users u
      JOIN farmer_profiles fp ON fp.user_id = u.id
      WHERE u.id = $1 AND u.role = 'farmer'
    `, [farmerId]);

    if (!farmer) return res.status(404).json({ success: false, message: 'Farmer not found.' });

    const isOwner = req.user && req.user.id === farmerId;
    const statusFilter = isOwner ? '' : "AND l.status = 'active' AND l.is_available = TRUE";

    const listings = await query(
      `SELECT l.* FROM listings l WHERE l.farmer_id = $1 ${statusFilter} ORDER BY l.created_at DESC`,
      [farmerId]
    );

    return res.status(200).json({ success: true, data: { farmer, listings: listings.map(formatListing), total: listings.length } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/listings/:id ────────────────────────────────────────────────────
router.get('/:id', optionalAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const savedSubquery = req.user
      ? `(SELECT 1 FROM saved_listings sl WHERE sl.user_id = $2 AND sl.listing_id = l.id) AS is_saved`
      : '0::int AS is_saved';
    const params = req.user ? [id, req.user.id] : [id];

    const row = await queryOne(`
      SELECT
        l.*,
        u.name           AS farmer_name,
        u.phone          AS farmer_phone,
        u.county         AS farmer_county,
        u.is_verified    AS farmer_is_verified,
        fp.farm_name,
        fp.farm_location,
        fp.rating        AS farmer_rating,
        fp.total_reviews AS farmer_total_reviews,
        fp.total_sales   AS farmer_total_sales,
        ${savedSubquery}
      FROM listings l
      JOIN users u            ON u.id = l.farmer_id
      JOIN farmer_profiles fp ON fp.user_id = l.farmer_id
      WHERE l.id = $1
    `, params);

    if (!row) return res.status(404).json({ success: false, message: 'Listing not found.' });

    if (!req.user || req.user.id !== row.farmer_id) {
      await execute('UPDATE listings SET views = views + 1 WHERE id = $1', [id]);
      row.views = (row.views || 0) + 1;
    }

    const related = await query(`
      SELECT l.id, l.title, l.category, l.price_per_unit, l.unit, l.county, l.image_urls,
             u.name AS farmer_name, fp.farm_name
      FROM listings l
      JOIN users u            ON u.id = l.farmer_id
      JOIN farmer_profiles fp ON fp.user_id = l.farmer_id
      WHERE l.id != $1 AND l.status = 'active' AND l.is_available = TRUE
        AND (l.category = $2 OR l.county = $3)
      ORDER BY RANDOM()
      LIMIT 4
    `, [id, row.category, row.county]);

    return res.status(200).json({ success: true, data: { listing: formatListing(row), related: related.map(formatListing) } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── POST /api/listings ───────────────────────────────────────────────────────
router.post('/', authenticate, requireRole('farmer'), async (req, res) => {
  const errors = validateListing(req.body);
  if (errors.length > 0) return res.status(400).json({ success: false, message: 'Validation failed.', errors });

  const {
    title, category, description = null,
    quantity, unit, price_per_unit,
    min_order_qty = 1, county, location,
    harvest_date = null, expiry_date = null,
    is_organic = false, image_urls = [],
    status = 'active'
  } = req.body;

  try {
    const id = uuidv4();
    const imageJson = JSON.stringify(Array.isArray(image_urls) ? image_urls : []);

    await execute(`
      INSERT INTO listings (
        id, farmer_id, title, category, description,
        quantity, unit, price_per_unit, min_order_qty,
        county, location, harvest_date, expiry_date,
        is_organic, image_urls, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    `, [
      id, req.user.id, title.trim(), category, description,
      parseFloat(quantity), unit, parseFloat(price_per_unit), parseFloat(min_order_qty),
      county.trim(), location.trim(), harvest_date || null, expiry_date || null,
      Boolean(is_organic), imageJson,
      VALID_STATUSES.includes(status) ? status : 'active'
    ]);

    const listing = await queryOne('SELECT * FROM listings WHERE id = $1', [id]);
    return res.status(201).json({ success: true, message: 'Listing created.', data: { listing: formatListing(listing) } });
  } catch (err) {
    console.error('POST /listings error:', err);
    return res.status(500).json({ success: false, message: 'Server error creating listing.' });
  }
});

// ── PATCH /api/listings/:id ──────────────────────────────────────────────────
router.patch('/:id', authenticate, requireRole('farmer'), async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await queryOne('SELECT * FROM listings WHERE id = $1', [id]);
    if (!existing)                          return res.status(404).json({ success: false, message: 'Listing not found.' });
    if (existing.farmer_id !== req.user.id) return res.status(403).json({ success: false, message: 'You can only edit your own listings.' });

    const errors = validateListing(req.body, true);
    if (errors.length > 0) return res.status(400).json({ success: false, message: 'Validation failed.', errors });

    const fields = [];
    const values = [];
    let   idx    = 1;

    const allowed = ['title','category','description','quantity','unit','price_per_unit','min_order_qty','county','location','harvest_date','expiry_date','is_organic','status'];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        let val = req.body[key];
        if (['quantity','price_per_unit','min_order_qty'].includes(key)) val = parseFloat(val);
        if (key === 'is_organic') val = Boolean(val);
        if (key === 'status' && !VALID_STATUSES.includes(val)) continue;
        fields.push(`${key} = $${idx++}`);
        values.push(val);
      }
    }

    if (req.body.image_urls !== undefined) {
      fields.push(`image_urls = $${idx++}`);
      values.push(JSON.stringify(Array.isArray(req.body.image_urls) ? req.body.image_urls : []));
    }

    if (req.body.status) {
      fields.push(`is_available = $${idx++}`);
      values.push(req.body.status === 'active');
    }

    if (fields.length === 0) return res.status(400).json({ success: false, message: 'No valid fields to update.' });

    fields.push('updated_at = NOW()');
    values.push(id);

    await execute(`UPDATE listings SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    const updated = await queryOne('SELECT * FROM listings WHERE id = $1', [id]);
    return res.status(200).json({ success: true, message: 'Listing updated.', data: { listing: formatListing(updated) } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── PATCH /api/listings/:id/status ──────────────────────────────────────────
router.patch('/:id/status', authenticate, requireRole('farmer'), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, message: `Status must be one of: ${VALID_STATUSES.join(', ')}.` });
  }

  try {
    const existing = await queryOne('SELECT * FROM listings WHERE id = $1', [id]);
    if (!existing)                          return res.status(404).json({ success: false, message: 'Listing not found.' });
    if (existing.farmer_id !== req.user.id) return res.status(403).json({ success: false, message: 'You can only edit your own listings.' });

    await execute(
      'UPDATE listings SET status = $1, is_available = $2, updated_at = NOW() WHERE id = $3',
      [status, status === 'active', id]
    );
    const updated = await queryOne('SELECT * FROM listings WHERE id = $1', [id]);
    return res.status(200).json({ success: true, message: `Listing marked as "${status}".`, data: { listing: formatListing(updated) } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── DELETE /api/listings/:id ─────────────────────────────────────────────────
router.delete('/:id', authenticate, requireRole('farmer'), async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await queryOne('SELECT * FROM listings WHERE id = $1', [id]);
    if (!existing)                          return res.status(404).json({ success: false, message: 'Listing not found.' });
    if (existing.farmer_id !== req.user.id) return res.status(403).json({ success: false, message: 'You can only delete your own listings.' });

    await execute('DELETE FROM listings WHERE id = $1', [id]);
    return res.status(200).json({ success: true, message: 'Listing deleted.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── POST /api/listings/:id/save ──────────────────────────────────────────────
router.post('/:id/save', authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const listing = await queryOne('SELECT id FROM listings WHERE id = $1', [id]);
    if (!listing) return res.status(404).json({ success: false, message: 'Listing not found.' });

    const existing = await queryOne('SELECT id FROM saved_listings WHERE user_id = $1 AND listing_id = $2', [req.user.id, id]);

    if (existing) {
      await execute('DELETE FROM saved_listings WHERE user_id = $1 AND listing_id = $2', [req.user.id, id]);
      return res.status(200).json({ success: true, message: 'Listing unsaved.', data: { saved: false } });
    } else {
      await execute('INSERT INTO saved_listings (id, user_id, listing_id) VALUES ($1,$2,$3)', [uuidv4(), req.user.id, id]);
      return res.status(200).json({ success: true, message: 'Listing saved.', data: { saved: true } });
    }
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
