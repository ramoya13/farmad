// src/middleware/validate.js
// Simple manual validators (no external library needed)

const KENYAN_COUNTIES = [
  'Baringo','Bomet','Bungoma','Busia','Elgeyo-Marakwet','Embu','Garissa',
  'Homa Bay','Isiolo','Kajiado','Kakamega','Kericho','Kiambu','Kilifi',
  'Kirinyaga','Kisii','Kisumu','Kitui','Kwale','Laikipia','Lamu','Machakos',
  'Makueni','Mandera','Marsabit','Meru','Migori','Mombasa','Murang\'a',
  'Nairobi','Nakuru','Nandi','Narok','Nyamira','Nyandarua','Nyeri',
  'Samburu','Siaya','Taita-Taveta','Tana River','Tharaka-Nithi','Trans Nzoia',
  'Turkana','Uasin Gishu','Vihiga','Wajir','West Pokot'
];

function validateRegister(req, res, next) {
  const errors = [];
  const { name, email, phone, password, role, county } = req.body;

  if (!name || name.trim().length < 2)
    errors.push('Name must be at least 2 characters.');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    errors.push('Valid email is required.');

  // Accept Kenyan formats: 07XXXXXXXX, 01XXXXXXXX, +2547XXXXXXXX
  if (!phone || !/^(\+?254|0)[17]\d{8}$/.test(phone.replace(/\s/g, '')))
    errors.push('Valid Kenyan phone number is required (e.g. 0712345678).');

  if (!password || password.length < 8)
    errors.push('Password must be at least 8 characters.');

  if (!['farmer', 'buyer'].includes(role))
    errors.push('Role must be either "farmer" or "buyer".');

  if (!county || !KENYAN_COUNTIES.includes(county))
    errors.push(`County must be one of Kenya's 47 counties.`);

  // Extra fields for farmers
  if (role === 'farmer') {
    if (!req.body.farm_name || req.body.farm_name.trim().length < 2)
      errors.push('Farm name is required for farmers.');
    if (!req.body.farm_location || req.body.farm_location.trim().length < 2)
      errors.push('Farm location/village is required.');
  }

  // Extra fields for buyers
  if (role === 'buyer') {
    const validBuyerTypes = ['individual','restaurant','supermarket','exporter','institution'];
    if (!req.body.buyer_type || !validBuyerTypes.includes(req.body.buyer_type))
      errors.push(`Buyer type must be one of: ${validBuyerTypes.join(', ')}.`);
  }

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: 'Validation failed.', errors });
  }

  next();
}

function validateLogin(req, res, next) {
  const errors = [];
  const { email, password } = req.body;

  if (!email) errors.push('Email is required.');
  if (!password) errors.push('Password is required.');

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: 'Validation failed.', errors });
  }
  next();
}

function validateChangePassword(req, res, next) {
  const errors = [];
  const { current_password, new_password } = req.body;

  if (!current_password) errors.push('Current password is required.');
  if (!new_password || new_password.length < 8)
    errors.push('New password must be at least 8 characters.');
  if (current_password === new_password)
    errors.push('New password must be different from current password.');

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: 'Validation failed.', errors });
  }
  next();
}

module.exports = { validateRegister, validateLogin, validateChangePassword, KENYAN_COUNTIES };
