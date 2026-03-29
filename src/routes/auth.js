// src/routes/auth.js — FarmAd Auth API (PostgreSQL)
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, execute, withTransaction } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { validateRegister, validateLogin, validateChangePassword } = require('../middleware/validate');

const router = express.Router();

function normalisePhone(phone) {
  const c = phone.replace(/\s/g, '');
  if (c.startsWith('+254')) return '0' + c.slice(4);
  if (c.startsWith('254'))  return '0' + c.slice(3);
  return c;
}

function generateTokens(user) {
  const payload = { id: user.id, email: user.email, role: user.role, name: user.name };
  const accessToken  = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
  const refreshToken = uuidv4();
  return { accessToken, refreshToken };
}

function safeUser(user) {
  const { password, ...safe } = user;
  return safe;
}

async function storeRefreshToken(userId, token) {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await execute(
    'INSERT INTO refresh_tokens (id, user_id, token, expires_at) VALUES ($1, $2, $3, $4)',
    [uuidv4(), userId, token, expiresAt]
  );
}

async function getProfile(user) {
  if (user.role === 'farmer') {
    return queryOne('SELECT * FROM farmer_profiles WHERE user_id = $1', [user.id]);
  }
  return queryOne('SELECT * FROM buyer_profiles WHERE user_id = $1', [user.id]);
}

// POST /api/auth/register
router.post('/register', validateRegister, async (req, res) => {
  const {
    name, email, password, role, county,
    farm_name, farm_location, farm_size_ha, produce_types,
    buyer_type, business_name
  } = req.body;
  const phone = normalisePhone(req.body.phone);

  try {
    if (await queryOne('SELECT id FROM users WHERE email = $1', [email.toLowerCase()])) {
      return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
    }
    if (await queryOne('SELECT id FROM users WHERE phone = $1', [phone])) {
      return res.status(409).json({ success: false, message: 'An account with this phone number already exists.' });
    }

    const hashedPassword = bcrypt.hashSync(password, 12);
    const userId = uuidv4();

    await withTransaction(async (client) => {
      await client.query(
        'INSERT INTO users (id, name, email, phone, password, role, county) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [userId, name.trim(), email.toLowerCase(), phone, hashedPassword, role, county]
      );

      if (role === 'farmer') {
        await client.query(
          'INSERT INTO farmer_profiles (user_id, farm_name, farm_location, county, farm_size_ha, produce_types) VALUES ($1,$2,$3,$4,$5,$6)',
          [userId, farm_name.trim(), farm_location.trim(), county, farm_size_ha ? parseFloat(farm_size_ha) : null, produce_types || null]
        );
      } else {
        await client.query(
          'INSERT INTO buyer_profiles (user_id, buyer_type, business_name) VALUES ($1,$2,$3)',
          [userId, buyer_type, business_name ? business_name.trim() : null]
        );
      }
    });

    const user    = await queryOne('SELECT * FROM users WHERE id = $1', [userId]);
    const profile = await getProfile(user);
    const { accessToken, refreshToken } = generateTokens(user);
    await storeRefreshToken(userId, refreshToken);

    return res.status(201).json({
      success: true,
      message: `Welcome to FarmAd, ${name.trim()}!`,
      data: {
        access_token:  accessToken,
        refresh_token: refreshToken,
        user: { ...safeUser(user), profile }
      }
    });
  } catch (err) {
    console.error('POST /auth/register error:', err);
    return res.status(500).json({ success: false, message: 'Server error during registration.' });
  }
});

// POST /api/auth/login
router.post('/login', validateLogin, async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await queryOne('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const profile = await getProfile(user);
    const { accessToken, refreshToken } = generateTokens(user);
    await storeRefreshToken(user.id, refreshToken);

    return res.status(200).json({
      success: true,
      message: `Welcome back, ${user.name}!`,
      data: {
        access_token:  accessToken,
        refresh_token: refreshToken,
        user: { ...safeUser(user), profile }
      }
    });
  } catch (err) {
    console.error('POST /auth/login error:', err);
    return res.status(500).json({ success: false, message: 'Server error during login.' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) {
    return res.status(400).json({ success: false, message: 'refresh_token is required.' });
  }

  try {
    const stored = await queryOne(
      `SELECT rt.*, u.id as uid, u.email, u.role, u.name
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
       WHERE rt.token = $1 AND rt.expires_at > NOW()`,
      [refresh_token]
    );

    if (!stored) {
      await execute('DELETE FROM refresh_tokens WHERE token = $1', [refresh_token]);
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token.' });
    }

    const user = await queryOne('SELECT * FROM users WHERE id = $1', [stored.user_id]);
    const { accessToken, refreshToken: newRefresh } = generateTokens(user);

    await execute('DELETE FROM refresh_tokens WHERE token = $1', [refresh_token]);
    await storeRefreshToken(user.id, newRefresh);

    return res.status(200).json({
      success: true,
      data: { access_token: accessToken, refresh_token: newRefresh }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/auth/logout
router.post('/logout', authenticate, async (req, res) => {
  const { refresh_token } = req.body;
  try {
    if (refresh_token) {
      await execute('DELETE FROM refresh_tokens WHERE token = $1 AND user_id = $2', [refresh_token, req.user.id]);
    } else {
      await execute('DELETE FROM refresh_tokens WHERE user_id = $1', [req.user.id]);
    }
    return res.status(200).json({ success: true, message: 'Logged out successfully.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    const profile = await getProfile(user);
    return res.status(200).json({ success: true, data: { user: { ...safeUser(user), profile } } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// PATCH /api/auth/me
router.patch('/me', authenticate, async (req, res) => {
  const allowed = ['name', 'bio', 'avatar_url', 'county'];
  const farmerAllowed = ['farm_name', 'farm_location', 'farm_size_ha', 'produce_types'];

  try {
    const updates = [];
    const values  = [];
    let   idx     = 1;

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(`${key} = $${idx++}`);
        values.push(req.body[key]);
      }
    }

    if (updates.length > 0) {
      updates.push(`updated_at = NOW()`);
      values.push(req.user.id);
      await execute(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, values);
    }

    // Farmer-specific profile updates
    if (req.user.role === 'farmer') {
      const fp  = [];
      const fv  = [];
      let   fi  = 1;
      for (const key of farmerAllowed) {
        if (req.body[key] !== undefined) {
          fp.push(`${key} = $${fi++}`);
          fv.push(req.body[key]);
        }
      }
      if (fp.length > 0) {
        fv.push(req.user.id);
        await execute(`UPDATE farmer_profiles SET ${fp.join(', ')} WHERE user_id = $${fi}`, fv);
      }
    }

    const user    = await queryOne('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const profile = await getProfile(user);
    return res.status(200).json({ success: true, data: { user: { ...safeUser(user), profile } } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, validateChangePassword, async (req, res) => {
  const { current_password, new_password } = req.body;
  try {
    const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!bcrypt.compareSync(current_password, user.password)) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }

    await execute(
      'UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2',
      [bcrypt.hashSync(new_password, 12), user.id]
    );
    await execute('DELETE FROM refresh_tokens WHERE user_id = $1', [user.id]);

    return res.status(200).json({ success: true, message: 'Password changed. Please log in again.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
