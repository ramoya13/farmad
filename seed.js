// seed.js — FarmAd sample data (PostgreSQL)
// Run: node seed.js

require('dotenv').config();
const { initSchema, query, queryOne, execute, withTransaction } = require('./src/db/database');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

async function seed() {
  await initSchema();
  console.log('🌱 Seeding FarmAd database...\n');

  const password = bcrypt.hashSync('password123', 12);

  // ── Clear existing seed data ────────────────────────────────────────────────
  await execute("DELETE FROM listings WHERE farmer_id IN (SELECT id FROM users WHERE email LIKE '%@seed.farmad.ke')");
  await execute("DELETE FROM farmer_profiles WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@seed.farmad.ke')");
  await execute("DELETE FROM buyer_profiles  WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@seed.farmad.ke')");
  await execute("DELETE FROM users WHERE email LIKE '%@seed.farmad.ke'");

  // ── Farmers ──────────────────────────────────────────────────────────────────
  const farmerData = [
    { name: 'Grace Wanjiku',   email: 'grace@seed.farmad.ke',   phone: '0712100001', county: 'Kiambu',  farm_name: 'Wanjiku Farm',       farm_location: 'Limuru, Kiambu' },
    { name: 'Peter Mwangi',    email: 'peter@seed.farmad.ke',    phone: '0712100002', county: 'Embu',    farm_name: 'Mwangi Highland',     farm_location: 'Runyenjes, Embu' },
    { name: 'Atieno Onyango',  email: 'atieno@seed.farmad.ke',  phone: '0712100003', county: 'Kisumu',  farm_name: 'Lakeside Greens',     farm_location: 'Ahero, Kisumu' },
    { name: 'Samuel Kipkorir', email: 'samuel@seed.farmad.ke',  phone: '0712100004', county: 'Nakuru',  farm_name: 'Rift Valley Produce', farm_location: 'Njoro, Nakuru' },
    { name: 'Fatuma Hassan',   email: 'fatuma@seed.farmad.ke',  phone: '0712100005', county: 'Kilifi',  farm_name: 'Coastal Organics',    farm_location: 'Malindi, Kilifi' },
  ];

  const farmerIds = [];
  for (const f of farmerData) {
    const id = uuidv4();
    farmerIds.push(id);
    await execute(
      'INSERT INTO users (id,name,email,phone,password,role,county,is_verified) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, f.name, f.email, f.phone, password, 'farmer', f.county, true]
    );
    await execute(
      'INSERT INTO farmer_profiles (user_id,farm_name,farm_location,county,produce_types,rating,total_reviews) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, f.farm_name, f.farm_location, f.county, 'vegetables,fruits', (3.8 + Math.random() * 1.2).toFixed(1), Math.floor(Math.random() * 40) + 5]
    );
    console.log(`  ✅ Farmer: ${f.name} (${f.county})`);
  }

  // ── Buyers ──────────────────────────────────────────────────────────────────
  const buyerData = [
    { name: 'David Otieno', email: 'david@seed.farmad.ke', phone: '0722001001', county: 'Nairobi', buyer_type: 'restaurant',  business_name: 'Savanna Grill' },
    { name: 'Mercy Njeri',  email: 'mercy@seed.farmad.ke', phone: '0722001002', county: 'Nairobi', buyer_type: 'supermarket', business_name: 'FreshMart Supermarket' },
    { name: 'John Ochieng', email: 'john@seed.farmad.ke',  phone: '0722001003', county: 'Kisumu',  buyer_type: 'individual',  business_name: null },
  ];
  const buyerIds = [];
  for (const b of buyerData) {
    const id = uuidv4();
    buyerIds.push(id);
    await execute(
      'INSERT INTO users (id,name,email,phone,password,role,county) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, b.name, b.email, b.phone, password, 'buyer', b.county]
    );
    await execute(
      'INSERT INTO buyer_profiles (user_id,buyer_type,business_name) VALUES ($1,$2,$3)',
      [id, b.buyer_type, b.business_name]
    );
    console.log(`  ✅ Buyer:  ${b.name} (${b.buyer_type})`);
  }

  // ── Listings ─────────────────────────────────────────────────────────────────
  const listings = [
    { farmer: 0, title: 'Fresh Sukuma Wiki (Kale)', category: 'vegetables', quantity: 500, unit: 'kg', price: 45, county: 'Kiambu', location: 'Limuru, Kiambu', is_organic: true, description: 'Freshly harvested sukuma wiki, pesticide-free. Available for bulk orders.' },
    { farmer: 0, title: 'Spring Onions – Bundle',  category: 'vegetables', quantity: 200, unit: 'kg', price: 80, county: 'Kiambu', location: 'Limuru, Kiambu', is_organic: true, description: 'Crisp spring onions, great for restaurants. Bundles of 500g available.' },
    { farmer: 0, title: 'Garden Peas (Fresh)',      category: 'legumes',    quantity: 150, unit: 'kg', price: 120, county: 'Kiambu', location: 'Limuru, Kiambu', is_organic: false, description: 'Sweet fresh garden peas, just shelled.' },
    { farmer: 1, title: 'Hass Avocados (Grade A)', category: 'fruits',     quantity: 800, unit: 'pieces', price: 25, county: 'Embu', location: 'Runyenjes, Embu', is_organic: false, description: 'Premium Grade A Hass avocados, consistent size and quality.' },
    { farmer: 1, title: 'Passion Fruits (Purple)', category: 'fruits',     quantity: 300, unit: 'kg', price: 90, county: 'Embu', location: 'Runyenjes, Embu', is_organic: false, description: 'Ripe purple passion fruits, ideal for juice processors and exporters.' },
    { farmer: 1, title: 'Dry Maize (2024 Harvest)', category: 'grains',   quantity: 20, unit: 'bags', price: 4500, county: 'Embu', location: 'Runyenjes, Embu', is_organic: false, description: '90kg bags, moisture below 13.5%. Clean, no aflatoxin.' },
    { farmer: 2, title: 'Tilapia Fish (Fresh)',     category: 'other',     quantity: 100, unit: 'kg', price: 350, county: 'Kisumu', location: 'Ahero, Kisumu', is_organic: false, description: 'Fresh Lake Victoria tilapia, iced. Min order 20kg.' },
    { farmer: 2, title: 'Vine Tomatoes',            category: 'vegetables', quantity: 400, unit: 'kg', price: 80, county: 'Kisumu', location: 'Ahero, Kisumu', is_organic: false, description: 'Bright red vine tomatoes, uniform size.' },
    { farmer: 2, title: 'Sweet Potatoes (Orange)',  category: 'vegetables', quantity: 600, unit: 'kg', price: 40, county: 'Kisumu', location: 'Ahero, Kisumu', is_organic: true, description: 'Beta-carotene rich orange-fleshed sweet potatoes.' },
    { farmer: 3, title: 'Fresh Milk (Raw)',         category: 'dairy',     quantity: 200, unit: 'litres', price: 60, county: 'Nakuru', location: 'Njoro, Nakuru', is_organic: false, description: 'Fresh raw milk from Friesian cows. KEBS certified farm.' },
    { farmer: 3, title: 'Free-Range Eggs',          category: 'dairy',     quantity: 500, unit: 'pieces', price: 18, county: 'Nakuru', location: 'Njoro, Nakuru', is_organic: true, description: 'Eggs from free-range hens, no antibiotics.' },
    { farmer: 3, title: 'Irish Potatoes (Shangi)',  category: 'vegetables', quantity: 50, unit: 'bags', price: 2800, county: 'Nakuru', location: 'Njoro, Nakuru', is_organic: false, description: '110kg bags. Clean, uniform size.' },
    { farmer: 4, title: 'Coconuts (Mature)',        category: 'fruits',    quantity: 1000, unit: 'pieces', price: 35, county: 'Kilifi', location: 'Malindi, Kilifi', is_organic: true, description: 'Mature husked coconuts for oil extraction or direct consumption.' },
    { farmer: 4, title: 'Cassava (Fresh)',          category: 'vegetables', quantity: 300, unit: 'kg', price: 35, county: 'Kilifi', location: 'Malindi, Kilifi', is_organic: true, description: 'Sweet cassava variety, peeled or unpeeled available.' },
    { farmer: 4, title: 'Mango (Apple Variety)',    category: 'fruits',    quantity: 600, unit: 'kg', price: 55, county: 'Kilifi', location: 'Malindi, Kilifi', is_organic: true, description: 'Juicy apple mangoes in season.' },
  ];

  const listingIds = [];
  for (const l of listings) {
    const id = uuidv4();
    listingIds.push(id);
    await execute(`
      INSERT INTO listings (id,farmer_id,title,category,description,quantity,unit,price_per_unit,min_order_qty,county,location,is_organic,status,is_available)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',TRUE)
    `, [id, farmerIds[l.farmer], l.title, l.category, l.description, l.quantity, l.unit, l.price, Math.ceil(l.quantity * 0.05), l.county, l.location, l.is_organic]);
  }
  console.log(`\n  ✅ Created ${listings.length} listings\n`);

  // ── Sample Orders ────────────────────────────────────────────────────────────
  const kaleListingId = listingIds[0]; // Sukuma Wiki from Grace
  const davidId  = buyerIds[0];
  const mercyId  = buyerIds[1];
  const graceId  = farmerIds[0];

  // Order 1: Delivered with payment
  const order1Id   = uuidv4();
  const payment1Id = uuidv4();
  await withTransaction(async (client) => {
    await client.query(`
      INSERT INTO orders (id,buyer_id,farmer_id,status,subtotal,delivery_fee,total_amount,delivery_type,notes,confirmed_at,ready_at,delivered_at)
      VALUES ($1,$2,$3,'delivered',450,0,450,'pickup','Please pack fresh bundles',NOW()-INTERVAL '3 days',NOW()-INTERVAL '2 days',NOW()-INTERVAL '1 day')
    `, [order1Id, davidId, graceId]);
    await client.query(
      'INSERT INTO order_items (id,order_id,listing_id,title,quantity,unit,price_per_unit,line_total) VALUES ($1,$2,$3,$4,10,$5,45,450)',
      [uuidv4(), order1Id, kaleListingId, 'Fresh Sukuma Wiki (Kale)', 'kg']
    );
    await client.query(
      "INSERT INTO payments (id,order_id,payer_id,amount,phone,method,status,mpesa_receipt,paid_at) VALUES ($1,$2,$3,450,'0722001001','mpesa','completed','RGH8K2X3M1',NOW()-INTERVAL '2 days')",
      [payment1Id, order1Id, davidId]
    );
    await client.query('UPDATE buyer_profiles SET total_orders = total_orders + 1 WHERE user_id = $1', [davidId]);
    await client.query('UPDATE farmer_profiles SET total_sales = total_sales + 1 WHERE user_id = $1', [graceId]);
  });

  // Order 2: Confirmed
  const order2Id = uuidv4();
  await execute(
    "INSERT INTO orders (id,buyer_id,farmer_id,status,subtotal,delivery_fee,total_amount,delivery_type,confirmed_at) VALUES ($1,$2,$3,'confirmed',800,200,1000,'delivery',NOW()-INTERVAL '6 hours')",
    [order2Id, davidId, graceId]
  );
  await execute('INSERT INTO order_items (id,order_id,listing_id,title,quantity,unit,price_per_unit,line_total) VALUES ($1,$2,$3,$4,16,$5,50,800)',
    [uuidv4(), order2Id, kaleListingId, 'Fresh Sukuma Wiki (Kale)', 'kg']);

  // Order 3: Pending from Mercy
  const order3Id = uuidv4();
  await execute(
    "INSERT INTO orders (id,buyer_id,farmer_id,status,subtotal,delivery_fee,total_amount,delivery_type) VALUES ($1,$2,$3,'pending',2250,0,2250,'pickup')",
    [order3Id, mercyId, graceId]
  );
  await execute('INSERT INTO order_items (id,order_id,listing_id,title,quantity,unit,price_per_unit,line_total) VALUES ($1,$2,$3,$4,50,$5,45,2250)',
    [uuidv4(), order3Id, kaleListingId, 'Fresh Sukuma Wiki (Kale)', 'kg']);

  console.log('  ✅ Sample orders seeded');

  // ── Sample Reviews ────────────────────────────────────────────────────────────
  await execute(`
    INSERT INTO reviews (id,order_id,reviewer_id,reviewee_id,reviewer_role,rating,comment,rating_quality,rating_communication,rating_punctuality)
    VALUES ($1,$2,$3,$4,'buyer',5,'Excellent quality sukuma wiki! Grace packed it neatly and delivered on time. Highly recommend Wanjiku Farm.',5,5,5)
  `, [uuidv4(), order1Id, davidId, graceId]);

  await execute(`
    INSERT INTO reviews (id,order_id,reviewer_id,reviewee_id,reviewer_role,rating,comment,rating_communication,rating_punctuality)
    VALUES ($1,$2,$3,$4,'farmer',5,'David was very professional. Payment was instant via M-Pesa. Would gladly work with him again.',5,5)
  `, [uuidv4(), order1Id, graceId, davidId]);

  // Recalc ratings
  for (const [uid, role] of [[graceId,'farmer'],[davidId,'buyer']]) {
    const r = await queryOne('SELECT COUNT(*)::int AS total, AVG(rating) AS avg FROM reviews WHERE reviewee_id = $1 AND is_flagged = FALSE', [uid]);
    const avg = r.avg ? parseFloat(parseFloat(r.avg).toFixed(2)) : 0;
    if (role === 'farmer') await execute('UPDATE farmer_profiles SET rating=$1, total_reviews=$2 WHERE user_id=$3', [avg, r.total, uid]);
    else                   await execute('UPDATE buyer_profiles  SET rating=$1, total_reviews=$2 WHERE user_id=$3', [avg, r.total, uid]);
  }
  console.log('  ✅ Sample reviews seeded\n');

  console.log('════════════════════════════════════════════════════');
  console.log('✅ Seed complete! Test credentials:');
  console.log('   Farmer: grace@seed.farmad.ke / password123');
  console.log('   Buyer:  david@seed.farmad.ke / password123');
  console.log('════════════════════════════════════════════════════\n');

  process.exit(0);
}

seed().catch(err => { console.error('❌ Seed failed:', err.message); process.exit(1); });
