// Error Handling Middleware for Nexus Backend

const logger = require('../utils/logger');
const { ApiError } = require('../utils/errors');

/**
 * Global error handler middleware
 * Handles all errors in the application with proper logging and response formatting
 */
const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;

  // Log error with request context
  logger.logError(err, req);

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    const message = 'Resource not found';
    error = new ApiError(404, message);
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const message = 'Duplicate field value entered';
    error = new ApiError(400, message);
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const message = Object.values(err.errors).map(val => val.message);
    error = new ApiError(400, 'Validation Error', message);
  }

  // Prisma errors
  if (err.code === 'P2002') {
    const message = 'Unique constraint violation';
    error = new ApiError(409, message);
  }

  if (err.code === 'P2025') {
    const message = 'Record not found';
    error = new ApiError(404, message);
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    const message = 'Invalid token';
    error = new ApiError(401, message);
  }

  if (err.name === 'TokenExpiredError') {
    const message = 'Token expired';
    error = new ApiError(401, message);
  }

  // Multer errors (file upload)
  if (err.code === 'LIMIT_FILE_SIZE') {
    const message = 'File too large';
    error = new ApiError(413, message);
  }

  if (err.code === 'LIMIT_FILE_COUNT') {
    const message = 'Too many files';
    error = new ApiError(413, message);
  }

  // Ethereum/Web3 errors
  if (err.message && err.message.includes('insufficient funds')) {
    const message = 'Insufficient funds for blockchain transaction';
    error = new ApiError(402, message);
  }

  if (err.message && err.message.includes('nonce too low')) {
    const message = 'Transaction nonce error. Please try again';
    error = new ApiError(409, message);
  }

  if (err.message && err.message.includes('gas required exceeds allowance')) {
    const message = 'Transaction requires too much gas';
    error = new ApiError(413, message);
  }

  // Rate limiting errors
  if (err.status === 429) {
    const message = err.message || 'Too many requests';
    error = new ApiError(429, message);
  }

  // Default to 500 server error
  const statusCode = error.statusCode || 500;
  const message = error.message || 'Internal Server Error';

  // Prepare error response
  const errorResponse = {
    success: false,
    error: {
      message,
      ...(error.errors && { details: error.errors }),
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
      ...(req.requestId && { requestId: req.requestId })
    }
  };

  // Add helpful information for common errors
  if (statusCode === 401) {
    errorResponse.error.hint = 'Please check your authentication token';
  }

  if (statusCode === 403) {
    if (message.includes('Web3')) {
      errorResponse.error.hint = 'Connect your Web3 wallet to perform blockchain operations';
      errorResponse.error.requiresWeb3 = true;
    } else {
      errorResponse.error.hint = 'You do not have permission to perform this action';
    }
  }

  if (statusCode === 404) {
    errorResponse.error.hint = 'The requested resource was not found';
  }

  if (statusCode === 409) {
    errorResponse.error.hint = 'This resource already exists or there is a conflict';
  }

  if (statusCode === 413) {
    errorResponse.error.hint = 'Request payload is too large';
  }

  if (statusCode === 422) {
    errorResponse.error.hint = 'The request data is invalid';
  }

  if (statusCode === 429) {
    errorResponse.error.hint = 'You are making requests too quickly';
    errorResponse.error.retryAfter = '15 minutes';
  }

  if (statusCode >= 500) {
    errorResponse.error.hint = 'An internal server error occurred. Please try again later.';
    
    // Hide sensitive error details in production
    if (process.env.NODE_ENV === 'production') {
      errorResponse.error.message = 'Internal Server Error';
      delete errorResponse.error.stack;
    }
  }

  // Log security events for certain error types
  if (statusCode === 401 || statusCode === 403) {
    logger.logSecurityEvent('ACCESS_DENIED', {
      userId: req.user?.id,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      endpoint: req.path,
      method: req.method,
      statusCode
    });
  }

  // Set security headers
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block'
  });

  res.status(statusCode).json(errorResponse);
};

/**
 * Middleware to handle 404 errors for undefined routes
 */
const notFound = (req, res, next) => {
  const error = new ApiError(404, `Route ${req.originalUrl} not found`);
  next(error);
};

/**
 * Async error handler wrapper
 * Wraps async route handlers to catch errors automatically
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Validation error formatter
 * Formats express-validator errors into a consistent format
 */
const formatValidationErrors = (errors) => {
  return errors.map(error => ({
    field: error.param,
    message: error.msg,
    value: error.value,
    location: error.location
  }));
};

module.exports = {
  errorHandler,
  notFound,
  asyncHandler,
  formatValidationErrors
};