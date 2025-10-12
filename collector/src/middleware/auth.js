const jwt = require('jsonwebtoken');
const config = require('../config');
const { AuthenticationError, AppError } = require('../utils/errors');

const authMiddleware = (req, res, next) => {
  if (!config.auth.required) {
    return next();
  }

  if (!config.jwtSecret) {
    return next(new AppError('Authentication is required but JWT secret is not configured', 500));
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) {
    return next(new AuthenticationError('Missing bearer token'));
  }

  try {
    const verifyOptions = {};
    if (config.auth.audience) {
      verifyOptions.audience = config.auth.audience;
    }
    if (config.auth.issuer) {
      verifyOptions.issuer = config.auth.issuer;
    }
    const payload = jwt.verify(token, config.jwtSecret, verifyOptions);
    req.user = payload;
    return next();
  } catch {
    return next(new AuthenticationError('Invalid token'));
  }
};

module.exports = authMiddleware;
