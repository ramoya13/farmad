# 🌱 FarmAd Backend — v1.4 (Complete)

Full-stack Kenya agricultural marketplace API.
Auth · Listings · Orders · Payments · Reviews · Profiles · Market Prices

---

## 🚀 Quick Start

```bash
npm install
cp .env.example .env       # set JWT_SECRET + M-Pesa keys
npm run dev                # start on :5000

npm run seed               # users, listings, orders, reviews
npm run seed:prices        # Kenya commodity prices + 12-week history
# or both at once:
npm run seed:all
```

---

## 📦 All 7 API Modules

| Module | Base Path | Key Features |
|---|---|---|
| Auth | `/api/auth` | JWT, refresh tokens, M-Pesa phone validation |
| Listings | `/api/listings` | CRUD, search, 7 filters, pagination, bookmarks |
| Orders | `/api/orders` | Full lifecycle, delivery fee calc, status history |
| Payments | `/api/payments` | M-Pesa STK Push, Safaricom callback, cash |
| Reviews | `/api/reviews` | Sub-ratings, replies, flagging, auto-recalc |
| Profiles | `/api/profiles` | Public cards, farmer browse, leaderboard |
| Prices | `/api/prices` | Live prices, history charts, alerts, county compare |

---

## 💹 Market Prices API — `/api/prices`

### Endpoints

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/` | — | Browse all prices (7 filters + pagination) |
| GET | `/crops` | — | All tracked crops with national avg |
| GET | `/counties` | — | Counties with price coverage |
| GET | `/compare` | — | Same crop across multiple counties |
| GET | `/:crop` | — | All-county summary + trending |
| GET | `/:crop/:county` | — | Deep dive + 12-week chart + nearby listings |
| POST | `/alerts` | ✅ | Create a price threshold alert |
| GET | `/alerts/me` | ✅ | My active alerts with live status |
| DELETE | `/alerts/:id` | ✅ | Delete an alert |
| POST | `/sync` | ✅ | Sync prices from live listing data |
| POST | `/admin/upsert` | ✅ | Admin: manually post a curated price |

### Example Queries

```bash
# Current prices for tomatoes
GET /api/prices?crop=tomatoes

# All vegetable prices in Nairobi
GET /api/prices?category=vegetables&county=Nairobi

# Trending-up crops across Kenya
GET /api/prices?trend=up&sort=trend_pct&order=desc

# Price deep-dive with history for chart
GET /api/prices/Tomatoes/Nairobi

# Side-by-side county comparison
GET /api/prices/compare?crop=Tomatoes&counties=Nairobi,Kiambu,Mombasa,Nakuru

# All tracked crops with national averages
GET /api/prices/crops?category=vegetables
```

### Price Alert
```http
POST /api/prices/alerts
Authorization: Bearer <token>

{
  "crop":            "Tomatoes",
  "county":          "Nairobi",
  "unit":            "kg",
  "condition":       "below",
  "threshold_price": 60
}
```
→ Notify me when Tomatoes in Nairobi drop below KSh 60/kg.

### Response: `/api/prices/Tomatoes/Nairobi`
```json
{
  "current": {
    "crop": "Tomatoes", "county": "Nairobi",
    "price_low": 60, "price_avg": 85, "price_high": 120,
    "trend": "stable", "trend_pct": 0,
    "market_name": "Wakulima Market"
  },
  "history": [...12 weekly data points for chart...],
  "nearby_listings": [...5 active tomato listings in Nairobi...],
  "insights": {
    "national_avg": 73,
    "vs_national_pct": 16,
    "vs_national_label": "16% above national average",
    "week_on_week_change": "Stable vs last week"
  }
}
```

---

## 🔄 How Prices Are Generated

**Three sources, in priority order:**

1. **Delivered orders** (ground truth) — real transaction prices from the last 30 days
2. **Active listings** — current ask prices from farmers across Kenya
3. **Admin/KEBS** — manually entered reference prices from Wakulima, Kongowea etc.

The `POST /api/prices/sync` endpoint (or auto-sync on server startup) scans all listings and orders, groups by `(crop, county, unit)`, computes min/max/avg, detects trend vs previous week, and upserts `market_prices`. It also snapshots `price_history` for chart data.

---

## 🗄️ New Tables

| Table | Description |
|---|---|
| `market_prices` | Current price per crop × county × unit with trend |
| `price_history` | Weekly snapshots for chart data (12+ weeks) |
| `price_alerts` | User-defined price threshold subscriptions |

---

## 🧪 Test After Seeding

```bash
npm run seed:all

# In another terminal:
curl http://localhost:5000/api/prices/crops
curl "http://localhost:5000/api/prices/Tomatoes/Nairobi"
curl "http://localhost:5000/api/prices/compare?crop=Tomatoes&counties=Nairobi,Kiambu,Mombasa"
curl http://localhost:5000/api/health
```
