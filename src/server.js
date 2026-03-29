// src/server.js — FarmAd Kenya API Server v2.0 (PostgreSQL)

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const { initSchema }       = require('./db/database');
const { syncPricesFromListings, snapshotWeeklyHistory } = require('./services/priceEngine');
const authRoutes           = require('./routes/auth');
const listingsRoutes       = require('./routes/listings');
const ordersRoutes         = require('./routes/orders');
const paymentsRoutes       = require('./routes/payments');
const reviewsRoutes        = require('./routes/reviews');
const profilesRoutes       = require('./routes/profiles');
const pricesRoutes         = require('./routes/prices');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin:         process.env.FRONTEND_URL || '*',
  methods:        ['GET','POST','PATCH','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials:    true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/listings', listingsRoutes);
app.use('/api/orders',   ordersRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/reviews',  reviewsRoutes);
app.use('/api/profiles', profilesRoutes);
app.use('/api/prices',   pricesRoutes);

app.get('/api/health', (_req, res) => res.json({
  success: true, message: 'FarmAd API 🌱', version: '2.0.0',
  db: 'postgresql',
  modules: ['auth','listings','orders','payments','reviews','profiles','prices'],
  timestamp: new Date().toISOString()
}));

app.use('/api/*', (req, res) =>
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found.` })
);
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
});

// ── Start: init DB then listen ────────────────────────────────────────────────
async function start() {
  try {
    await initSchema();
    console.log('✅ Connected to PostgreSQL');

    // Sync prices from listing data (non-blocking — warn but don't crash)
    syncPricesFromListings().then(snapshotWeeklyHistory).catch(e => {
      console.warn('Price sync on startup skipped:', e.message);
    });

    app.listen(PORT, () => {
      console.log(`
  ╔═══════════════════════════════════════════════════════╗
  ║          🌱  FarmAd API Server  v2.0                  ║
  ║─────────────────────────────────────────────────────── ║
  ║  http://localhost:${PORT}                               ║
  ║  PostgreSQL  ·  auth · listings · orders              ║
  ║  payments · reviews · profiles · prices               ║
  ╚═══════════════════════════════════════════════════════╝
      `);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err.message);
    console.error('   Make sure DATABASE_URL is set correctly in .env');
    process.exit(1);
  }
}

start();
module.exports = app;
