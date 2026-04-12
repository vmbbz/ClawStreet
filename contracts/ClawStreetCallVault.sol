// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

contract ClawStreetCallVault is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    ReentrancyGuard
{
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    struct CallOption {
        address writer;      // agent writing the call
        address buyer;       // agent buying the call
        address underlying;  // token or NFT floor synthetic
        uint256 amount;      // amount of underlying locked
        uint256 strike;      // total cost in premiumToken to exercise
        uint256 expiry;      // timestamp
        uint256 premium;     // cost to buy option
        bool exercised;
        bool active;
    }

    mapping(uint256 => CallOption) public options;
    uint256 public optionCounter;
    IERC20 public premiumToken; // e.g. USDC

    event OptionWritten(uint256 indexed optionId, address indexed writer, uint256 amount, uint256 strike, uint256 premium);
    event OptionBought(uint256 indexed optionId, address indexed buyer);
    event OptionExercised(uint256 indexed optionId, address indexed buyer);
    event OptionCancelled(uint256 indexed optionId);
    event UnderlyingReclaimed(uint256 indexed optionId);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _premiumToken) public initializer {

        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(UPGRADER_ROLE, msg.sender);

        premiumToken = IERC20(_premiumToken);
    }

    function writeCoveredCall(
        address underlying,
        uint256 amount,
        uint256 strike,
        uint256 expiry,
        uint256 premium
    ) external nonReentrant returns (uint256) {
        require(expiry > block.timestamp, "Expiry must be in future");
        require(amount > 0, "Amount must be > 0");
        require(strike > 0, "Strike must be > 0");
        require(premium > 0, "Premium must be > 0");

        // Lock underlying asset
        require(IERC20(underlying).transferFrom(msg.sender, address(this), amount), "Underlying transfer failed");

        uint256 optionId = optionCounter++;
        options[optionId] = CallOption({
            writer: msg.sender,
            buyer: address(0),
            underlying: underlying,
            amount: amount,
            strike: strike,
            expiry: expiry,
            premium: premium,
            exercised: false,
            active: true
        });

        emit OptionWritten(optionId, msg.sender, amount, strike, premium);
        return optionId;
    }

    function cancelOption(uint256 optionId) external nonReentrant {
        CallOption storage option = options[optionId];
        require(option.active && option.buyer == address(0), "Cannot cancel");
        require(msg.sender == option.writer, "Not writer");

        // Return underlying to writer
        require(IERC20(option.underlying).transfer(option.writer, option.amount), "Transfer failed");

        option.active = false;
        emit OptionCancelled(optionId);
    }

    function buyOption(uint256 optionId) external nonReentrant {
        CallOption storage option = options[optionId];
        require(option.active && option.buyer == address(0), "Not available");
        require(block.timestamp < option.expiry, "Expired");

        // Transfer premium to writer
        require(premiumToken.transferFrom(msg.sender, option.writer, option.premium), "Premium transfer failed");

        option.buyer = msg.sender;
        emit OptionBought(optionId, msg.sender);
    }

    function exercise(uint256 optionId) external nonReentrant {
        CallOption storage option = options[optionId];
        require(option.buyer == msg.sender, "Not buyer");
        require(!option.exercised, "Already exercised");
        require(block.timestamp < option.expiry, "Expired");

        // Settlement logic: Buyer pays strike price to writer
        require(premiumToken.transferFrom(msg.sender, option.writer, option.strike), "Strike transfer failed");

        // Buyer receives underlying
        require(IERC20(option.underlying).transfer(msg.sender, option.amount), "Underlying transfer failed");

        option.exercised = true;
        option.active = false;
        emit OptionExercised(optionId, msg.sender);
    }

    function reclaimUnderlying(uint256 optionId) external nonReentrant {
        CallOption storage option = options[optionId];
        require(msg.sender == option.writer, "Not writer");
        require(block.timestamp > option.expiry, "Not expired");
        require(!option.exercised, "Already exercised");
        require(option.active, "Not active");

        // Return underlying to writer
        require(IERC20(option.underlying).transfer(option.writer, option.amount), "Transfer failed");

        option.active = false;
        emit UnderlyingReclaimed(optionId);
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
