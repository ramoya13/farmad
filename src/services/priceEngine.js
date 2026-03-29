// src/services/priceEngine.js — Price intelligence (PostgreSQL)
const { query, queryOne, execute } = require('../db/database');
const { v4: uuidv4 } = require('uuid');

const CROP_ALIASES = {
  'sukuma wiki': 'Sukuma Wiki (Kale)', 'kale': 'Sukuma Wiki (Kale)',
  'tomato': 'Tomatoes',  'tomatoes': 'Tomatoes',  'vine tomato': 'Tomatoes',
  'onion': 'Onions',     'onions': 'Onions',      'spring onion': 'Spring Onions',
  'cabbage': 'Cabbage',  'spinach': 'Spinach',    'carrot': 'Carrots', 'carrots': 'Carrots',
  'capsicum': 'Capsicum', 'pepper': 'Capsicum',   'courgette': 'Courgette',
  'irish potato': 'Irish Potatoes', 'potato': 'Irish Potatoes', 'shangi': 'Irish Potatoes',
  'sweet potato': 'Sweet Potatoes', 'cassava': 'Cassava',
  'avocado': 'Avocados', 'hass avocado': 'Avocados',
  'mango': 'Mangoes',    'passion fruit': 'Passion Fruits', 'banana': 'Bananas',
  'pineapple': 'Pineapples', 'watermelon': 'Watermelon', 'coconut': 'Coconuts',
  'maize': 'Maize',   'dry maize': 'Maize', 'wheat': 'Wheat', 'rice': 'Rice',
  'sorghum': 'Sorghum', 'millet': 'Millet',
  'beans': 'Beans',   'green bean': 'Green Beans', 'pea': 'Peas', 'garden pea': 'Peas',
  'lentil': 'Lentils', 'groundnut': 'Groundnuts', 'soybean': 'Soybeans',
  'milk': 'Milk', 'raw milk': 'Milk', 'egg': 'Eggs', 'eggs': 'Eggs',
  'free-range egg': 'Eggs', 'butter': 'Butter',
  'tilapia': 'Tilapia Fish', 'fish': 'Fish',
  'chicken': 'Chicken', 'goat': 'Goat Meat',
};

