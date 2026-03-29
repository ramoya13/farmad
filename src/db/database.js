// src/db/database.js
// PostgreSQL connection pool + schema init
// Replaces better-sqlite3 with pg (node-postgres)

const { Pool } = require('pg');
require('dotenv').config();

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }   // Required for Railway / Render / Heroku managed Postgres
        : false
    });
    pool.on('error', (err) => {
      console.error('Unexpected Postgres pool error:', err);
    });
  }
  return pool;
}

// Run a parameterised query, return all rows
async function query(sql, params = []) {
  const result = await getPool().query(sql, params);
  return result.rows;
}

// Run a query, return first row only (or null)
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

// Run without needing rows back
async function execute(sql, params = []) {
  return getPool().query(sql, params);
}

// Transaction: passes a dedicated client to callback fn
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Schema ────────────────────────────────────────────────────────────────────
async function initSchema() {
  const p = getPool();

  await p.query(`
    DO $$ BEGIN CREATE TYPE user_role AS ENUM ('farmer','buyer');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    DO $$ BEGIN CREATE TYPE listing_category AS ENUM ('vegetables','fruits','grains','dairy','legumes','livestock','other');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    DO $$ BEGIN CREATE TYPE listing_unit AS ENUM ('kg','bags','crates','litres','pieces','tonnes');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    DO $$ BEGIN CREATE TYPE listing_status AS ENUM ('active','sold','expired','draft');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    DO $$ BEGIN CREATE TYPE order_status AS ENUM ('pending','confirmed','ready','in_transit','delivered','cancelled','disputed');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    DO $$ BEGIN CREATE TYPE delivery_type AS ENUM ('pickup','delivery');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    DO $$ BEGIN CREATE TYPE payment_method AS ENUM ('mpesa','cash','bank');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    DO $$ BEGIN CREATE TYPE payment_status_t AS ENUM ('pending','processing','completed','failed','refunded');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    DO $$ BEGIN CREATE TYPE price_trend AS ENUM ('up','down','stable');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    DO $$ BEGIN CREATE TYPE price_source AS ENUM ('farmad','admin','kebs','kalro');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    DO $$ BEGIN CREATE TYPE buyer_type_t AS ENUM ('individual','restaurant','supermarket','exporter','institution');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    DO $$ BEGIN CREATE TYPE alert_condition AS ENUM ('above','below');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      email       TEXT UNIQUE NOT NULL,
      phone       TEXT UNIQUE NOT NULL,
      password    TEXT NOT NULL,
      role        user_role NOT NULL,
      county      TEXT NOT NULL,
      is_verified BOOLEAN NOT NULL DEFAULT FALSE,
      avatar_url  TEXT,
      bio         TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS farmer_profiles (
      user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      farm_name     TEXT NOT NULL,
      farm_size_ha  NUMERIC,
      farm_location TEXT NOT NULL,
      county        TEXT NOT NULL,
      produce_types TEXT,
      rating        NUMERIC NOT NULL DEFAULT 0.0,
      total_reviews INTEGER NOT NULL DEFAULT 0,
      total_sales   INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS buyer_profiles (
      user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      business_name  TEXT,
      buyer_type     buyer_type_t NOT NULL,
      rating         NUMERIC NOT NULL DEFAULT 0.0,
      total_reviews  INTEGER NOT NULL DEFAULT 0,
      total_orders   INTEGER NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token      TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS listings (
      id              TEXT PRIMARY KEY,
      farmer_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title           TEXT NOT NULL,
      category        listing_category NOT NULL,
      description     TEXT,
      quantity        NUMERIC NOT NULL,
      unit            listing_unit NOT NULL,
      price_per_unit  NUMERIC NOT NULL,
      min_order_qty   NUMERIC NOT NULL DEFAULT 1,
      county          TEXT NOT NULL,
      location        TEXT NOT NULL,
      harvest_date    DATE,
      expiry_date     DATE,
      is_organic      BOOLEAN NOT NULL DEFAULT FALSE,
      is_available    BOOLEAN NOT NULL DEFAULT TRUE,
      status          listing_status NOT NULL DEFAULT 'active',
      views           INTEGER NOT NULL DEFAULT 0,
      image_urls      JSONB NOT NULL DEFAULT '[]',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS saved_listings (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      listing_id  TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, listing_id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id                TEXT PRIMARY KEY,
      buyer_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      farmer_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status            order_status NOT NULL DEFAULT 'pending',
      subtotal          NUMERIC NOT NULL,
      delivery_fee      NUMERIC NOT NULL DEFAULT 0,
      total_amount      NUMERIC NOT NULL,
      delivery_type     delivery_type NOT NULL DEFAULT 'pickup',
      delivery_address  TEXT,
      delivery_county   TEXT,
      notes             TEXT,
      cancelled_by      TEXT,
      cancel_reason     TEXT,
      confirmed_at      TIMESTAMPTZ,
      ready_at          TIMESTAMPTZ,
      delivered_at      TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id              TEXT PRIMARY KEY,
      order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      listing_id      TEXT NOT NULL REFERENCES listings(id) ON DELETE RESTRICT,
      title           TEXT NOT NULL,
      quantity        NUMERIC NOT NULL,
      unit            TEXT NOT NULL,
      price_per_unit  NUMERIC NOT NULL,
      line_total      NUMERIC NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id                    TEXT PRIMARY KEY,
      order_id              TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      payer_id              TEXT NOT NULL REFERENCES users(id),
      amount                NUMERIC NOT NULL,
      phone                 TEXT NOT NULL,
      method                payment_method NOT NULL DEFAULT 'mpesa',
      status                payment_status_t NOT NULL DEFAULT 'pending',
      mpesa_checkout_id     TEXT,
      mpesa_merchant_ref    TEXT,
      mpesa_receipt         TEXT,
      mpesa_transaction_date TEXT,
      mpesa_phone_used      TEXT,
      mpesa_raw_callback    TEXT,
      failure_reason        TEXT,
      paid_at               TIMESTAMPTZ,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id                   TEXT PRIMARY KEY,
      order_id             TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      reviewer_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reviewee_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reviewer_role        TEXT NOT NULL CHECK(reviewer_role IN ('buyer','farmer')),
      rating               INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      comment              TEXT,
      rating_quality       INTEGER CHECK(rating_quality       BETWEEN 1 AND 5),
      rating_communication INTEGER CHECK(rating_communication BETWEEN 1 AND 5),
      rating_punctuality   INTEGER CHECK(rating_punctuality   BETWEEN 1 AND 5),
      is_flagged    BOOLEAN NOT NULL DEFAULT FALSE,
      flag_reason   TEXT,
      reply         TEXT,
      replied_at    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(order_id, reviewer_id)
    );

    CREATE TABLE IF NOT EXISTS market_prices (
      id            TEXT PRIMARY KEY,
      crop          TEXT NOT NULL,
      category      listing_category NOT NULL,
      county        TEXT NOT NULL,
      market_name   TEXT,
      unit          listing_unit NOT NULL,
      price_low     NUMERIC NOT NULL,
      price_high    NUMERIC NOT NULL,
      price_avg     NUMERIC NOT NULL,
      trend         price_trend NOT NULL DEFAULT 'stable',
      trend_pct     NUMERIC NOT NULL DEFAULT 0,
      source        price_source NOT NULL DEFAULT 'farmad',
      price_date    DATE NOT NULL,
      valid_until   DATE,
      notes         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id          TEXT PRIMARY KEY,
      crop        TEXT NOT NULL,
      county      TEXT NOT NULL,
      unit        TEXT NOT NULL,
      price_avg   NUMERIC NOT NULL,
      price_low   NUMERIC NOT NULL,
      price_high  NUMERIC NOT NULL,
      sample_size INTEGER NOT NULL DEFAULT 1,
      week_start  DATE NOT NULL,
      source      TEXT NOT NULL DEFAULT 'farmad',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(crop, county, week_start)
    );

    CREATE TABLE IF NOT EXISTS price_alerts (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      crop            TEXT NOT NULL,
      county          TEXT NOT NULL,
      unit            TEXT NOT NULL,
      condition       alert_condition NOT NULL,
      threshold_price NUMERIC NOT NULL,
      is_active       BOOLEAN NOT NULL DEFAULT TRUE,
      last_triggered  TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_phone  ON users(phone);
    CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user  ON refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token);
    CREATE INDEX IF NOT EXISTS idx_listings_farmer   ON listings(farmer_id);
    CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category);
    CREATE INDEX IF NOT EXISTS idx_listings_county   ON listings(county);
    CREATE INDEX IF NOT EXISTS idx_listings_status   ON listings(status);
    CREATE INDEX IF NOT EXISTS idx_listings_price    ON listings(price_per_unit);
    CREATE INDEX IF NOT EXISTS idx_saved_user        ON saved_listings(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_buyer      ON orders(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_farmer     ON orders(farmer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_order_items_order   ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_listing ON order_items(listing_id);
    CREATE INDEX IF NOT EXISTS idx_payments_order  ON payments(order_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_payments_mpesa  ON payments(mpesa_checkout_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_reviewee ON reviews(reviewee_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON reviews(reviewer_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_order    ON reviews(order_id);
    CREATE INDEX IF NOT EXISTS idx_market_prices_crop   ON market_prices(crop);
    CREATE INDEX IF NOT EXISTS idx_market_prices_county ON market_prices(county);
    CREATE INDEX IF NOT EXISTS idx_market_prices_cat    ON market_prices(category);
    CREATE INDEX IF NOT EXISTS idx_price_history_crop   ON price_history(crop, county);
    CREATE INDEX IF NOT EXISTS idx_price_history_week   ON price_history(week_start);
    CREATE INDEX IF NOT EXISTS idx_price_alerts_user    ON price_alerts(user_id);
  `);

  console.log('✅ PostgreSQL schema initialised');
}

module.exports = { getPool, query, queryOne, execute, withTransaction, initSchema };
