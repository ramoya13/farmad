// src/routes/prices.js — FarmAd Market Prices API (PostgreSQL)
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { syncPricesFromListings, snapshotWeeklyHistory } = require('../services/priceEngine');

const router = express.Router();

const VALID_UNITS      = ['kg','bags','crates','litres','pieces','tonnes'];
const VALID_CATEGORIES = ['vegetables','fruits','grains','dairy','legumes','livestock','other'];
const VALID_CONDITIONS = ['above','below'];

// ── GET /api/prices ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const {
    crop, county, category, unit, trend,
    min_price, max_price,
    sort = 'crop', order = 'asc',
    page = 1, limit = 40
  } = req.query;

  const pageNum  = Math.max(1, parseInt(page)  || 1);
  const limitNum = Math.min(200, parseInt(limit) || 40);
  const offset   = (pageNum - 1) * limitNum;

  const validSort = ['crop','county','price_avg','price_low','price_high','trend_pct','price_date'];
  const sortField = validSort.includes(sort) ? `mp.${sort}` : 'mp.crop';
  const sortDir   = order === 'desc' ? 'DESC' : 'ASC';

  try {
    const conds  = [];
    const params = [];
    let   idx    = 1;

    if (crop)      { conds.push(`mp.crop ILIKE $${idx++}`);      params.push(`%${crop}%`); }
    if (county)    { conds.push(`mp.county = $${idx++}`);        params.push(county); }
    if (category)  { conds.push(`mp.category = $${idx++}`);      params.push(category); }
    if (unit)      { conds.push(`mp.unit = $${idx++}`);          params.push(unit); }
    if (trend)     { conds.push(`mp.trend = $${idx++}`);         params.push(trend); }
    if (min_price) { conds.push(`mp.price_avg >= $${idx++}`);    params.push(parseFloat(min_price)); }
    if (max_price) { conds.push(`mp.price_avg <= $${idx++}`);    params.push(parseFloat(max_price)); }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const countRow = await queryOne(`SELECT COUNT(*) AS n FROM market_prices mp ${where}`, params);
    const total    = parseInt(countRow.n);

    const rows = await query(`
      SELECT
        mp.*,
        (SELECT COUNT(*)::int FROM listings l
         WHERE l.county = mp.county
           AND LOWER(l.title) LIKE '%' || LOWER(mp.crop) || '%'
           AND l.status = 'active') AS listing_count
      FROM market_prices mp
      ${where}
      ORDER BY ${sortField} ${sortDir}
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, limitNum, offset]);

    return res.status(200).json({
      success: true,
      data: {
        prices: rows,
        pagination: { total, page: pageNum, limit: limitNum, total_pages: Math.ceil(total / limitNum), has_next: pageNum < Math.ceil(total / limitNum) },
        filters_applied: { crop, county, category, unit, trend, min_price, max_price }
      }
    });
  } catch (err) {
    console.error('GET /prices error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/prices/crops ────────────────────────────────────────────────────
router.get('/crops', async (req, res) => {
  const { category } = req.query;
  try {
    const cond   = category ? 'WHERE category = $1' : '';
    const params = category ? [category] : [];
    const crops  = await query(
      `SELECT DISTINCT crop, category, unit FROM market_prices ${cond} ORDER BY crop ASC`,
      params
    );
    return res.status(200).json({ success: true, data: { crops, count: crops.length } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/prices/counties ─────────────────────────────────────────────────
router.get('/counties', async (req, res) => {
  try {
    const rows = await query(`
      SELECT county, COUNT(DISTINCT crop)::int AS crop_count, COUNT(*)::int AS price_records
      FROM market_prices
      GROUP BY county ORDER BY county ASC
    `);
    return res.status(200).json({ success: true, data: { counties: rows } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/prices/compare ──────────────────────────────────────────────────
router.get('/compare', async (req, res) => {
  const { crop, counties } = req.query;
  if (!crop) return res.status(400).json({ success: false, message: 'crop is required.' });

  try {
    const countyList = counties ? counties.split(',').map(c => c.trim()) : [];
    let cond   = 'WHERE mp.crop ILIKE $1';
    const params = [`%${crop}%`];
    let idx = 2;

    if (countyList.length > 0) {
      cond += ` AND mp.county = ANY($${idx++})`;
      params.push(countyList);
    }

    const rows = await query(
      `SELECT mp.*, ph.price_avg AS prev_week_avg FROM market_prices mp
       LEFT JOIN price_history ph ON ph.crop = mp.crop AND ph.county = mp.county
         AND ph.week_start = (SELECT MAX(week_start) FROM price_history WHERE crop = mp.crop AND county = mp.county AND week_start < CURRENT_DATE)
       ${cond} ORDER BY mp.county ASC`,
      params
    );

    return res.status(200).json({ success: true, data: { crop, comparison: rows } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/prices/alerts/me ────────────────────────────────────────────────
router.get('/alerts/me', authenticate, async (req, res) => {
  try {
    const alerts = await query(`
      SELECT
        pa.*,
        mp.price_avg  AS current_price,
        mp.trend      AS current_trend,
        mp.trend_pct  AS current_trend_pct,
        mp.price_date AS price_as_of,
        CASE
          WHEN pa.condition = 'above' AND mp.price_avg >= pa.threshold_price THEN TRUE
          WHEN pa.condition = 'below' AND mp.price_avg <= pa.threshold_price THEN TRUE
          ELSE FALSE
        END AS is_triggered_now
      FROM price_alerts pa
      LEFT JOIN market_prices mp
        ON mp.crop ILIKE '%' || pa.crop || '%'
       AND mp.county = pa.county
       AND mp.unit   = pa.unit
      WHERE pa.user_id = $1 AND pa.is_active = TRUE
      ORDER BY pa.created_at DESC
    `, [req.user.id]);

    return res.status(200).json({ success: true, data: { alerts, count: alerts.length } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── POST /api/prices/alerts ──────────────────────────────────────────────────
router.post('/alerts', authenticate, async (req, res) => {
  const { crop, county, unit, condition, threshold_price } = req.body;

  const errors = [];
  if (!crop  || crop.trim().length < 2)                     errors.push('crop is required.');
  if (!county || county.trim().length < 2)                  errors.push('county is required.');
  if (!unit  || !VALID_UNITS.includes(unit))                errors.push(`unit must be one of: ${VALID_UNITS.join(', ')}.`);
  if (!condition || !VALID_CONDITIONS.includes(condition))  errors.push('condition must be "above" or "below".');
  if (!threshold_price || isNaN(threshold_price) || threshold_price <= 0) errors.push('threshold_price must be a positive number.');
  if (errors.length) return res.status(400).json({ success: false, message: 'Validation failed.', errors });

  try {
    const countRow = await queryOne('SELECT COUNT(*) AS n FROM price_alerts WHERE user_id = $1 AND is_active = TRUE', [req.user.id]);
    if (parseInt(countRow.n) >= 10) return res.status(400).json({ success: false, message: 'Maximum 10 active alerts allowed.' });

    const id = uuidv4();
    await execute(
      'INSERT INTO price_alerts (id, user_id, crop, county, unit, condition, threshold_price) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, req.user.id, crop.trim(), county.trim(), unit, condition, parseFloat(threshold_price)]
    );

    const alert = await queryOne('SELECT * FROM price_alerts WHERE id = $1', [id]);
    return res.status(201).json({ success: true, message: `Alert set: notify when ${crop} in ${county} goes ${condition} KSh ${threshold_price}/${unit}.`, data: { alert } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── DELETE /api/prices/alerts/:id ────────────────────────────────────────────
router.delete('/alerts/:id', authenticate, async (req, res) => {
  try {
    const alert = await queryOne('SELECT * FROM price_alerts WHERE id = $1', [req.params.id]);
    if (!alert) return res.status(404).json({ success: false, message: 'Alert not found.' });
    if (alert.user_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied.' });

    await execute('UPDATE price_alerts SET is_active = FALSE WHERE id = $1', [req.params.id]);
    return res.status(200).json({ success: true, message: 'Price alert deleted.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/prices/:crop ─────────────────────────────────────────────────────
router.get('/:crop', async (req, res) => {
  const cropParam = decodeURIComponent(req.params.crop);
  try {
    const rows = await query(`
      SELECT mp.*,
             (SELECT COUNT(*)::int FROM listings l
              WHERE l.county = mp.county
                AND LOWER(l.title) LIKE '%' || LOWER(mp.crop) || '%'
                AND l.status = 'active') AS active_listings
      FROM market_prices mp
      WHERE mp.crop ILIKE $1
      ORDER BY mp.county ASC
    `, [`%${cropParam}%`]);

    if (!rows.length) return res.status(404).json({ success: false, message: `No price data for "${cropParam}". Try /api/prices/crops for available crops.` });

    const national = {
      crop:         rows[0].crop,
      unit:         rows[0].unit,
      price_low:    Math.min(...rows.map(r => parseFloat(r.price_low))),
      price_high:   Math.max(...rows.map(r => parseFloat(r.price_high))),
      price_avg:    Math.round((rows.reduce((s, r) => s + parseFloat(r.price_avg), 0) / rows.length) * 100) / 100,
      county_count: rows.length
    };
    const trending_up   = rows.filter(r => r.trend === 'up').map(r => r.county);
    const trending_down = rows.filter(r => r.trend === 'down').map(r => r.county);

    return res.status(200).json({ success: true, data: { crop: rows[0].crop, national_summary: national, by_county: rows, trending_up, trending_down } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── GET /api/prices/:crop/:county ─────────────────────────────────────────────
router.get('/:crop/:county', async (req, res) => {
  const crop   = decodeURIComponent(req.params.crop);
  const county = decodeURIComponent(req.params.county);

  try {
    const current = await queryOne(
      'SELECT * FROM market_prices WHERE crop ILIKE $1 AND county = $2 ORDER BY price_date DESC LIMIT 1',
      [`%${crop}%`, county]
    );
    if (!current) return res.status(404).json({ success: false, message: `No price data for "${crop}" in ${county}.` });

    const history = await query(`
      SELECT week_start, price_avg, price_low, price_high, sample_size
      FROM price_history WHERE crop ILIKE $1 AND county = $2
      ORDER BY week_start ASC LIMIT 12
    `, [`%${crop}%`, county]);

    const nearbyListings = await query(`
      SELECT l.id, l.title, l.price_per_unit, l.unit, l.quantity, l.location, l.image_urls,
             u.name AS farmer_name, fp.farm_name, fp.rating AS farmer_rating
      FROM listings l
      JOIN users u ON u.id = l.farmer_id
      JOIN farmer_profiles fp ON fp.user_id = l.farmer_id
      WHERE l.county = $1 AND LOWER(l.title) LIKE $2 AND l.status = 'active'
      ORDER BY l.price_per_unit ASC LIMIT 5
    `, [county, `%${crop.toLowerCase()}%`]);

    const nationalRow = await queryOne('SELECT AVG(price_avg) AS avg FROM market_prices WHERE crop ILIKE $1', [`%${crop}%`]);
    const nationalAvg = nationalRow?.avg ? parseFloat(nationalRow.avg) : null;
    const vsNational  = nationalAvg ? Math.round(((parseFloat(current.price_avg) - nationalAvg) / nationalAvg) * 100) : null;

    return res.status(200).json({
      success: true,
      data: {
        current, history,
        nearby_listings: nearbyListings.map(l => ({ ...l, image_urls: Array.isArray(l.image_urls) ? l.image_urls : [] })),
        insights: {
          national_avg:      nationalAvg ? Math.round(nationalAvg * 100) / 100 : null,
          vs_national_pct:   vsNational,
          vs_national_label: vsNational === null ? null
            : vsNational > 0 ? `${vsNational}% above national average`
            : vsNational < 0 ? `${Math.abs(vsNational)}% below national average`
            : 'At national average',
          week_on_week_change: current.trend_pct !== 0
            ? `${current.trend_pct > 0 ? '+' : ''}${current.trend_pct}% vs last week`
            : 'Stable vs last week'
        }
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ── POST /api/prices/sync ─────────────────────────────────────────────────────
router.post('/sync', authenticate, async (req, res) => {
  try {
    const [synced, snapped] = await Promise.all([syncPricesFromListings(), snapshotWeeklyHistory()]);
    return res.status(200).json({ success: true, message: 'Price sync complete.', data: { prices_updated: synced, history_snapped: snapped } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Sync failed: ' + err.message });
  }
});

// ── POST /api/prices/admin/upsert ─────────────────────────────────────────────
router.post('/admin/upsert', authenticate, async (req, res) => {
  const { crop, category, county, market_name, unit, price_low, price_high, price_avg, source = 'admin', price_date, notes } = req.body;

  const errors = [];
  if (!crop)     errors.push('crop is required.');
  if (!category || !VALID_CATEGORIES.includes(category)) errors.push(`category must be one of: ${VALID_CATEGORIES.join(', ')}.`);
  if (!county)   errors.push('county is required.');
  if (!unit || !VALID_UNITS.includes(unit)) errors.push(`unit must be one of: ${VALID_UNITS.join(', ')}.`);
  if (!price_avg || isNaN(price_avg)) errors.push('price_avg is required.');
  if (errors.length) return res.status(400).json({ success: false, message: 'Validation failed.', errors });

  try {
    const today = price_date || new Date().toISOString().split('T')[0];
    const avg   = parseFloat(price_avg);
    const low   = price_low  ? parseFloat(price_low)  : avg * 0.9;
    const high  = price_high ? parseFloat(price_high) : avg * 1.1;

    const existing = await queryOne('SELECT id FROM market_prices WHERE crop = $1 AND county = $2 AND unit = $3', [crop.trim(), county.trim(), unit]);
    const prev     = await queryOne('SELECT price_avg FROM market_prices WHERE crop = $1 AND county = $2 ORDER BY price_date DESC LIMIT 1', [crop.trim(), county.trim()]);
    const pct      = prev ? Math.round(((avg - parseFloat(prev.price_avg)) / parseFloat(prev.price_avg)) * 1000) / 10 : 0;
    const trend    = pct > 2 ? 'up' : pct < -2 ? 'down' : 'stable';

    if (existing) {
      await execute(
        'UPDATE market_prices SET price_low=$1, price_high=$2, price_avg=$3, trend=$4, trend_pct=$5, market_name=$6, source=$7, price_date=$8, notes=$9, updated_at=NOW() WHERE id=$10',
        [low, high, avg, trend, pct, market_name||null, source, today, notes||null, existing.id]
      );
    } else {
      await execute(
        'INSERT INTO market_prices (id,crop,category,county,market_name,unit,price_low,price_high,price_avg,trend,trend_pct,source,price_date,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
        [uuidv4(), crop.trim(), category, county.trim(), market_name||null, unit, low, high, avg, trend, pct, source, today, notes||null]
      );
    }

    await snapshotWeeklyHistory();
    return res.status(200).json({ success: true, message: `Price for "${crop}" in ${county} saved.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
