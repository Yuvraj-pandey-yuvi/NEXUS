// Web3 Authentication Middleware for Nexus Backend
// Ensures users have Web3 capabilities for blockchain operations

const { Web3RequiredError } = require('../utils/errors');
const logger = require('../utils/logger');

/**
 * Middleware to check if user has Web3 access
 * Required for on-chain operations like anchoring and minting
 */
const checkWeb3Access = (req, res, next) => {
  try {
    if (!req.user) {
      return next(new Web3RequiredError('Authentication required'));
    }
    
    // Check if user has a verified wallet address
    if (!req.user.walletAddress || !req.user.isWeb3Verified) {
      logger.logUserAction(req.user.id, 'WEB3_ACCESS_DENIED', {
        reason: 'No verified wallet address',
        endpoint: req.path
      });
      return next(new Web3RequiredError(
        'Web3 wallet verification required for blockchain operations. Please connect your wallet.'
      ));
    }
    
    // Check if current session has wallet verification
    const walletHeader = req.get('X-Wallet-Address');
    if (!walletHeader || walletHeader.toLowerCase() !== req.user.walletAddress.toLowerCase()) {
      logger.logUserAction(req.user.id, 'WEB3_SESSION_MISMATCH', {
        expectedWallet: req.user.walletAddress,
        providedWallet: walletHeader,
        endpoint: req.path
      });
      return next(new Web3RequiredError(
        'Active wallet connection required. Please ensure your wallet is connected and matches your account.'
      ));
    }
    
    // Mark this as a Web3 session
    req.user.isWeb3Session = true;
    
    logger.logUserAction(req.user.id, 'WEB3_ACCESS_GRANTED', {
      walletAddress: req.user.walletAddress,
      endpoint: req.path
    });
    
    next();
    
  } catch (error) {
    logger.logError(error, req);
    next(new Web3RequiredError('Web3 verification failed'));
  }
};

/**
 * Middleware to check if user has sufficient gas/funds for transaction
 * Optional check that can warn users about potential transaction failures
 */
const checkGasRequirement = async (req, res, next) => {
  try {
    // This is a placeholder for gas estimation
    // In a production environment, you would:
    // 1. Estimate gas cost for the operation
    // 2. Check user's wallet balance
    // 3. Warn if insufficient funds
    
    const { ethers } = require('ethers');
    
    if (!req.user?.walletAddress) {
      return next();
    }
    
    // For demonstration, we'll just log the check
    logger.logUserAction(req.user.id, 'GAS_CHECK', {
      walletAddress: req.user.walletAddress,
      endpoint: req.path,
      operation: 'blockchain_transaction'
    });
    
    // Add gas estimation to response headers for frontend use
    res.set('X-Estimated-Gas', '0.001'); // ETH
    res.set('X-Gas-Warning', 'Ensure sufficient MATIC in wallet for transaction');
    
    next();
    
  } catch (error) {
    logger.logError(error, req);
    // Don't fail the request for gas estimation errors
    next();
  }
};

/**
 * Middleware to verify blockchain network
 * Ensures user is on the correct network for operations
 */
const checkNetwork = (expectedChainId = 80001) => { // Polygon Mumbai testnet
  return (req, res, next) => {
    try {
      const chainIdHeader = req.get('X-Chain-ID');
      
      if (chainIdHeader && parseInt(chainIdHeader) !== expectedChainId) {
        logger.logUserAction(req.user?.id || 'anonymous', 'WRONG_NETWORK', {
          expectedChainId,
          providedChainId: chainIdHeader,
          endpoint: req.path
        });
        
        return next(new Web3RequiredError(
          `Wrong network. Please switch to the correct blockchain network (Chain ID: ${expectedChainId}).`
        ));
      }
      
      // Add network info to response for frontend
      res.set('X-Expected-Chain-ID', expectedChainId.toString());
      res.set('X-Network-Name', 'Polygon Mumbai Testnet');
      
      next();
      
    } catch (error) {
      logger.logError(error, req);
      next();
    }
  };
};

/**
 * Middleware to rate limit blockchain operations
 * Prevents spam of expensive on-chain operations
 */
const rateLimitBlockchainOps = (maxOpsPerHour = 10) => {
  const userOps = new Map();
  
  return (req, res, next) => {
    if (!req.user?.walletAddress) {
      return next();
    }
    
    const walletAddress = req.user.walletAddress.toLowerCase();
    const now = Date.now();
    const hourMs = 60 * 60 * 1000;
    
    if (!userOps.has(walletAddress)) {
      userOps.set(walletAddress, []);
    }
    
    const operations = userOps.get(walletAddress);
    
    // Remove operations older than 1 hour
    const recentOps = operations.filter(opTime => now - opTime < hourMs);
    userOps.set(walletAddress, recentOps);
    
    if (recentOps.length >= maxOpsPerHour) {
      logger.logSecurityEvent('BLOCKCHAIN_RATE_LIMIT_EXCEEDED', {
        walletAddress,
        operationCount: recentOps.length,
        maxOpsPerHour,
        userId: req.user.id
      });
      
      return next(new Web3RequiredError(
        `Blockchain operation limit exceeded. Maximum ${maxOpsPerHour} operations per hour.`
      ));
    }
    
    recentOps.push(now);
    userOps.set(walletAddress, recentOps);
    
    // Add rate limit info to response
    res.set('X-Blockchain-Ops-Remaining', (maxOpsPerHour - recentOps.length).toString());
    res.set('X-Blockchain-Ops-Reset', new Date(now + hourMs).toISOString());
    
    next();
  };
};

/**
 * Middleware to validate wallet signature for sensitive operations
 * Requires fresh signature verification for high-value actions
 */
const requireFreshSignature = async (req, res, next) => {
  try {
    const { signature, message, timestamp } = req.body;
    
    if (!signature || !message || !timestamp) {
      return next(new Web3RequiredError(
        'Fresh wallet signature required for this operation. Please sign the transaction.'
      ));
    }
    
    // Check if signature is recent (within 5 minutes)
    const signatureAge = Date.now() - parseInt(timestamp);
    const maxAge = 5 * 60 * 1000; // 5 minutes
    
    if (signatureAge > maxAge) {
      return next(new Web3RequiredError(
        'Signature expired. Please sign a fresh message.'
      ));
    }
    
    // Verify signature matches wallet
    const { verifyWalletSignature } = require('../config/passport');
    
    if (!verifyWalletSignature(req.user.walletAddress, signature, message)) {
      logger.logSecurityEvent('INVALID_WALLET_SIGNATURE', {
        userId: req.user.id,
        walletAddress: req.user.walletAddress,
        endpoint: req.path
      });
      return next(new Web3RequiredError(
        'Invalid wallet signature. Please try again.'
      ));
    }
    
    logger.logUserAction(req.user.id, 'FRESH_SIGNATURE_VERIFIED', {
      walletAddress: req.user.walletAddress,
      endpoint: req.path
    });
    
    next();
    
  } catch (error) {
    logger.logError(error, req);
    next(new Web3RequiredError('Signature verification failed'));
  }
};

module.exports = {
  checkWeb3Access,
  checkGasRequirement,
  checkNetwork,
  rateLimitBlockchainOps,
  requireFreshSignature
};