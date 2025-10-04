// Deploy script for NexusCore smart contract
// Usage: hardhat run scripts/deploy.js --network sepolia

const { ethers } = require("hardhat");

async function main() {
  console.log("🚀 Starting NexusCore deployment...");

  // Get the contract factory
  const NexusCore = await ethers.getContractFactory("NexusCore");
  
  // Deploy the contract
  console.log("📦 Deploying NexusCore contract...");
  const nexusCore = await NexusCore.deploy();
  
  // Wait for deployment to complete
  await nexusCore.deployed();

  console.log("✅ NexusCore deployed successfully!");
  console.log(`📍 Contract address: ${nexusCore.address}`);
  console.log(`🔗 Transaction hash: ${nexusCore.deployTransaction.hash}`);
  
  // Save deployment info
  const deploymentInfo = {
    contractAddress: nexusCore.address,
    transactionHash: nexusCore.deployTransaction.hash,
    deployedAt: new Date().toISOString(),
    network: await nexusCore.provider.getNetwork()
  };

  console.log("\n📋 Deployment Summary:");
  console.log("====================");
  console.log(`Contract Name: NexusCore`);
  console.log(`Contract Address: ${deploymentInfo.contractAddress}`);
  console.log(`Transaction Hash: ${deploymentInfo.transactionHash}`);
  console.log(`Network: ${deploymentInfo.network.name} (Chain ID: ${deploymentInfo.network.chainId})`);
  console.log(`Deployed At: ${deploymentInfo.deployedAt}`);
  
  console.log("\n🎯 Next Steps:");
  console.log("1. Save the contract address above");
  console.log("2. Verify the contract on Etherscan (if applicable)");
  console.log("3. Update frontend with the new contract address");
  console.log("4. Update backend API with the new contract address");

  return deploymentInfo;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:");
    console.error(error);
    process.exit(1);
  });
