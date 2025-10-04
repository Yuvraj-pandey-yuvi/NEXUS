// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Counters.sol";

contract NexusCore is ERC721URIStorage, Ownable {
    using Counters for Counters.Counter;
    Counters.Counter private _postIds;

    struct Post {
        uint256 id;
        address author;
        string content;
        uint256 timestamp;
        bool isNFT;
        uint256 tokenId;
    }

    mapping(uint256 => Post) public posts;
    event PostCreated(uint256 id, address indexed author, string content, uint256 timestamp);
    event PostMinted(uint256 indexed postId, uint256 indexed tokenId, address owner);

    constructor() ERC721("Nexus Content", "NEXUS") {}

    function createPost(string memory _content) external {
        _postIds.increment();
        uint256 newPostId = _postIds.current();
        posts[newPostId] = Post(newPostId, msg.sender, _content, block.timestamp, false, 0);
        emit PostCreated(newPostId, msg.sender, _content, block.timestamp);
    }

    function mintPostAsNFT(uint256 _postId, string memory _tokenURI) external {
        Post storage postToMint = posts[_postId];
        require(postToMint.author == msg.sender, "Only the author can mint");
        require(!postToMint.isNFT, "Already minted");

        uint256 newTokenId = _postId;
        postToMint.isNFT = true;
        postToMint.tokenId = newTokenId;
        _safeMint(msg.sender, newTokenId);
        _setTokenURI(newTokenId, _tokenURI);
        emit PostMinted(_postId, newTokenId, msg.sender);
    }
}