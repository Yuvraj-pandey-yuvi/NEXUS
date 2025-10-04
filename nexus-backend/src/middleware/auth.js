// Authentication Middleware for Nexus Backend

const passport = require('passport');
const { ApiError, AuthenticationError } = require('../utils/errors');
const logger = require('../utils/logger');

/**
 * Standard JWT authentication middleware
 * Works for both Web2 (Google) and Web3 (Wallet) authenticated users
 */
const authenticate = (req, res, next) => {
  passport.authenticate('jwt', { session: false }, (err, user, info) => {
    if (err) {
      logger.logError(err, req);
      return next(new ApiError(500, 'Authentication error'));
    }
    
    if (!user) {
      const message = info?.message || 'Invalid or expired token';
      logger.logSecurityEvent('AUTHENTICATION_FAILED', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        reason: message
      });
      return next(new AuthenticationError(message));
    }
    
    // Check if user account is active
    if (!user.isActive) {
      logger.logSecurityEvent('INACTIVE_USER_ACCESS_ATTEMPT', {
        userId: user.id,
        ip: req.ip
      });
      return next(new AuthenticationError('Account is deactivated'));
    }
    
    // Attach user to request
    req.user = user;
    
    logger.logUserAction(user.id, 'API_ACCESS', {
      endpoint: req.path,
      method: req.method,
      isWeb3Session: user.isWeb3Session
    });
    
    next();
  })(req, res, next);
};

/**
 * Optional authentication middleware
 * Attaches user if token is valid, but doesn't require authentication
 */
const optionalAuth = (req, res, next) => {
  const authHeader = req.get('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(); // No token provided, continue without user
  }
  
  passport.authenticate('jwt', { session: false }, (err, user, info) => {
    if (err) {
      logger.logError(err, req);
    }
    
    if (user && user.isActive) {
      req.user = user;
      logger.logUserAction(user.id, 'OPTIONAL_API_ACCESS', {
        endpoint: req.path,
        method: req.method
      });
    }
    
    next(); // Continue regardless of authentication result
  })(req, res, next);
};

/**
 * Role-based authorization middleware
 * Checks if user has required permissions within a community context
 */
const requirePermissions = (permissions) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return next(new AuthenticationError('Authentication required'));
      }
      
      const { communityId } = req.params;
      
      if (!communityId) {
        return next(new ApiError(400, 'Community context required'));
      }
      
      // Get user's role in the community
      const membership = await req.prisma.communityMember.findUnique({
        where: {
          userId_communityId: {
            userId: req.user.id,
            communityId
          }
        },
        include: {
          roles: {
            include: {
              role: true
            }
          },
          community: true
        }
      });
      
      if (!membership) {
        return next(new ApiError(403, 'Community membership required'));
      }
      
      // Check if user is community owner (has all permissions)
      if (membership.community.ownerId === req.user.id) {
        req.userMembership = membership;
        return next();
      }
      
      // Check permissions
      const userPermissions = membership.roles.reduce((perms, memberRole) => {
        return [...perms, ...memberRole.role.permissions];
      }, []);
      
      const hasRequiredPermissions = permissions.every(permission => 
        userPermissions.includes(permission)
      );
      
      if (!hasRequiredPermissions) {
        logger.logSecurityEvent('INSUFFICIENT_PERMISSIONS', {
          userId: req.user.id,
          communityId,
          requiredPermissions: permissions,
          userPermissions
        });
        return next(new ApiError(403, 'Insufficient permissions for this action'));
      }
      
      req.userMembership = membership;
      next();
      
    } catch (error) {
      logger.logError(error, req);
      next(new ApiError(500, 'Authorization check failed'));
    }
  };
};

/**
 * Admin-only middleware
 * Requires user to be a platform admin (future feature)
 */
const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return next(new AuthenticationError('Authentication required'));
  }
  
  // For now, we'll use a simple admin check
  // In production, this would check against an admin role or permission
  const adminUsers = (process.env.ADMIN_USERS || '').split(',');
  
  if (!adminUsers.includes(req.user.email) && !adminUsers.includes(req.user.walletAddress)) {
    logger.logSecurityEvent('ADMIN_ACCESS_DENIED', {
      userId: req.user.id,
      email: req.user.email,
      walletAddress: req.user.walletAddress
    });
    return next(new ApiError(403, 'Admin access required'));
  }
  
  logger.logUserAction(req.user.id, 'ADMIN_ACCESS', {
    endpoint: req.path,
    method: req.method
  });
  
  next();
};

/**
 * Rate limiting by user
 * Tracks API usage per user
 */
const rateLimitByUser = (maxRequests = 100, windowMinutes = 15) => {
  const userRequests = new Map();
  
  return (req, res, next) => {
    if (!req.user) {
      return next();
    }
    
    const userId = req.user.id;
    const now = Date.now();
    const windowMs = windowMinutes * 60 * 1000;
    
    if (!userRequests.has(userId)) {
      userRequests.set(userId, []);
    }
    
    const requests = userRequests.get(userId);
    
    // Remove expired requests
    const validRequests = requests.filter(time => now - time < windowMs);
    userRequests.set(userId, validRequests);
    
    if (validRequests.length >= maxRequests) {
      logger.logSecurityEvent('USER_RATE_LIMIT_EXCEEDED', {
        userId,
        requestCount: validRequests.length,
        maxRequests,
        windowMinutes
      });
      return next(new ApiError(429, `Too many requests. Maximum ${maxRequests} requests per ${windowMinutes} minutes.`));
    }
    
    validRequests.push(now);
    userRequests.set(userId, validRequests);
    
    next();
  };
};

/**
 * Ownership verification middleware
 * Ensures user owns the resource they're trying to modify
 */
const requireOwnership = (resourceType) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return next(new AuthenticationError('Authentication required'));
      }
      
      const resourceId = req.params.postId || req.params.communityId || req.params.id;
      
      if (!resourceId) {
        return next(new ApiError(400, 'Resource ID required'));
      }
      
      let resource;
      
      switch (resourceType) {
        case 'post':
          resource = await req.prisma.post.findUnique({
            where: { id: resourceId },
            select: { id: true, authorId: true }
          });
          if (resource && resource.authorId !== req.user.id) {
            return next(new ApiError(403, 'You can only modify your own posts'));
          }
          break;
          
        case 'community':
          resource = await req.prisma.community.findUnique({
            where: { id: resourceId },
            select: { id: true, ownerId: true }
          });
          if (resource && resource.ownerId !== req.user.id) {
            return next(new ApiError(403, 'You can only modify communities you own'));
          }
          break;
          
        default:
          return next(new ApiError(400, 'Invalid resource type'));
      }
      
      if (!resource) {
        return next(new ApiError(404, `${resourceType} not found`));
      }
      
      req.resource = resource;
      next();
      
    } catch (error) {
      logger.logError(error, req);
      next(new ApiError(500, 'Ownership verification failed'));
    }
  };
};

module.exports = {
  authenticate,
  optionalAuth,
  requirePermissions,
  requireAdmin,
  rateLimitByUser,
  requireOwnership
};