function normaliseCrop(title) {
  const lower = title.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  for (const [alias, canonical] of Object.entries(CROP_ALIASES)) {
    if (lower.includes(alias)) return canonical;
  }
  return title.split(' ').slice(0, 3)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function currentWeekStart() {
  const now  = new Date();
  const day  = now.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  const mon  = new Date(now);
  mon.setUTCDate(now.getUTCDate() + diff);
  return mon.toISOString().split('T')[0];
}

function calcTrend(newAvg, prevAvg) {
  if (!prevAvg) return { trend: 'stable', pct: 0 };
  const pct = Math.round(((newAvg - prevAvg) / prevAvg) * 1000) / 10;
  const trend = pct > 2 ? 'up' : pct < -2 ? 'down' : 'stable';
  return { trend, pct };
}

// ── syncPricesFromListings ────────────────────────────────────────────────────
async function syncPricesFromListings() {
  const today = new Date().toISOString().split('T')[0];
  let   upserted = 0;

  // Source 1: active listing prices grouped by crop/county
  const listingGroups = await query(`
    SELECT
      l.title,
      l.category,
      u.county,
      l.unit,
      MIN(l.price_per_unit)  AS price_low,
      MAX(l.price_per_unit)  AS price_high,
      AVG(l.price_per_unit)  AS price_avg,
      COUNT(*)               AS sample_size
    FROM listings l
    JOIN users u ON u.id = l.farmer_id
    WHERE l.status = 'active' AND l.is_available = TRUE
    GROUP BY l.title, l.category, u.county, l.unit
  `);

  // Source 2: delivered order transaction prices (last 30 days)
  const orderGroups = await query(`
    SELECT
      oi.title,
      l.category,
      u.county,
      oi.unit,
      MIN(oi.price_per_unit) AS price_low,
      MAX(oi.price_per_unit) AS price_high,
      AVG(oi.price_per_unit) AS price_avg,
      COUNT(*)               AS sample_size
    FROM order_items oi
    JOIN orders   o ON o.id  = oi.order_id
    JOIN listings l ON l.id  = oi.listing_id
    JOIN users    u ON u.id  = o.farmer_id
    WHERE o.status = 'delivered'
      AND o.delivered_at >= NOW() - INTERVAL '30 days'
    GROUP BY l.category, u.county, oi.unit, oi.title
  `);

  const allGroups = [...listingGroups, ...orderGroups];

  for (const row of allGroups) {
    const crop   = normaliseCrop(row.title);
    const county = row.county;
    const unit   = row.unit;

    const previous = await queryOne(
      'SELECT price_avg FROM market_prices WHERE crop = $1 AND county = $2 AND unit = $3 ORDER BY price_date DESC LIMIT 1',
      [crop, county, unit]
    );

    const { trend, pct } = calcTrend(parseFloat(row.price_avg), previous?.price_avg ? parseFloat(previous.price_avg) : null);

    const existing = await queryOne(
      "SELECT id FROM market_prices WHERE crop = $1 AND county = $2 AND unit = $3 AND source IN ('farmad','admin')",
      [crop, county, unit]
    );

    if (existing) {
      await execute(`
        UPDATE market_prices
        SET price_low  = $1, price_high = $2, price_avg = $3,
            trend = $4, trend_pct = $5, price_date = $6, updated_at = NOW()
        WHERE id = $7
      `, [
        Math.round(parseFloat(row.price_low)  * 100) / 100,
        Math.round(parseFloat(row.price_high) * 100) / 100,
        Math.round(parseFloat(row.price_avg)  * 100) / 100,
        trend, pct, today, existing.id
      ]);
    } else {
      await execute(`
        INSERT INTO market_prices
          (id, crop, category, county, unit, price_low, price_high, price_avg, trend, trend_pct, price_date, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'farmad')
      `, [
        uuidv4(), crop, row.category, county, unit,
        Math.round(parseFloat(row.price_low)  * 100) / 100,
        Math.round(parseFloat(row.price_high) * 100) / 100,
        Math.round(parseFloat(row.price_avg)  * 100) / 100,
        trend, pct, today
      ]);
    }
    upserted++;
  }

  console.log(`✅ priceEngine: synced ${upserted} price records`);
  return upserted;
}

// ── snapshotWeeklyHistory ─────────────────────────────────────────────────────
async function snapshotWeeklyHistory() {
  const weekStart = currentWeekStart();
  let   snapped   = 0;

  const prices = await query("SELECT * FROM market_prices WHERE source = 'farmad'");

  for (const p of prices) {
    const existing = await queryOne(
      'SELECT id FROM price_history WHERE crop = $1 AND county = $2 AND week_start = $3',
      [p.crop, p.county, weekStart]
    );

    if (existing) {
      await execute(
        'UPDATE price_history SET price_avg = $1, price_low = $2, price_high = $3 WHERE id = $4',
        [p.price_avg, p.price_low, p.price_high, existing.id]
      );
    } else {
      await execute(`
        INSERT INTO price_history (id, crop, county, unit, price_avg, price_low, price_high, week_start, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'farmad')
      `, [uuidv4(), p.crop, p.county, p.unit, p.price_avg, p.price_low, p.price_high, weekStart]);
    }
    snapped++;
  }

  console.log(`✅ priceEngine: snapshotted ${snapped} history records for week ${weekStart}`);
  return snapped;
}

// ── checkPriceAlerts ─────────────────────────────────────────────────────────
async function checkPriceAlerts(crop, county, newAvgPrice) {
  const triggered = await query(`
    SELECT pa.*, u.name, u.phone, u.email
    FROM price_alerts pa
    JOIN users u ON u.id = pa.user_id
    WHERE pa.crop = $1 AND pa.county = $2 AND pa.is_active = TRUE
      AND (
        (pa.condition = 'above' AND $3 >= pa.threshold_price) OR
        (pa.condition = 'below' AND $3 <= pa.threshold_price)
      )
      AND (pa.last_triggered IS NULL OR pa.last_triggered < NOW() - INTERVAL '24 hours')
  `, [crop, county, newAvgPrice]);

  if (triggered.length > 0) {
    const ids = triggered.map(a => `'${a.id}'`).join(',');
    await execute(`UPDATE price_alerts SET last_triggered = NOW() WHERE id IN (${ids})`);
  }

  return triggered;
}

module.exports = { syncPricesFromListings, snapshotWeeklyHistory, checkPriceAlerts, normaliseCrop, currentWeekStart };
