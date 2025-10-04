// Authentication Routes - Nexus Dual Authentication System
// Handles both Google OAuth (Web2) and MetaMask (Web3) authentication

const express = require('express');
const passport = require('passport');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

const { handleWalletAuthentication } = require('../config/passport');
const logger = require('../utils/logger');
const { ApiError } = require('../utils/errors');

const router = express.Router();

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 requests per windowMs for auth
  message: { error: 'Too many authentication attempts, please try again later.' }
});

// Store nonces temporarily (in production, use Redis)
const nonceStore = new Map();

// Helper function to generate JWT tokens
const generateTokens = (user) => {
  const accessToken = jwt.sign(
    { 
      userId: user.id, 
      username: user.username,
      walletAddress: user.walletAddress,
      isWeb3Verified: user.isWeb3Verified
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
  );

  const refreshToken = jwt.sign(
    { userId: user.id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );

  return { accessToken, refreshToken };
};

// ============= GOOGLE OAUTH ROUTES =============

/**
 * @route   GET /api/auth/google
 * @desc    Redirect to Google OAuth
 * @access  Public
 */
router.get('/google', 
  passport.authenticate('google', {
    scope: ['profile', 'email']
  })
);

/**
 * @route   GET /api/auth/google/callback
 * @desc    Google OAuth callback
 * @access  Public
 */
router.get('/google/callback',
  passport.authenticate('google', { session: false }),
  (req, res) => {
    try {
      const { accessToken, refreshToken } = generateTokens(req.user);
      
      logger.info('Google OAuth successful:', { 
        userId: req.user.id,
        email: req.user.email 
      });

      // Redirect to frontend with tokens
      const frontendURL = process.env.FRONTEND_URL || 'http://localhost:3000';
      res.redirect(`${frontendURL}/auth/success?token=${accessToken}&refresh=${refreshToken}`);
      
    } catch (error) {
      logger.error('Google OAuth callback error:', error);
      const frontendURL = process.env.FRONTEND_URL || 'http://localhost:3000';
      res.redirect(`${frontendURL}/auth/error?message=Authentication failed`);
    }
  }
);

// ============= METAMASK/WALLET AUTHENTICATION =============

/**
 * @route   POST /api/auth/wallet/nonce
 * @desc    Generate nonce for wallet signature
 * @access  Public
 */
router.post('/wallet/nonce', 
  authLimiter,
  [
    body('walletAddress')
      .isEthereumAddress()
      .withMessage('Invalid wallet address')
      .normalizeEmail()
  ],
  (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw new ApiError(400, 'Validation failed', errors.array());
      }

      const { walletAddress } = req.body;
      const nonce = uuidv4();
      
      // Store nonce with expiration (5 minutes)
      nonceStore.set(walletAddress.toLowerCase(), {
        nonce,
        expires: Date.now() + 5 * 60 * 1000
      });
      
      // Clean up expired nonces
      setTimeout(() => {
        nonceStore.delete(walletAddress.toLowerCase());
      }, 5 * 60 * 1000);

      logger.info('Nonce generated for wallet:', { walletAddress });

      res.json({
        success: true,
        nonce,
        message: `Welcome to Nexus!\\n\\nSign this message to authenticate with your wallet.\\n\\nNonce: ${nonce}`,
        expiresIn: 5 * 60 * 1000 // 5 minutes
      });

    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/auth/wallet/verify
 * @desc    Verify wallet signature and authenticate
 * @access  Public
 */
router.post('/wallet/verify',
  authLimiter,
  [
    body('walletAddress')
      .isEthereumAddress()
      .withMessage('Invalid wallet address'),
    body('signature')
      .isLength({ min: 130, max: 132 })
      .withMessage('Invalid signature format'),
    body('nonce')
      .isUUID()
      .withMessage('Invalid nonce format')
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw new ApiError(400, 'Validation failed', errors.array());
      }

      const { walletAddress, signature, nonce } = req.body;
      const normalizedAddress = walletAddress.toLowerCase();

      // Verify nonce
      const storedNonce = nonceStore.get(normalizedAddress);
      if (!storedNonce || storedNonce.nonce !== nonce) {
        throw new ApiError(400, 'Invalid or expired nonce');
      }

      if (Date.now() > storedNonce.expires) {
        nonceStore.delete(normalizedAddress);
        throw new ApiError(400, 'Nonce has expired');
      }

      // Authenticate with wallet
      const user = await handleWalletAuthentication(walletAddress, signature, nonce);
      
      // Clean up nonce
      nonceStore.delete(normalizedAddress);

      // Generate tokens
      const { accessToken, refreshToken } = generateTokens(user);

      logger.info('Wallet authentication successful:', { 
        userId: user.id,
        walletAddress: user.walletAddress 
      });

      res.json({
        success: true,
        message: 'Wallet authenticated successfully',
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          walletAddress: user.walletAddress,
          profileImage: user.profileImage,
          isWeb3Verified: user.isWeb3Verified,
          reputation: user.reputation
        },
        tokens: {
          accessToken,
          refreshToken,
          expiresIn: process.env.JWT_EXPIRES_IN || '24h'
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

// ============= TOKEN MANAGEMENT =============

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh access token
 * @access  Public
 */
router.post('/refresh',
  [
    body('refreshToken')
      .isJWT()
      .withMessage('Invalid refresh token format')
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw new ApiError(400, 'Validation failed', errors.array());
      }

      const { refreshToken } = req.body;

      // Verify refresh token
      const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
      
      // Get user from database
      const user = await req.prisma.user.findUnique({
        where: { id: decoded.userId }
      });

      if (!user || !user.isActive) {
        throw new ApiError(401, 'Invalid refresh token');
      }

      // Generate new access token
      const newAccessToken = jwt.sign(
        { 
          userId: user.id, 
          username: user.username,
          walletAddress: user.walletAddress,
          isWeb3Verified: user.isWeb3Verified
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
      );

      logger.info('Token refreshed:', { userId: user.id });

      res.json({
        success: true,
        accessToken: newAccessToken,
        expiresIn: process.env.JWT_EXPIRES_IN || '24h'
      });

    } catch (error) {
      if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
        next(new ApiError(401, 'Invalid or expired refresh token'));
      } else {
        next(error);
      }
    }
  }
);

/**
 * @route   POST /api/auth/logout
 * @desc    Logout user (invalidate tokens)
 * @access  Private
 */
router.post('/logout', 
  passport.authenticate('jwt', { session: false }),
  (req, res) => {
    // In a production environment, you would:
    // 1. Add token to blacklist in Redis
    // 2. Clear any session data
    // 3. Log the logout event
    
    logger.info('User logged out:', { userId: req.user.id });

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  }
);

// ============= SESSION INFO =============

/**
 * @route   GET /api/auth/me
 * @desc    Get current user session info
 * @access  Private
 */
router.get('/me',
  passport.authenticate('jwt', { session: false }),
  async (req, res, next) => {
    try {
      // Get full user data with relationships
      const user = await req.prisma.user.findUnique({
        where: { id: req.user.id },
        include: {
          communities: {
            include: {
              community: {
                select: {
                  id: true,
                  name: true,
                  imageUrl: true,
                  type: true
                }
              }
            }
          },
          _count: {
            select: {
              posts: true,
              followers: true,
              follows: true
            }
          }
        }
      });

      if (!user) {
        throw new ApiError(404, 'User not found');
      }

      res.json({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          bio: user.bio,
          profileImage: user.profileImage,
          email: user.email,
          walletAddress: user.walletAddress,
          isWeb3Verified: user.isWeb3Verified,
          isWeb3Session: req.user.isWeb3Session,
          reputation: user.reputation,
          freeAnchorsUsed: user.freeAnchorsUsed,
          emailVerified: user.emailVerified,
          stats: {
            postsCount: user._count.posts,
            followersCount: user._count.followers,
            followingCount: user._count.follows
          },
          communities: user.communities.map(cm => ({
            id: cm.community.id,
            name: cm.community.name,
            imageUrl: cm.community.imageUrl,
            type: cm.community.type,
            joinedAt: cm.joinedAt
          }))
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;