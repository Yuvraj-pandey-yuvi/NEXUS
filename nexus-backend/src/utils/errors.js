// Error Handling Utilities for Nexus Backend

class ApiError extends Error {
  constructor(statusCode, message, errors = null, isOperational = true, stack = '') {
    super(message);
    
    this.statusCode = statusCode;
    this.message = message;
    this.errors = errors;
    this.isOperational = isOperational;
    
    if (stack) {
      this.stack = stack;
    } else {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

class ValidationError extends ApiError {
  constructor(errors) {
    const message = 'Validation failed';
    super(400, message, errors);
  }
}

class AuthenticationError extends ApiError {
  constructor(message = 'Authentication failed') {
    super(401, message);
  }
}

class AuthorizationError extends ApiError {
  constructor(message = 'Insufficient permissions') {
    super(403, message);
  }
}

class NotFoundError extends ApiError {
  constructor(resource = 'Resource') {
    super(404, `${resource} not found`);
  }
}

class ConflictError extends ApiError {
  constructor(message = 'Resource already exists') {
    super(409, message);
  }
}

class BlockchainError extends ApiError {
  constructor(message = 'Blockchain operation failed', transactionHash = null) {
    super(500, message, { transactionHash });
  }
}

class Web3RequiredError extends ApiError {
  constructor(message = 'Web3 verification required for this action') {
    super(403, message);
  }
}

module.exports = {
  ApiError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  BlockchainError,
  Web3RequiredError
};