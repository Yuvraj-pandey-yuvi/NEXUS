// Communities Routes - DAO Governance & Treasury Management
// Implements creator-led communities with on-chain voting and shared treasuries

const express = require('express');
const passport = require('passport');
const { body, query, param, validationResult } = require('express-validator');
const { ethers } = require('ethers');

const { ApiError } = require('../utils/errors');
const logger = require('../utils/logger');
const { checkWeb3Access } = require('../middleware/web3Auth');
const { createCommunityTreasury, executeProposal } = require('../services/blockchainService');

const router = express.Router();

// ============= COMMUNITY MANAGEMENT =============

/**
 * @route   POST /api/communities
 * @desc    Create a new community
 * @access  Private
 */
router.post('/',
  passport.authenticate('jwt', { session: false }),
  [
    body('name')
      .trim()
      .isLength({ min: 3, max: 50 })
      .withMessage('Community name must be between 3 and 50 characters')
      .matches(/^[a-zA-Z0-9\s\-_]+$/)
      .withMessage('Community name contains invalid characters'),
    body('description')
      .trim()
      .isLength({ min: 10, max: 500 })
      .withMessage('Description must be between 10 and 500 characters'),
    body('type')
      .isIn(['FREE', 'TOKEN_GATED', 'NFT_GATED'])
      .withMessage('Invalid community type'),
    body('entryFee')
      .optional()
      .isNumeric()
      .withMessage('Entry fee must be numeric'),
    body('requiredNFT')
      .optional()
      .isEthereumAddress()
      .withMessage('Required NFT must be a valid contract address'),
    body('votingPower')
      .optional()
      .isIn(['EQUAL', 'TOKEN_WEIGHTED', 'NFT_WEIGHTED'])
      .withMessage('Invalid voting power type')
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw new ApiError(400, 'Validation failed', errors.array());
      }

      const { 
        name, 
        description, 
        type, 
        entryFee, 
        requiredNFT, 
        votingPower = 'EQUAL' 
      } = req.body;

      // Check if community name is unique
      const existingCommunity = await req.prisma.community.findUnique({
        where: { name }
      });

      if (existingCommunity) {
        throw new ApiError(409, 'Community name already exists');
      }

      // Validate type-specific requirements
      if (type === 'TOKEN_GATED' && !entryFee) {
        throw new ApiError(400, 'Token-gated communities require an entry fee');
      }

      if (type === 'NFT_GATED' && !requiredNFT) {
        throw new ApiError(400, 'NFT-gated communities require a required NFT contract address');
      }

      // Create treasury if Web3 user (for DAO features)
      let treasuryAddress = null;
      if (req.user.isWeb3Verified && req.user.walletAddress) {
        try {
          treasuryAddress = await createCommunityTreasury(req.user.walletAddress);
        } catch (error) {
          logger.error('Failed to create treasury:', error);
          // Continue without treasury - can be created later
        }
      }

      // Create community
      const community = await req.prisma.community.create({
        data: {
          name,
          description,
          type,
          entryFee: entryFee ? ethers.utils.parseEther(entryFee.toString()).toString() : null,
          requiredNFT,
          votingPower,
          treasuryAddress,
          ownerId: req.user.id,
          memberCount: 1 // Creator is first member
        },
        include: {
          owner: {
            select: {
              id: true,
              username: true,
              displayName: true,
              profileImage: true,
              isWeb3Verified: true
            }
          }
        }
      });

      // Add creator as first member with admin role
      const membership = await req.prisma.communityMember.create({
        data: {
          userId: req.user.id,
          communityId: community.id,
          status: 'ACTIVE'
        }
      });

      // Create default roles
      const adminRole = await req.prisma.communityRole.create({
        data: {
          communityId: community.id,
          name: 'Admin',
          description: 'Full administrative access',
          permissions: ['MANAGE_COMMUNITY', 'MANAGE_MEMBERS', 'CREATE_PROPOSALS', 'MANAGE_ROLES'],
          color: '#ef4444'
        }
      });

      const moderatorRole = await req.prisma.communityRole.create({
        data: {
          communityId: community.id,
          name: 'Moderator',
          description: 'Can moderate posts and manage members',
          permissions: ['MODERATE_POSTS', 'MANAGE_MEMBERS', 'CREATE_PROPOSALS'],
          color: '#f97316'
        }
      });

      const memberRole = await req.prisma.communityRole.create({
        data: {
          communityId: community.id,
          name: 'Member',
          description: 'Basic community member',
          permissions: ['POST', 'COMMENT', 'VOTE'],
          color: '#6366f1'
        }
      });

      // Assign admin role to creator
      await req.prisma.communityMemberRole.create({
        data: {
          memberId: membership.id,
          roleId: adminRole.id
        }
      });

      logger.info('Community created:', {
        communityId: community.id,
        name: community.name,
        ownerId: req.user.id,
        type: community.type,
        hasTreasury: !!treasuryAddress
      });

      res.status(201).json({
        success: true,
        message: 'Community created successfully',
        community: {
          ...community,
          canManage: true,
          userRole: 'Admin',
          membershipStatus: 'ACTIVE'
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/communities
 * @desc    Get communities with filtering and search
 * @access  Private
 */
router.get('/',
  passport.authenticate('jwt', { session: false }),
  [
    query('search').optional().trim().isLength({ min: 1, max: 100 }),
    query('type').optional().isIn(['FREE', 'TOKEN_GATED', 'NFT_GATED']),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 50 }),
    query('sort').optional().isIn(['newest', 'popular', 'alphabetical'])
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw new ApiError(400, 'Validation failed', errors.array());
      }

      const { 
        search, 
        type, 
        page = 1, 
        limit = 20, 
        sort = 'newest' 
      } = req.query;

      const skip = (page - 1) * limit;

      // Build where clause
      let whereClause = {};
      if (search) {
        whereClause.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } }
        ];
      }
      if (type) {
        whereClause.type = type;
      }

      // Build order clause
      let orderBy = {};
      switch (sort) {
        case 'popular':
          orderBy = { memberCount: 'desc' };
          break;
        case 'alphabetical':
          orderBy = { name: 'asc' };
          break;
        default:
          orderBy = { createdAt: 'desc' };
      }

      const communities = await req.prisma.community.findMany({
        where: whereClause,
        include: {
          owner: {
            select: {
              id: true,
              username: true,
              displayName: true,
              profileImage: true,
              isWeb3Verified: true
            }
          },
          members: {
            where: { userId: req.user.id },
            select: {
              status: true,
              joinedAt: true,
              roles: {
                include: {
                  role: {
                    select: {
                      name: true,
                      permissions: true
                    }
                  }
                }
              }
            }
          }
        },
        orderBy,
        skip: parseInt(skip),
        take: parseInt(limit)
      });

      const formattedCommunities = communities.map(community => {
        const membership = community.members[0];
        const userRole = membership?.roles?.[0]?.role?.name || null;
        const canManage = membership?.roles?.some(mr => 
          mr.role.permissions.includes('MANAGE_COMMUNITY')
        ) || community.ownerId === req.user.id;

        return {
          ...community,
          entryFee: community.entryFee ? ethers.utils.formatEther(community.entryFee) : null,
          isMember: !!membership,
          membershipStatus: membership?.status || null,
          userRole,
          canManage,
          members: undefined // Remove members array from response
        };
      });

      res.json({
        success: true,
        communities: formattedCommunities,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          hasMore: communities.length === parseInt(limit)
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/communities/:communityId/join
 * @desc    Join a community
 * @access  Private
 */
router.post('/:communityId/join',
  passport.authenticate('jwt', { session: false }),
  [
    param('communityId').isUUID().withMessage('Invalid community ID'),
    body('paymentTxHash').optional().isHexadecimal().withMessage('Invalid transaction hash')
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw new ApiError(400, 'Validation failed', errors.array());
      }

      const { communityId } = req.params;
      const { paymentTxHash } = req.body;

      // Get community details
      const community = await req.prisma.community.findUnique({
        where: { id: communityId },
        include: {
          members: {
            where: { userId: req.user.id }
          }
        }
      });

      if (!community) {
        throw new ApiError(404, 'Community not found');
      }

      // Check if already a member
      if (community.members.length > 0) {
        throw new ApiError(409, 'Already a member of this community');
      }

      // Handle different community types
      if (community.type === 'TOKEN_GATED') {
        if (!paymentTxHash) {
          throw new ApiError(400, 'Payment transaction hash required for token-gated community');
        }
        
        // In a production environment, verify the payment transaction
        // For now, we'll assume the payment is valid
        logger.info('Token-gated community join:', { communityId, paymentTxHash });
      }

      if (community.type === 'NFT_GATED') {
        if (!req.user.isWeb3Verified) {
          throw new ApiError(403, 'Web3 verification required for NFT-gated communities');
        }

        // In a production environment, verify NFT ownership
        // For now, we'll assume the user owns the required NFT
        logger.info('NFT-gated community join:', { communityId, walletAddress: req.user.walletAddress });
      }

      // Create membership
      const membership = await req.prisma.communityMember.create({
        data: {
          userId: req.user.id,
          communityId,
          status: 'ACTIVE'
        }
      });

      // Get default member role
      const memberRole = await req.prisma.communityRole.findFirst({
        where: {
          communityId,
          name: 'Member'
        }
      });

      if (memberRole) {
        await req.prisma.communityMemberRole.create({
          data: {
            memberId: membership.id,
            roleId: memberRole.id
          }
        });
      }

      // Update community member count
      await req.prisma.community.update({
        where: { id: communityId },
        data: { memberCount: { increment: 1 } }
      });

      logger.info('User joined community:', {
        userId: req.user.id,
        communityId,
        type: community.type
      });

      res.json({
        success: true,
        message: 'Successfully joined community',
        membership: {
          status: 'ACTIVE',
          joinedAt: membership.joinedAt,
          role: 'Member'
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

// ============= DAO GOVERNANCE =============

/**
 * @route   POST /api/communities/:communityId/proposals
 * @desc    Create a governance proposal
 * @access  Private (Community members only)
 */
router.post('/:communityId/proposals',
  passport.authenticate('jwt', { session: false }),
  [
    param('communityId').isUUID().withMessage('Invalid community ID'),
    body('title')
      .trim()
      .isLength({ min: 5, max: 100 })
      .withMessage('Title must be between 5 and 100 characters'),
    body('description')
      .trim()
      .isLength({ min: 20, max: 2000 })
      .withMessage('Description must be between 20 and 2000 characters'),
    body('type')
      .isIn(['FUNDING', 'GOVERNANCE', 'BOUNTY', 'GENERAL'])
      .withMessage('Invalid proposal type'),
    body('votingDuration')
      .isInt({ min: 1, max: 168 })
      .withMessage('Voting duration must be between 1 and 168 hours'),
    body('requiredQuorum')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Quorum must be between 1 and 100 percent'),
    body('passingThreshold')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Passing threshold must be between 1 and 100 percent'),
    body('gasRequired')
      .optional()
      .isBoolean()
      .withMessage('Gas required must be boolean')
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw new ApiError(400, 'Validation failed', errors.array());
      }

      const { communityId } = req.params;
      const {
        title,
        description,
        type,
        votingDuration,
        requiredQuorum = 50,
        passingThreshold = 50,
        gasRequired = false
      } = req.body;

      // Verify community membership and permissions
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
          }
        }
      });

      if (!membership) {
        throw new ApiError(403, 'You must be a member to create proposals');
      }

      const canCreateProposals = membership.roles.some(mr => 
        mr.role.permissions.includes('CREATE_PROPOSALS')
      );

      if (!canCreateProposals) {
        throw new ApiError(403, 'You do not have permission to create proposals');
      }

      // Calculate voting period
      const votingStartsAt = new Date();
      const votingEndsAt = new Date(votingStartsAt.getTime() + (votingDuration * 60 * 60 * 1000));

      // Create proposal
      const proposal = await req.prisma.proposal.create({
        data: {
          communityId,
          title,
          description,
          type,
          votingStartsAt,
          votingEndsAt,
          requiredQuorum,
          passingThreshold,
          gasRequired,
          status: 'ACTIVE'
        },
        include: {
          community: {
            select: {
              id: true,
              name: true,
              memberCount: true
            }
          }
        }
      });

      // Emit real-time event to community members
      req.io.to(`community_${communityId}`).emit('newProposal', {
        proposalId: proposal.id,
        communityId,
        title: proposal.title,
        type: proposal.type
      });

      logger.info('Proposal created:', {
        proposalId: proposal.id,
        communityId,
        authorId: req.user.id,
        type
      });

      res.status(201).json({
        success: true,
        message: 'Proposal created successfully',
        proposal: {
          ...proposal,
          canVote: true,
          hasVoted: false,
          timeRemaining: votingDuration * 60 * 60 * 1000
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/communities/:communityId/proposals/:proposalId/vote
 * @desc    Vote on a proposal
 * @access  Private (Community members only)
 */
router.post('/:communityId/proposals/:proposalId/vote',
  passport.authenticate('jwt', { session: false }),
  [
    param('communityId').isUUID().withMessage('Invalid community ID'),
    param('proposalId').isUUID().withMessage('Invalid proposal ID'),
    body('vote')
      .isBoolean()
      .withMessage('Vote must be true (yes) or false (no)'),
    body('txHash')
      .optional()
      .isHexadecimal()
      .withMessage('Invalid transaction hash')
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw new ApiError(400, 'Validation failed', errors.array());
      }

      const { communityId, proposalId } = req.params;
      const { vote, txHash } = req.body;

      // Verify proposal exists and is active
      const proposal = await req.prisma.proposal.findUnique({
        where: { id: proposalId },
        include: {
          community: true,
          votes: {
            where: { userId: req.user.id }
          }
        }
      });

      if (!proposal || proposal.communityId !== communityId) {
        throw new ApiError(404, 'Proposal not found');
      }

      if (proposal.status !== 'ACTIVE') {
        throw new ApiError(400, 'Proposal is not active');
      }

      if (new Date() > proposal.votingEndsAt) {
        throw new ApiError(400, 'Voting period has ended');
      }

      // Check if user already voted
      if (proposal.votes.length > 0) {
        throw new ApiError(409, 'You have already voted on this proposal');
      }

      // Verify community membership
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
          }
        }
      });

      if (!membership) {
        throw new ApiError(403, 'You must be a member to vote');
      }

      const canVote = membership.roles.some(mr => 
        mr.role.permissions.includes('VOTE')
      );

      if (!canVote) {
        throw new ApiError(403, 'You do not have permission to vote');
      }

      // Check gas requirement
      if (proposal.gasRequired && !txHash) {
        throw new ApiError(400, 'Transaction hash required for gas-enabled voting');
      }

      // Calculate voting weight based on community settings
      let votingWeight = 1; // Default equal voting
      
      if (proposal.community.votingPower === 'TOKEN_WEIGHTED') {
        // In a production environment, calculate based on token holdings
        votingWeight = 1;
      } else if (proposal.community.votingPower === 'NFT_WEIGHTED') {
        // In a production environment, calculate based on NFT holdings
        votingWeight = 1;
      }

      // Record vote
      await req.prisma.proposalVote.create({
        data: {
          proposalId,
          userId: req.user.id,
          vote,
          weight: votingWeight
        }
      });

      // Update proposal vote counts
      const updateData = vote 
        ? { yesVotes: { increment: votingWeight } }
        : { noVotes: { increment: votingWeight } };
      
      updateData.totalVotes = { increment: votingWeight };

      const updatedProposal = await req.prisma.proposal.update({
        where: { id: proposalId },
        data: updateData
      });

      // Check if proposal should be resolved
      const totalMembers = proposal.community.memberCount;
      const participationRate = (updatedProposal.totalVotes / totalMembers) * 100;
      
      if (participationRate >= updatedProposal.requiredQuorum) {
        const yesPercentage = (updatedProposal.yesVotes / updatedProposal.totalVotes) * 100;
        
        if (yesPercentage >= updatedProposal.passingThreshold) {
          await req.prisma.proposal.update({
            where: { id: proposalId },
            data: { status: 'PASSED' }
          });
        } else if (new Date() > updatedProposal.votingEndsAt) {
          await req.prisma.proposal.update({
            where: { id: proposalId },
            data: { status: 'FAILED' }
          });
        }
      }

      // Emit real-time event
      req.io.to(`community_${communityId}`).emit('proposalVote', {
        proposalId,
        yesVotes: updatedProposal.yesVotes,
        noVotes: updatedProposal.noVotes,
        totalVotes: updatedProposal.totalVotes
      });

      logger.info('Vote cast:', {
        proposalId,
        userId: req.user.id,
        vote,
        weight: votingWeight,
        gasUsed: !!txHash
      });

      res.json({
        success: true,
        message: 'Vote recorded successfully',
        vote: {
          vote,
          weight: votingWeight,
          timestamp: new Date()
        },
        proposal: {
          yesVotes: updatedProposal.yesVotes,
          noVotes: updatedProposal.noVotes,
          totalVotes: updatedProposal.totalVotes,
          participationRate: participationRate.toFixed(1)
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/communities/:communityId/proposals
 * @desc    Get community proposals
 * @access  Private (Community members only)
 */
router.get('/:communityId/proposals',
  passport.authenticate('jwt', { session: false }),
  [
    param('communityId').isUUID().withMessage('Invalid community ID'),
    query('status').optional().isIn(['ACTIVE', 'PASSED', 'FAILED', 'EXECUTED']),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 50 })
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw new ApiError(400, 'Validation failed', errors.array());
      }

      const { communityId } = req.params;
      const { status, page = 1, limit = 10 } = req.query;
      const skip = (page - 1) * limit;

      // Verify community membership
      const membership = await req.prisma.communityMember.findUnique({
        where: {
          userId_communityId: {
            userId: req.user.id,
            communityId
          }
        }
      });

      if (!membership) {
        throw new ApiError(403, 'You must be a member to view proposals');
      }

      // Build where clause
      let whereClause = { communityId };
      if (status) {
        whereClause.status = status;
      }

      const proposals = await req.prisma.proposal.findMany({
        where: whereClause,
        include: {
          votes: {
            where: { userId: req.user.id },
            select: { vote: true }
          },
          _count: {
            select: { votes: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip: parseInt(skip),
        take: parseInt(limit)
      });

      const formattedProposals = proposals.map(proposal => {
        const userVote = proposal.votes[0];
        const timeRemaining = Math.max(0, proposal.votingEndsAt.getTime() - Date.now());
        const isActive = proposal.status === 'ACTIVE' && timeRemaining > 0;

        return {
          ...proposal,
          hasVoted: !!userVote,
          userVote: userVote?.vote || null,
          timeRemaining,
          isActive,
          participationRate: ((proposal.totalVotes / membership.community?.memberCount || 1) * 100).toFixed(1),
          canVote: isActive && !userVote,
          votes: undefined,
          _count: undefined
        };
      });

      res.json({
        success: true,
        proposals: formattedProposals,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          hasMore: proposals.length === parseInt(limit)
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;