# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Architecture

Project Nexus is a **hybrid Web2/Web3 social platform** with a three-layer architecture:

1. **Smart Contracts Layer** (`nexus-contracts/`) - Solidity contracts on Ethereum/Polygon
2. **Backend API Layer** (`nexus-backend/`) - Node.js/Express hybrid Web2/Web3 backend  
3. **Frontend Layer** (`nexus-contracts/frontend/`) - React application with Web3 integration

### Core Innovation: "The Graduation Path"
```
Off-chain Post → Blockchain Anchor → NFT Mint
     (Free)      (Limited Free)      (Gas Fee)
```

Users can progressively upgrade their content from free social posts to permanent NFT ownership.

## Essential Commands

### Smart Contract Development
```powershell
# Navigate to contracts directory
cd "nexus-contracts"

# Install dependencies  
npm install

# Compile contracts
npm run compile

# Test contracts
npm test

# Deploy to local network
npx hardhat node
npm run deploy:local

# Deploy to Sepolia testnet
npm run deploy:sepolia

# Start local Hardhat network
npx hardhat node
```

### Backend Development  
```powershell
# Navigate to backend directory
cd "nexus-backend"

# Install dependencies
npm install

# Set up database
npx prisma generate
npx prisma migrate dev

# Development server
npm run dev

# Production server
npm start

# Database operations
npm run migrate
npm run seed
```

### Frontend Development
```powershell
# Navigate to frontend directory
cd "nexus-contracts\frontend"

# Install dependencies
npm install

# Start development server
npm start

# Build for production
npm run build
```

## Development Environment Setup

### Prerequisites
- **Node.js**: v16-18 LTS (v22 not supported by Hardhat)
- **PostgreSQL**: For backend database
- **MetaMask**: For Web3 wallet integration
- **Redis**: Optional, for caching

### Environment Files Required

**nexus-contracts/.env:**
```env
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY
PRIVATE_KEY=your_wallet_private_key
ETHERSCAN_API_KEY=your_etherscan_api_key
```

**nexus-backend/.env:**
```env
NODE_ENV=development
PORT=5000
DATABASE_URL="postgresql://username:password@localhost:5432/nexus"
FRONTEND_URL=http://localhost:3000

# Authentication
JWT_SECRET=your_jwt_secret
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret

# Blockchain
POLYGON_RPC_URL=https://rpc-mumbai.maticvigil.com
NEXUS_CONTRACT_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3

# Storage
IPFS_API_URL=https://ipfs.infura.io:5001
AWS_BUCKET_NAME=nexus-media
```

## Integration Architecture

### Smart Contract Integration
The `NexusCore.sol` contract provides:
- `createPost(string _content)` - Create social media post
- `mintPostAsNFT(uint256 _postId, string _tokenURI)` - Mint post as NFT

### Backend-Blockchain Integration
Backend handles:
- Web2 authentication (Google OAuth) + Web3 wallet auth
- Off-chain post storage with blockchain anchoring
- IPFS metadata management for NFTs
- Progressive Web3 adoption ("graduation path")

### Frontend-Backend Integration  
Frontend connects to:
- Backend API: `http://localhost:5000/api/`
- Web3 Provider: MetaMask/WalletConnect
- Smart Contract: via ethers.js

## Key Integration Points

### 1. Contract Address Management
After deploying smart contracts:
1. Update `NEXUS_CONTRACT_ADDRESS` in backend `.env`
2. Update contract address in frontend Web3 connection
3. Copy ABI from `artifacts/contracts/NexusCore.sol/NexusCore.json`

### 2. Authentication Flow
```javascript
// Dual authentication system
Web2 Flow: Google OAuth → JWT → Backend Access
Web3 Flow: Wallet Connect → Signature Verify → Backend Access  
Hybrid: Users can upgrade from Web2 to Web3 seamlessly
```

### 3. Content Progression
```javascript
// The "Graduation Path" implementation
1. Create off-chain post (Backend API)
2. Anchor to blockchain (Smart Contract + Backend)
3. Mint as NFT (Smart Contract + IPFS)
```

## Database Schema Key Points

- **Dual User System**: Supports both Web2 (Google) and Web3 (wallet) users
- **Post Evolution**: Posts can progress from `PUBLISHED` → `ANCHORED` → `MINTED`
- **DAO Features**: Communities with on-chain governance and proposals
- **Rate Limiting**: Built-in limits for free blockchain operations

## Testing Strategy

### Contract Testing
```powershell
cd nexus-contracts
npx hardhat test
```

### Backend Testing  
```powershell
cd nexus-backend
npm test
```

### Integration Testing
1. Deploy contracts to local Hardhat network
2. Start backend with local contract address
3. Start frontend and test complete user flows

## Common Development Tasks

### Adding New Smart Contract Functions
1. Modify `contracts/NexusCore.sol`
2. Run `npm run compile` in `nexus-contracts/`
3. Update backend integration in `nexus-backend/src/services/blockchain/`
4. Update frontend Web3 integration

### Adding New API Endpoints
1. Create route file in `nexus-backend/src/routes/`
2. Add route to `nexus-backend/src/server.js`
3. Update frontend API calls
4. Update authentication middleware if needed

### Deploying to Production
1. Deploy smart contracts to mainnet/polygon
2. Update environment variables with production addresses
3. Deploy backend to cloud provider
4. Deploy frontend to CDN/hosting service
5. Configure domain and SSL certificates

## Security Considerations

- **Private Keys**: Never commit private keys or mnemonic phrases
- **Environment Variables**: Use different `.env` files for different environments
- **Smart Contract Verification**: Always verify contracts on block explorers
- **Rate Limiting**: Backend includes built-in rate limiting for blockchain operations
- **Input Validation**: All API endpoints include comprehensive validation

## Blockchain Network Configuration

**Local Development:** Hardhat Network (Chain ID: 31337)
**Testnet:** Sepolia (recommended for testing)  
**Production:** Ethereum Mainnet or Polygon

Current deployed contract on local: `0x5FbDB2315678afecb367f032d93F642f64180aa3`

## File Structure Understanding

```
nexus-contracts/
├── contracts/NexusCore.sol          # Main smart contract
├── scripts/deploy.js                # Deployment script
├── artifacts/                       # Compiled contract artifacts (ABI here)
├── frontend/                        # React frontend
└── hardhat.config.js               # Hardhat configuration

nexus-backend/
├── src/
│   ├── server.js                   # Main server file
│   ├── routes/                     # API route handlers
│   ├── middleware/                 # Authentication & security
│   └── services/                   # Business logic
├── prisma/schema.prisma           # Database schema
└── package.json                   # Backend dependencies

```

The WARP.md file will be stored at the root of your project: `E:\Project Nexus\WARP.md`