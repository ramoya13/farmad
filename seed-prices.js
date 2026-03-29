// seed-prices.js — Market price sample data (PostgreSQL)
// Run: node seed-prices.js

require('dotenv').config();
const { initSchema, execute } = require('./src/db/database');
const { syncPricesFromListings, snapshotWeeklyHistory } = require('./src/services/priceEngine');
const { v4: uuidv4 } = require('uuid');

async function seedPrices() {
  await initSchema();
  console.log('💰 Seeding market prices...\n');

  // Clear existing farmad/admin prices (keep any KEBS/KALRO data)
  await execute("DELETE FROM price_history WHERE source = 'farmad'");
  await execute("DELETE FROM market_prices WHERE source IN ('farmad','admin')");

  const today = new Date().toISOString().split('T')[0];

  const priceData = [
    // Vegetables
    { crop: 'Tomatoes',           category: 'vegetables', county: 'Nairobi',   market_name: 'Wakulima Market',   unit: 'kg',     low: 70,   high: 100, avg: 85,   trend: 'up',     pct: 12 },
    { crop: 'Tomatoes',           category: 'vegetables', county: 'Kiambu',    market_name: 'Githunguri Market', unit: 'kg',     low: 55,   high: 80,  avg: 67,   trend: 'up',     pct: 8 },
    { crop: 'Tomatoes',           category: 'vegetables', county: 'Kisumu',    market_name: 'Kibuye Market',     unit: 'kg',     low: 60,   high: 90,  avg: 75,   trend: 'stable', pct: 0 },
    { crop: 'Sukuma Wiki (Kale)', category: 'vegetables', county: 'Nairobi',   market_name: 'Wakulima Market',   unit: 'kg',     low: 35,   high: 55,  avg: 45,   trend: 'stable', pct: 2 },
    { crop: 'Sukuma Wiki (Kale)', category: 'vegetables', county: 'Kiambu',    market_name: 'Limuru Market',     unit: 'kg',     low: 30,   high: 50,  avg: 40,   trend: 'down',   pct: -5 },
    { crop: 'Irish Potatoes',     category: 'vegetables', county: 'Nakuru',    market_name: 'Njoro Market',      unit: 'bags',   low: 2400, high: 3200, avg: 2800, trend: 'stable', pct: 1 },
    { crop: 'Irish Potatoes',     category: 'vegetables', county: 'Nairobi',   market_name: 'Wakulima Market',   unit: 'bags',   low: 2800, high: 3500, avg: 3200, trend: 'up',     pct: 6 },
    { crop: 'Onions',             category: 'vegetables', county: 'Nairobi',   market_name: 'Wakulima Market',   unit: 'kg',     low: 70,   high: 110, avg: 90,   trend: 'up',     pct: 15 },
    { crop: 'Cabbage',            category: 'vegetables', county: 'Kiambu',    market_name: 'Githunguri Market', unit: 'pieces', low: 40,   high: 70,  avg: 55,   trend: 'down',   pct: -8 },
    { crop: 'Carrots',            category: 'vegetables', county: 'Nyandarua', market_name: 'Nyahururu Market',  unit: 'kg',     low: 50,   high: 75,  avg: 62,   trend: 'stable', pct: 0 },

    // Fruits
    { crop: 'Avocados',          category: 'fruits', county: 'Embu',     market_name: 'Embu Market',          unit: 'pieces', low: 15,  high: 30, avg: 22,  trend: 'down',   pct: -10 },
    { crop: 'Avocados',          category: 'fruits', county: 'Meru',     market_name: 'Meru Municipal',       unit: 'pieces', low: 18,  high: 35, avg: 26,  trend: 'down',   pct: -7 },
    { crop: 'Mangoes',           category: 'fruits', county: 'Kilifi',   market_name: 'Malindi Market',       unit: 'kg',     low: 40,  high: 70, avg: 55,  trend: 'up',     pct: 20 },
    { crop: 'Mangoes',           category: 'fruits', county: 'Nairobi',  market_name: 'Wakulima Market',      unit: 'kg',     low: 60,  high: 95, avg: 78,  trend: 'up',     pct: 25 },
    { crop: 'Passion Fruits',    category: 'fruits', county: 'Embu',     market_name: 'Runyenjes Market',     unit: 'kg',     low: 70,  high: 110, avg: 90, trend: 'stable', pct: 3 },
    { crop: 'Bananas',           category: 'fruits', county: 'Meru',     market_name: 'Meru Municipal',       unit: 'kg',     low: 30,  high: 50, avg: 40,  trend: 'stable', pct: 0 },

    // Grains
    { crop: 'Maize',  category: 'grains', county: 'Nakuru',      market_name: 'Nakuru Grain Market',  unit: 'bags', low: 3200, high: 4000, avg: 3600, trend: 'up',     pct: 5 },
    { crop: 'Maize',  category: 'grains', county: 'Uasin Gishu', market_name: 'Eldoret Grain Market', unit: 'bags', low: 3000, high: 3800, avg: 3400, trend: 'stable', pct: 2 },
    { crop: 'Wheat',  category: 'grains', county: 'Uasin Gishu', market_name: 'Eldoret Grain Market', unit: 'bags', low: 4000, high: 4800, avg: 4400, trend: 'up',     pct: 4 },
    { crop: 'Beans',  category: 'legumes', county: 'Meru',       market_name: 'Meru Municipal',       unit: 'kg',   low: 100,  high: 150, avg: 125,  trend: 'up',     pct: 8 },
    { crop: 'Beans',  category: 'legumes', county: 'Nairobi',    market_name: 'Wakulima Market',      unit: 'kg',   low: 110,  high: 160, avg: 135,  trend: 'up',     pct: 10 },

    // Dairy
    { crop: 'Milk',  category: 'dairy', county: 'Nakuru',  market_name: 'Njoro Market',    unit: 'litres', low: 45, high: 65, avg: 55, trend: 'stable', pct: 0 },
    { crop: 'Milk',  category: 'dairy', county: 'Kiambu',  market_name: 'Githunguri Co-op', unit: 'litres', low: 50, high: 70, avg: 60, trend: 'up',    pct: 5 },
    { crop: 'Eggs',  category: 'dairy', county: 'Nairobi', market_name: 'Wakulima Market', unit: 'pieces', low: 14, high: 20, avg: 17, trend: 'stable', pct: 1 },
  ];

  for (const p of priceData) {
    await execute(`
      INSERT INTO market_prices (id,crop,category,county,market_name,unit,price_low,price_high,price_avg,trend,trend_pct,source,price_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'admin',$12)
    `, [uuidv4(), p.crop, p.category, p.county, p.market_name, p.unit, p.low, p.high, p.avg, p.trend, p.pct, today]);
  }

  console.log(`  ✅ Inserted ${priceData.length} market price records`);

  // Seed 8 weeks of historical data
  for (let weeksAgo = 8; weeksAgo >= 1; weeksAgo--) {
    const d = new Date();
    const day = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1) - (weeksAgo * 7));
    const weekStart = d.toISOString().split('T')[0];

    for (const p of priceData) {
      const noise = 0.9 + Math.random() * 0.2;
      const avg   = Math.round(p.avg * noise * 100) / 100;
      const low   = Math.round(p.low * noise * 100) / 100;
      const high  = Math.round(p.high * noise * 100) / 100;

      await execute(`
        INSERT INTO price_history (id,crop,county,unit,price_avg,price_low,price_high,week_start,source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'admin')
        ON CONFLICT (crop, county, week_start) DO NOTHING
      `, [uuidv4(), p.crop, p.county, p.unit, avg, low, high, weekStart]);
    }
  }
  console.log('  ✅ 8 weeks of price history seeded');

  // Sync listing-derived prices on top
  try {
    const synced = await syncPricesFromListings();
    const snapped = await snapshotWeeklyHistory();
    console.log(`  ✅ Synced ${synced} prices from active listings`);
    console.log(`  ✅ Snapshotted ${snapped} history records`);
  } catch (e) {
    console.warn('  ⚠️  Price sync skipped (no listings yet?):', e.message);
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log('✅ Prices seeded! Try GET /api/prices?county=Nairobi');
  console.log('════════════════════════════════════════════════════\n');

  process.exit(0);
}

seedPrices().catch(err => { console.error('❌ seed-prices failed:', err.message); process.exit(1); });
