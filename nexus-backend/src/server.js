// Nexus Backend - Main Server File
// Hybrid Web2/Web3 Social Platform

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const passport = require('passport');
const { createServer } = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');

// Database and middleware imports
const { PrismaClient } = require('@prisma/client');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');
const authMiddleware = require('./middleware/auth');

// Route imports
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const postRoutes = require('./routes/posts');
const communityRoutes = require('./routes/communities');
const marketplaceRoutes = require('./routes/marketplace');
const moderationRoutes = require('./routes/moderation');
const blockchainRoutes = require('./routes/blockchain');
const notificationRoutes = require('./routes/notifications');

// Services
const { initializePassport } = require('./config/passport');
const { initializeRedis } = require('./config/redis');
const { startCronJobs } = require('./services/cronService');
const { initializeSocket } = require('./services/socketService');

// Initialize Express app
const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Initialize Prisma Client
const prisma = new PrismaClient({
  log: ['query', 'error', 'warn'],
});

// Global middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Wallet-Address']
}));

app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', limiter);

// Initialize Passport
initializePassport(passport);
app.use(passport.initialize());

// Make Prisma and Socket.io available to routes
app.use((req, res, next) => {
  req.prisma = prisma;
  req.io = io;
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', authMiddleware.authenticate, userRoutes);
app.use('/api/posts', authMiddleware.authenticate, postRoutes);
app.use('/api/communities', authMiddleware.authenticate, communityRoutes);
app.use('/api/marketplace', authMiddleware.authenticate, marketplaceRoutes);
app.use('/api/moderation', authMiddleware.authenticate, moderationRoutes);
app.use('/api/blockchain', authMiddleware.authenticate, blockchainRoutes);
app.use('/api/notifications', authMiddleware.authenticate, notificationRoutes);

// API Documentation endpoint
app.get('/api', (req, res) => {
  res.json({
    name: 'Nexus API',
    version: '1.0.0',
    description: 'Hybrid Web2/Web3 Social Platform API',
    endpoints: {
      auth: '/api/auth',
      users: '/api/users',
      posts: '/api/posts',
      communities: '/api/communities',
      marketplace: '/api/marketplace',
      moderation: '/api/moderation',
      blockchain: '/api/blockchain',
      notifications: '/api/notifications'
    },
    features: [
      'Dual Authentication (Google OAuth + MetaMask)',
      'Hybrid Content Management',
      'Community DAOs with On-chain Governance',
      'NFT Marketplace Integration',
      'Decentralized Moderation System',
      'Real-time Notifications'
    ]
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Route not found',
    message: 'The requested endpoint does not exist',
    availableRoutes: [
      'GET /api',
      'GET /health',
      'POST /api/auth/google',
      'POST /api/auth/wallet',
      'GET /api/users/profile',
      'POST /api/posts',
      'GET /api/communities',
      'GET /api/marketplace/listings'
    ]
  });
});

// Global error handler
app.use(errorHandler);

// Initialize services
async function initializeServices() {
  try {
    // Initialize Redis
    await initializeRedis();
    logger.info('Redis initialized successfully');
    
    // Initialize Socket.IO
    initializeSocket(io, prisma);
    logger.info('Socket.IO initialized successfully');
    
    // Start cron jobs
    startCronJobs(prisma);
    logger.info('Cron jobs started successfully');
    
    logger.info('All services initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize services:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  
  server.close(() => {
    logger.info('HTTP server closed');
    
    prisma.$disconnect().then(() => {
      logger.info('Database connection closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  
  server.close(() => {
    logger.info('HTTP server closed');
    
    prisma.$disconnect().then(() => {
      logger.info('Database connection closed');
      process.exit(0);
    });
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

// Start server
const PORT = process.env.PORT || 5000;

server.listen(PORT, async () => {
  logger.info(`🚀 Nexus Backend Server running on port ${PORT}`);
  logger.info(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
  logger.info(`💾 Database: ${process.env.DATABASE_URL ? 'Connected' : 'Not configured'}`);
  
  // Initialize services after server starts
  await initializeServices();
  
  logger.info('🎯 Nexus Backend fully initialized and ready!');
  logger.info('📚 API Documentation available at: http://localhost:' + PORT + '/api');
});

module.exports = { app, server, prisma };