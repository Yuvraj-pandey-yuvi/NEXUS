// Passport Configuration for Nexus Dual Authentication System
// Supports both Google OAuth (Web2) and MetaMask (Web3) authentication

const GoogleStrategy = require('passport-google-oauth20').Strategy;
const JwtStrategy = require('passport-jwt').Strategy;
const ExtractJwt = require('passport-jwt').ExtractJwt;
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

const initializePassport = (passport) => {
  
  // ============= GOOGLE OAUTH STRATEGY =============
  // For Web2 users who want seamless social media experience
  
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/api/auth/google/callback'
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      logger.info('Google OAuth authentication attempt:', { 
        googleId: profile.id, 
        email: profile.emails[0]?.value 
      });

      // Check if user already exists with this Google ID
      let user = await prisma.user.findUnique({
        where: { googleId: profile.id }
      });

      if (user) {
        // Update last login
        user = await prisma.user.update({
          where: { id: user.id },
          data: { lastLogin: new Date() }
        });
        
        logger.info('Existing Google user logged in:', { userId: user.id });
        return done(null, user);
      }

      // Check if user exists with same email
      const existingUser = await prisma.user.findUnique({
        where: { email: profile.emails[0]?.value }
      });

      if (existingUser) {
        // Link Google account to existing user
        user = await prisma.user.update({
          where: { id: existingUser.id },
          data: { 
            googleId: profile.id,
            lastLogin: new Date(),
            emailVerified: true
          }
        });
        
        logger.info('Linked Google account to existing user:', { userId: user.id });
        return done(null, user);
      }

      // Create new user with Google OAuth
      const username = await generateUniqueUsername(
        profile.displayName || profile.emails[0]?.value.split('@')[0]
      );

      user = await prisma.user.create({
        data: {
          googleId: profile.id,
          email: profile.emails[0]?.value,
          username: username,
          displayName: profile.displayName || profile.name?.givenName || username,
          profileImage: profile.photos[0]?.value,
          emailVerified: true,
          lastLogin: new Date()
        }
      });

      logger.info('New Google user created:', { userId: user.id, email: user.email });
      return done(null, user);
      
    } catch (error) {
      logger.error('Google OAuth error:', error);
      return done(error, null);
    }
  }));

  // ============= JWT STRATEGY =============
  // For authenticated API requests from both Web2 and Web3 users
  
  passport.use(new JwtStrategy({
    jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
    secretOrKey: process.env.JWT_SECRET,
    passReqToCallback: true
  },
  async (req, jwtPayload, done) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: jwtPayload.userId },
        include: {
          communities: {
            include: {
              community: true,
              roles: {
                include: {
                  role: true
                }
              }
            }
          }
        }
      });

      if (user && user.isActive) {
        // Add wallet verification status to user object
        const walletAddress = req.get('X-Wallet-Address');
        if (walletAddress && user.walletAddress === walletAddress.toLowerCase()) {
          user.isWeb3Session = true;
        } else {
          user.isWeb3Session = false;
        }
        
        return done(null, user);
      }

      return done(null, false);
      
    } catch (error) {
      logger.error('JWT authentication error:', error);
      return done(error, false);
    }
  }));

  // ============= PASSPORT SERIALIZATION =============
  // Note: Not used in API-only setup, but required for Passport
  
  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id, done) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id }
      });
      done(null, user);
    } catch (error) {
      done(error, null);
    }
  });
};

// ============= HELPER FUNCTIONS =============

async function generateUniqueUsername(baseUsername) {
  const sanitizedBase = baseUsername
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .substring(0, 20);
  
  let username = sanitizedBase;
  let counter = 1;

  while (await prisma.user.findUnique({ where: { username } })) {
    username = `${sanitizedBase}_${counter}`;
    counter++;
  }

  return username;
}

// ============= WEB3 AUTHENTICATION HELPERS =============

/**
 * Verify MetaMask signature for wallet-based authentication
 */
const verifyWalletSignature = (walletAddress, signature, nonce) => {
  const { ethers } = require('ethers');
  
  try {
    const message = `Welcome to Nexus!\n\nSign this message to authenticate with your wallet.\n\nNonce: ${nonce}`;
    const recoveredAddress = ethers.utils.verifyMessage(message, signature);
    
    return recoveredAddress.toLowerCase() === walletAddress.toLowerCase();
  } catch (error) {
    logger.error('Wallet signature verification failed:', error);
    return false;
  }
};

/**
 * Create or update user with wallet address
 */
const handleWalletAuthentication = async (walletAddress, signature, nonce) => {
  try {
    // Verify signature
    if (!verifyWalletSignature(walletAddress, signature, nonce)) {
      throw new Error('Invalid wallet signature');
    }

    const normalizedAddress = walletAddress.toLowerCase();

    // Check if user exists with this wallet
    let user = await prisma.user.findUnique({
      where: { walletAddress: normalizedAddress }
    });

    if (user) {
      // Update existing user
      user = await prisma.user.update({
        where: { id: user.id },
        data: { 
          lastLogin: new Date(),
          isWeb3Verified: true
        }
      });
      
      logger.info('Existing wallet user logged in:', { userId: user.id, walletAddress });
      return user;
    }

    // Create new user with wallet
    const username = await generateUniqueUsername(`user_${normalizedAddress.substring(2, 8)}`);

    user = await prisma.user.create({
      data: {
        username: username,
        displayName: `User ${normalizedAddress.substring(2, 8)}`,
        walletAddress: normalizedAddress,
        isWeb3Verified: true,
        lastLogin: new Date()
      }
    });

    logger.info('New wallet user created:', { userId: user.id, walletAddress });
    return user;
    
  } catch (error) {
    logger.error('Wallet authentication error:', error);
    throw error;
  }
};

module.exports = {
  initializePassport,
  verifyWalletSignature,
  handleWalletAuthentication
};