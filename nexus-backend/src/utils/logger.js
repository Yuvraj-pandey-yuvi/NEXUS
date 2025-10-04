// Winston Logger Configuration for Nexus Backend

const winston = require('winston');
const path = require('path');

// Define log levels and colors
const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

const logColors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'blue',
};

winston.addColors(logColors);

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(info => {
    const { timestamp, level, message, ...meta } = info;
    
    // Handle different message types
    let logMessage = message;
    if (typeof message === 'object') {
      logMessage = JSON.stringify(message, null, 2);
    }
    
    // Include metadata if present
    const metaData = Object.keys(meta).length > 0 ? JSON.stringify(meta, null, 2) : '';
    
    return `[${timestamp}] ${level.toUpperCase()}: ${logMessage} ${metaData}`;
  })
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(info => {
    const { timestamp, level, message, ...meta } = info;
    
    let logMessage = message;
    if (typeof message === 'object') {
      logMessage = JSON.stringify(message, null, 2);
    }
    
    const metaData = Object.keys(meta).length > 0 ? JSON.stringify(meta, null, 2) : '';
    
    return `[${timestamp}] ${level}: ${logMessage} ${metaData}`;
  })
);

// Create transports array
const transports = [];

// Console transport for development
if (process.env.NODE_ENV !== 'production') {
  transports.push(
    new winston.transports.Console({
      level: 'debug',
      format: consoleFormat,
    })
  );
}

// File transports for production and development
transports.push(
  // All logs
  new winston.transports.File({
    filename: path.join(__dirname, '../../logs/app.log'),
    level: 'info',
    format: logFormat,
    maxsize: 5242880, // 5MB
    maxFiles: 10,
  }),
  
  // Error logs only
  new winston.transports.File({
    filename: path.join(__dirname, '../../logs/error.log'),
    level: 'error',
    format: logFormat,
    maxsize: 5242880, // 5MB
    maxFiles: 5,
  })
);

// Create the logger instance
const logger = winston.createLogger({
  levels: logLevels,
  format: logFormat,
  transports,
  exitOnError: false,
});

// Add request ID tracking for HTTP requests
logger.addRequestId = (req, res, next) => {
  const requestId = require('uuid').v4();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  
  logger.defaultMeta = { requestId };
  next();
};

// Helper methods for structured logging
logger.logRequest = (req, res) => {
  const { method, url, ip, headers } = req;
  const userAgent = headers['user-agent'];
  const contentLength = headers['content-length'];
  
  logger.http('HTTP Request', {
    method,
    url,
    ip,
    userAgent,
    contentLength,
    requestId: req.requestId
  });
};

logger.logResponse = (req, res, responseTime) => {
  const { method, url } = req;
  const { statusCode } = res;
  
  logger.http('HTTP Response', {
    method,
    url,
    statusCode,
    responseTime: `${responseTime}ms`,
    requestId: req.requestId
  });
};

logger.logError = (error, req = null) => {
  const errorLog = {
    name: error.name,
    message: error.message,
    stack: error.stack,
    statusCode: error.statusCode,
  };
  
  if (req) {
    errorLog.requestId = req.requestId;
    errorLog.method = req.method;
    errorLog.url = req.url;
    errorLog.userId = req.user?.id;
  }
  
  logger.error('Application Error', errorLog);
};

logger.logBlockchainTransaction = (action, data) => {
  logger.info('Blockchain Transaction', {
    action,
    transactionHash: data.transactionHash,
    blockNumber: data.blockNumber,
    gasUsed: data.gasUsed,
    from: data.from,
    to: data.to,
    value: data.value
  });
};

logger.logUserAction = (userId, action, details = {}) => {
  logger.info('User Action', {
    userId,
    action,
    ...details,
    timestamp: new Date().toISOString()
  });
};

logger.logSecurityEvent = (event, details = {}) => {
  logger.warn('Security Event', {
    event,
    ...details,
    timestamp: new Date().toISOString()
  });
};

// Create logs directory if it doesn't exist
const fs = require('fs');
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

module.exports = logger;