// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @dev Simple mintable NFT for Base Sepolia testing.
///      Owner can mint to any agent address.
contract ClawStreetTestNFT is ERC721, Ownable {
    uint256 public nextId = 1;

    constructor(address initialOwner)
        ERC721("ClawStreet Test NFT", "CSNFT")
        Ownable(initialOwner)
    {}

    function mint(address to) external onlyOwner returns (uint256 tokenId) {
        tokenId = nextId++;
        _safeMint(to, tokenId);
    }

    function mintBatch(address to, uint256 count) external onlyOwner {
        for (uint256 i = 0; i < count; i++) {
            _safeMint(to, nextId++);
        }
    }
}

contract DeployMockNFT is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        ClawStreetTestNFT nft = new ClawStreetTestNFT(deployer);

        console.log("ClawStreetTestNFT deployed:", address(nft));
        console.log("Owner:", deployer);
        console.log("Paste this address into config/base-sepolia.json -> nfts.MockNFT.address");

        vm.stopBroadcast();
    }
}
