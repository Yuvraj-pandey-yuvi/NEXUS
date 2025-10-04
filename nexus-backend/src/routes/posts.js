// Posts Routes - Hybrid Content Management System
// Implements the "Graduation Path": Off-chain → Anchored → Minted NFT

const express = require('express');
const passport = require('passport');
const { body, query, param, validationResult } = require('express-validator');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');

const { ApiError } = require('../utils/errors');
const logger = require('../utils/logger');
const { uploadToIPFS } = require('../services/ipfsService');
const { anchorPost, mintPostAsNFT } = require('../services/blockchainService');
const { processImage, uploadToS3 } = require('../services/mediaService');
const { checkWeb3Access } = require('../middleware/web3Auth');

const router = express.Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 5 // Maximum 5 files
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new ApiError(400, 'Invalid file type'), false);
    }
  }
});

// ============= CONTENT CREATION =============

/**
 * @route   POST /api/posts
 * @desc    Create a new post (starts as off-chain)
 * @access  Private
 */
router.post('/',
  passport.authenticate('jwt', { session: false }),
  upload.array('media', 5),
  [
    body('content')
      .trim()
      .isLength({ min: 1, max: 2000 })
      .withMessage('Content must be between 1 and 2000 characters'),
    body('type')
      .optional()
      .isIn(['TEXT', 'IMAGE', 'VIDEO', 'POLL'])
      .withMessage('Invalid post type'),
    body('communityId')
      .optional()
      .isUUID()
      .withMessage('Invalid community ID')
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw new ApiError(400, 'Validation failed', errors.array());
      }

      const { content, type = 'TEXT', communityId } = req.body;
      const mediaFiles = req.files || [];

      // Process and upload media files
      let mediaUrls = [];
      if (mediaFiles.length > 0) {
        mediaUrls = await Promise.all(
          mediaFiles.map(async (file) => {
            if (file.mimetype.startsWith('image/')) {
              // Process and optimize image
              const processedImage = await processImage(file.buffer);
              return await uploadToS3(processedImage, `posts/${req.user.id}`, file.mimetype);
            } else {
              // Upload video directly
              return await uploadToS3(file.buffer, `posts/${req.user.id}`, file.mimetype);
            }
          })
        );
      }

      // Create post in database (off-chain)
      const post = await req.prisma.post.create({
        data: {
          authorId: req.user.id,
          content,
          mediaUrls,
          type,
          status: 'PUBLISHED'
        },
        include: {
          author: {
            select: {
              id: true,
              username: true,
              displayName: true,
              profileImage: true,
              isWeb3Verified: true
            }
          },
          _count: {
            select: {
              likes: true,
              comments: true
            }
          }
        }
      });

      // If posting to a community, add community relation
      if (communityId) {
        // Verify user is member of community
        const membership = await req.prisma.communityMember.findUnique({
          where: {
            userId_communityId: {
              userId: req.user.id,
              communityId
            }
          }
        });

        if (!membership) {
          throw new ApiError(403, 'You must be a member of this community to post');
        }

        await req.prisma.communityPost.create({
          data: {
            postId: post.id,
            communityId
          }
        });

        // Update community post count
        await req.prisma.community.update({
          where: { id: communityId },
          data: { totalPosts: { increment: 1 } }
        });
      }

      // Emit real-time event
      req.io.emit('newPost', {
        postId: post.id,
        authorId: post.authorId,
        communityId
      });

      logger.info('New post created:', { 
        postId: post.id, 
        authorId: req.user.id,
        type,
        hasMedia: mediaUrls.length > 0
      });

      res.status(201).json({
        success: true,
        message: 'Post created successfully',
        post: {
          ...post,
          likesCount: post._count.likes,
          commentsCount: post._count.comments,
          isLiked: false,
          canAnchor: true,
          canMint: false
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

// ============= CONTENT GRADUATION: ANCHORING =============

/**
 * @route   POST /api/posts/:postId/anchor
 * @desc    Anchor a post to blockchain (graduation step 1)
 * @access  Private (Web3 required for on-chain interaction)
 */
router.post('/:postId/anchor',
  passport.authenticate('jwt', { session: false }),
  checkWeb3Access,
  [
    param('postId').isUUID().withMessage('Invalid post ID')
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw new ApiError(400, 'Validation failed', errors.array());
      }

      const { postId } = req.params;

      // Get post and verify ownership
      const post = await req.prisma.post.findUnique({
        where: { id: postId },
        include: { author: true }
      });

      if (!post) {
        throw new ApiError(404, 'Post not found');
      }

      if (post.authorId !== req.user.id) {
        throw new ApiError(403, 'You can only anchor your own posts');
      }

      if (post.isAnchored) {
        throw new ApiError(400, 'Post is already anchored');
      }

      // Check free anchors limit
      const currentMonth = new Date().getMonth();
      const lastResetMonth = new Date(req.user.lastAnchorReset).getMonth();
      
      if (currentMonth !== lastResetMonth) {
        // Reset monthly free anchors
        await req.prisma.user.update({
          where: { id: req.user.id },
          data: {
            freeAnchorsUsed: 0,
            lastAnchorReset: new Date()
          }
        });
        req.user.freeAnchorsUsed = 0;
      }

      const maxFreeAnchors = parseInt(process.env.FREE_ANCHORS_PER_MONTH) || 10;
      if (req.user.freeAnchorsUsed >= maxFreeAnchors) {
        throw new ApiError(402, `You have used all ${maxFreeAnchors} free anchors this month`);
      }

      // Create content hash for anchoring
      const contentData = {
        content: post.content,
        mediaUrls: post.mediaUrls,
        author: post.author.walletAddress || post.author.username,
        timestamp: post.createdAt.toISOString()
      };
      const contentHash = require('crypto')
        .createHash('sha256')
        .update(JSON.stringify(contentData))
        .digest('hex');

      // Anchor to blockchain
      const anchorResult = await anchorPost(contentHash, req.user.walletAddress);

      // Update post in database
      const updatedPost = await req.prisma.post.update({
        where: { id: postId },
        data: {
          isAnchored: true,
          status: 'ANCHORED',
          anchoredAt: new Date()
        }
      });

      // Create anchor record
      await req.prisma.postAnchor.create({
        data: {
          postId,
          userId: req.user.id,
          transactionHash: anchorResult.transactionHash,
          blockNumber: anchorResult.blockNumber,
          gasUsed: anchorResult.gasUsed.toString()
        }
      });

      // Update user's free anchor count
      await req.prisma.user.update({
        where: { id: req.user.id },
        data: { freeAnchorsUsed: { increment: 1 } }
      });

      // Emit real-time event
      req.io.emit('postAnchored', {
        postId,
        authorId: req.user.id,
        transactionHash: anchorResult.transactionHash
      });

      logger.info('Post anchored successfully:', {
        postId,
        authorId: req.user.id,
        transactionHash: anchorResult.transactionHash
      });

      res.json({
        success: true,
        message: 'Post anchored to blockchain successfully',
        post: updatedPost,
        anchor: {
          transactionHash: anchorResult.transactionHash,
          blockNumber: anchorResult.blockNumber,
          gasUsed: anchorResult.gasUsed,
          explorer: `https://polygonscan.com/tx/${anchorResult.transactionHash}`
        },
        usage: {
          freeAnchorsUsed: req.user.freeAnchorsUsed + 1,
          freeAnchorsRemaining: maxFreeAnchors - req.user.freeAnchorsUsed - 1
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

// ============= CONTENT GRADUATION: NFT MINTING =============

/**
 * @route   POST /api/posts/:postId/mint
 * @desc    Mint post as NFT (graduation step 2)
 * @access  Private (Web3 required)
 */
router.post('/:postId/mint',
  passport.authenticate('jwt', { session: false }),
  checkWeb3Access,
  [
    param('postId').isUUID().withMessage('Invalid post ID'),
    body('title')
      .optional()
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage('Title must be between 1 and 100 characters'),
    body('description')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('Description must be less than 500 characters')
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw new ApiError(400, 'Validation failed', errors.array());
      }

      const { postId } = req.params;
      const { title, description } = req.body;

      // Get post and verify ownership
      const post = await req.prisma.post.findUnique({
        where: { id: postId },
        include: { author: true }
      });

      if (!post) {
        throw new ApiError(404, 'Post not found');
      }

      if (post.authorId !== req.user.id) {
        throw new ApiError(403, 'You can only mint your own posts');
      }

      if (!post.isAnchored) {
        throw new ApiError(400, 'Post must be anchored before minting');
      }

      if (post.isMinted) {
        throw new ApiError(400, 'Post is already minted as NFT');
      }

      // Create NFT metadata
      const metadata = {
        name: title || `Post by ${post.author.displayName}`,
        description: description || post.content.substring(0, 200),
        image: post.mediaUrls[0] || `https://api.dicebear.com/7.x/identicon/svg?seed=${post.id}`,
        attributes: [
          {
            trait_type: "Author",
            value: post.author.displayName
          },
          {
            trait_type: "Created",
            value: post.createdAt.toISOString()
          },
          {
            trait_type: "Anchored",
            value: post.anchoredAt.toISOString()
          },
          {
            trait_type: "Content Type",
            value: post.type
          }
        ],
        content: post.content,
        media: post.mediaUrls,
        external_url: `${process.env.FRONTEND_URL}/posts/${post.id}`
      };

      // Upload metadata to IPFS
      const metadataHash = await uploadToIPFS(JSON.stringify(metadata));
      const tokenURI = `${process.env.IPFS_GATEWAY}/${metadataHash}`;

      // Mint NFT on blockchain
      const mintResult = await mintPostAsNFT(post.id, tokenURI, req.user.walletAddress);

      // Update post in database
      const updatedPost = await req.prisma.post.update({
        where: { id: postId },
        data: {
          isMinted: true,
          status: 'MINTED',
          tokenId: mintResult.tokenId,
          contractAddress: mintResult.contractAddress,
          ipfsHash: metadataHash,
          mintedAt: new Date()
        }
      });

      // Emit real-time event
      req.io.emit('postMinted', {
        postId,
        authorId: req.user.id,
        tokenId: mintResult.tokenId,
        contractAddress: mintResult.contractAddress
      });

      logger.info('Post minted as NFT successfully:', {
        postId,
        authorId: req.user.id,
        tokenId: mintResult.tokenId,
        contractAddress: mintResult.contractAddress
      });

      res.json({
        success: true,
        message: 'Post minted as NFT successfully',
        post: updatedPost,
        nft: {
          tokenId: mintResult.tokenId,
          contractAddress: mintResult.contractAddress,
          metadataUri: tokenURI,
          ipfsHash: metadataHash,
          transactionHash: mintResult.transactionHash,
          opensea: `https://testnets.opensea.io/assets/${mintResult.contractAddress}/${mintResult.tokenId}`,
          explorer: `https://polygonscan.com/tx/${mintResult.transactionHash}`
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

// ============= CONTENT RETRIEVAL =============

/**
 * @route   GET /api/posts/feed
 * @desc    Get personalized feed
 * @access  Private
 */
router.get('/feed',
  passport.authenticate('jwt', { session: false }),
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50'),
    query('type').optional().isIn(['all', 'following', 'community']).withMessage('Invalid feed type')
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw new ApiError(400, 'Validation failed', errors.array());
      }

      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const feedType = req.query.type || 'all';
      const skip = (page - 1) * limit;

      let whereClause = { status: { in: ['PUBLISHED', 'ANCHORED', 'MINTED'] } };

      if (feedType === 'following') {
        // Get posts from users the current user follows
        const following = await req.prisma.follow.findMany({
          where: { followerId: req.user.id },
          select: { followingId: true }
        });

        const followingIds = following.map(f => f.followingId);
        whereClause.authorId = { in: [...followingIds, req.user.id] };
      } else if (feedType === 'community') {
        // Get posts from user's communities
        const userCommunities = await req.prisma.communityMember.findMany({
          where: { userId: req.user.id },
          select: { communityId: true }
        });

        const communityIds = userCommunities.map(cm => cm.communityId);
        whereClause.communityPosts = {
          some: {
            communityId: { in: communityIds }
          }
        };
      }

      const posts = await req.prisma.post.findMany({
        where: whereClause,
        include: {
          author: {
            select: {
              id: true,
              username: true,
              displayName: true,
              profileImage: true,
              isWeb3Verified: true
            }
          },
          likes: {
            where: { userId: req.user.id },
            select: { id: true }
          },
          communityPosts: {
            include: {
              community: {
                select: {
                  id: true,
                  name: true,
                  imageUrl: true
                }
              }
            }
          },
          _count: {
            select: {
              likes: true,
              comments: true
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      });

      const formattedPosts = posts.map(post => ({
        ...post,
        likesCount: post._count.likes,
        commentsCount: post._count.comments,
        isLiked: post.likes.length > 0,
        canAnchor: post.authorId === req.user.id && !post.isAnchored && req.user.isWeb3Session,
        canMint: post.authorId === req.user.id && post.isAnchored && !post.isMinted && req.user.isWeb3Session,
        community: post.communityPosts[0]?.community || null,
        _count: undefined,
        likes: undefined,
        communityPosts: undefined
      }));

      res.json({
        success: true,
        posts: formattedPosts,
        pagination: {
          page,
          limit,
          hasMore: posts.length === limit
        }
      });

    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/posts/:postId
 * @desc    Get single post with comments
 * @access  Private
 */
router.get('/:postId',
  passport.authenticate('jwt', { session: false }),
  [
    param('postId').isUUID().withMessage('Invalid post ID')
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw new ApiError(400, 'Validation failed', errors.array());
      }

      const { postId } = req.params;

      const post = await req.prisma.post.findUnique({
        where: { id: postId },
        include: {
          author: {
            select: {
              id: true,
              username: true,
              displayName: true,
              profileImage: true,
              isWeb3Verified: true
            }
          },
          likes: {
            where: { userId: req.user.id },
            select: { id: true }
          },
          comments: {
            include: {
              author: {
                select: {
                  id: true,
                  username: true,
                  displayName: true,
                  profileImage: true
                }
              }
            },
            orderBy: { createdAt: 'asc' }
          },
          anchors: {
            select: {
              transactionHash: true,
              blockNumber: true,
              anchoredAt: true
            }
          },
          communityPosts: {
            include: {
              community: {
                select: {
                  id: true,
                  name: true,
                  imageUrl: true
                }
              }
            }
          },
          _count: {
            select: {
              likes: true,
              comments: true
            }
          }
        }
      });

      if (!post) {
        throw new ApiError(404, 'Post not found');
      }

      // Check if post is delisted and user has permission to view
      if (post.status === 'DELISTED' && post.authorId !== req.user.id) {
        throw new ApiError(404, 'Post not found');
      }

      const response = {
        ...post,
        likesCount: post._count.likes,
        commentsCount: post._count.comments,
        isLiked: post.likes.length > 0,
        canAnchor: post.authorId === req.user.id && !post.isAnchored && req.user.isWeb3Session,
        canMint: post.authorId === req.user.id && post.isAnchored && !post.isMinted && req.user.isWeb3Session,
        community: post.communityPosts[0]?.community || null,
        anchor: post.anchors[0] || null,
        blockchain: post.isMinted ? {
          tokenId: post.tokenId,
          contractAddress: post.contractAddress,
          opensea: `https://testnets.opensea.io/assets/${post.contractAddress}/${post.tokenId}`,
          explorer: post.anchors[0] ? `https://polygonscan.com/tx/${post.anchors[0].transactionHash}` : null
        } : null,
        _count: undefined,
        likes: undefined,
        anchors: undefined,
        communityPosts: undefined
      };

      res.json({
        success: true,
        post: response
      });

    } catch (error) {
      next(error);
    }
  }
);

// ============= ENGAGEMENT =============

/**
 * @route   POST /api/posts/:postId/like
 * @desc    Like/unlike a post
 * @access  Private
 */
router.post('/:postId/like',
  passport.authenticate('jwt', { session: false }),
  [
    param('postId').isUUID().withMessage('Invalid post ID')
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw new ApiError(400, 'Validation failed', errors.array());
      }

      const { postId } = req.params;

      // Check if post exists
      const post = await req.prisma.post.findUnique({
        where: { id: postId }
      });

      if (!post) {
        throw new ApiError(404, 'Post not found');
      }

      // Check if user already liked the post
      const existingLike = await req.prisma.like.findUnique({
        where: {
          userId_postId: {
            userId: req.user.id,
            postId
          }
        }
      });

      let action, likesCount;

      if (existingLike) {
        // Unlike the post
        await req.prisma.like.delete({
          where: { id: existingLike.id }
        });

        // Update post likes count
        const updatedPost = await req.prisma.post.update({
          where: { id: postId },
          data: { likesCount: { decrement: 1 } }
        });

        action = 'unliked';
        likesCount = updatedPost.likesCount;
      } else {
        // Like the post
        await req.prisma.like.create({
          data: {
            userId: req.user.id,
            postId,
            isBatched: post.isAnchored // Mark for batching if post is anchored
          }
        });

        // Update post likes count
        const updatedPost = await req.prisma.post.update({
          where: { id: postId },
          data: { likesCount: { increment: 1 } }
        });

        action = 'liked';
        likesCount = updatedPost.likesCount;

        // Update author's total likes
        await req.prisma.user.update({
          where: { id: post.authorId },
          data: { totalLikes: { increment: 1 } }
        });
      }

      // Emit real-time event
      req.io.emit('postLike', {
        postId,
        authorId: post.authorId,
        action,
        likesCount
      });

      res.json({
        success: true,
        action,
        likesCount,
        isLiked: action === 'liked'
      });

    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/posts/:postId/comments
 * @desc    Add comment to post
 * @access  Private
 */
router.post('/:postId/comments',
  passport.authenticate('jwt', { session: false }),
  [
    param('postId').isUUID().withMessage('Invalid post ID'),
    body('content')
      .trim()
      .isLength({ min: 1, max: 500 })
      .withMessage('Comment must be between 1 and 500 characters')
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw new ApiError(400, 'Validation failed', errors.array());
      }

      const { postId } = req.params;
      const { content } = req.body;

      // Check if post exists
      const post = await req.prisma.post.findUnique({
        where: { id: postId }
      });

      if (!post) {
        throw new ApiError(404, 'Post not found');
      }

      // Create comment
      const comment = await req.prisma.comment.create({
        data: {
          postId,
          authorId: req.user.id,
          content
        },
        include: {
          author: {
            select: {
              id: true,
              username: true,
              displayName: true,
              profileImage: true
            }
          }
        }
      });

      // Update post comments count
      await req.prisma.post.update({
        where: { id: postId },
        data: { commentsCount: { increment: 1 } }
      });

      // Emit real-time event
      req.io.emit('newComment', {
        postId,
        comment: comment,
        authorId: post.authorId
      });

      res.status(201).json({
        success: true,
        message: 'Comment added successfully',
        comment
      });

    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;