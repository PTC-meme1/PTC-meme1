// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title PTC Token - Ultra Secure Meme Token
 * @dev Multi-sig protection, anti-hack mechanisms, time-locks
 */
contract PTCToken {
    string public constant name = "PTC";
    string public constant symbol = "PTC";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    
    // Access control - DEV LIST
    address[4] public devWallets;
    uint8 public devWalletCount;
    mapping(address => bool) public isDevWallet;
    mapping(address => uint256) public devAddedTime; // Anti-hack: 288h timeout for new devs
    mapping(address => bool) public isInitialDev; // No timeout for initial 4 devs
    
    // Blacklist
    mapping(address => bool) public isBlacklisted;
    
    address public liquidityPool;
    uint256 public launchTime;
    
    // Reentrancy guard
    uint256 private _status = 1;
    
    // Pause mechanism
    uint256 public pauseEndTime;
    bool public isPaused;
    
    // P1/P2 mechanism for critical operations
    uint256 public p1StartTime;
    uint256 public p2StartTime;
    bool public p1Active;
    bool public p2Active;
    
    // Multi-sig for dev operations (requires 2 signatures)
    struct DevProposal {
        address targetAddress;
        bool isAddition; // true = add, false = remove
        address proposer;
        address confirmer;
        bool executed;
        uint256 proposedTime;
    }
    mapping(uint256 => DevProposal) public devProposals;
    uint256 public devProposalCount;
    
    // Multi-sig for blacklist removal (requires 2 signatures)
    struct BlacklistRemovalProposal {
        address targetAddress;
        address proposer;
        address confirmer;
        bool executed;
        uint256 proposedTime;
    }
    mapping(uint256 => BlacklistRemovalProposal) public blacklistProposals;
    uint256 public blacklistProposalCount;
    
    // Anti-hack: Track last transaction per dev per day
    mapping(address => uint256) public lastTxDay;
    mapping(address => bool) public firstTxOfDayDone;
    mapping(address => uint256) public lastTxTime; // For 6h timelock
    
    // Tax settings (in basis points: 10000 = 100%)
    uint256 public constant BUY_TAX = 8;  // 0.08%
    uint256 public constant SELL_TAX = 8; // 0.08%
    uint256 private constant BURN_PERCENTAGE = 3750; // 37.5% of tax = 0.03%
    
    bool public tradingEnabled;
    
    // Constants
    uint256 private constant SECONDS_PER_DAY = 86400;
    uint256 private constant PAUSE_DURATION = 72 hours;
    uint256 private constant P1_DURATION = 72 hours;
    uint256 private constant P2_DURATION = 72 hours;
    uint256 private constant NEW_DEV_TIMEOUT = 288 hours; // 12 days
    uint256 private constant DEV_TIMELOCK = 6 hours;
    uint256 private constant DAY_7 = 7 days;
    uint256 private constant YEAR_1 = 365 days;
    
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Burn(address indexed from, uint256 value);
    event TradingEnabled(uint256 timestamp);
    event PauseStarted(uint256 endTime);
    event PauseEnded(uint256 timestamp);
    event P1Started(uint256 timestamp);
    event P2Started(uint256 timestamp);
    event DevProposed(uint256 proposalId, address target, bool isAddition);
    event DevConfirmed(uint256 proposalId);
    event DevExecuted(uint256 proposalId);
    event Blacklisted(address indexed account);
    event BlacklistRemovalProposed(uint256 proposalId, address target);
    event BlacklistRemovalConfirmed(uint256 proposalId);
    event RemovedFromBlacklist(address indexed account);
    
    modifier nonReentrant() {
        require(_status == 1, "Reentrancy detected");
        _status = 2;
        _;
        _status = 1;
    }
    
    modifier onlyDev() {
        require(isDevWallet[msg.sender], "Not dev wallet");
        require(!isBlacklisted[msg.sender], "Dev is blacklisted");
        
        // Check timeout only for non-initial devs
        if (!isInitialDev[msg.sender]) {
            require(
                devAddedTime[msg.sender] == 0 || 
                block.timestamp >= devAddedTime[msg.sender] + NEW_DEV_TIMEOUT,
                "New dev timeout active"
            );
        }
        _;
    }
    
    modifier whenNotPaused() {
        require(!isPaused || block.timestamp >= pauseEndTime, "Contract paused");
        if (isPaused && block.timestamp >= pauseEndTime) {
            isPaused = false;
        }
        _;
    }
    
    constructor(address[4] memory _initialDevs) {
        require(_initialDevs[0] != address(0), "First dev required");
        
        // Initial supply: 1 billion tokens
        totalSupply = 1000000000 * 10 ** uint256(decimals);
        
        // Distribution: 60% to first dev, 40% to deployer (for liquidity)
        uint256 devAmount = (totalSupply * 60) / 100;
        uint256 liquidityAmount = totalSupply - devAmount;
        
        balanceOf[_initialDevs[0]] = devAmount;
        balanceOf[msg.sender] = liquidityAmount;
        
        // Add initial dev wallets (up to 4, no timeout)
        for (uint8 i = 0; i < 4; i++) {
            if (_initialDevs[i] != address(0)) {
                devWallets[i] = _initialDevs[i];
                isDevWallet[_initialDevs[i]] = true;
                isInitialDev[_initialDevs[i]] = true; // No timeout for initial devs
                devWalletCount++;
            }
        }
        
        require(devWalletCount > 0, "At least one dev required");
        
        emit Transfer(address(0), _initialDevs[0], devAmount);
        emit Transfer(address(0), msg.sender, liquidityAmount);
    }
    
    /**
     * @dev Check if operations are allowed based on pause/P1/P2 state
     */
    function canRemoveFromBlacklist() public view returns (bool) {
        // Can remove from blacklist only when NOT paused AND P1/P2 completed
        bool notPaused = !isPaused || block.timestamp >= pauseEndTime;
        bool p1p2Complete = p1Active && p2Active && 
                           block.timestamp >= p1StartTime + P1_DURATION &&
                           block.timestamp >= p2StartTime + P2_DURATION;
        return notPaused && p1p2Complete;
    }
    
    function canAddToDevList() public view returns (bool) {
        // Can add to dev list only when paused AND P1/P2 completed
        bool paused = isPaused && block.timestamp < pauseEndTime;
        bool p1p2Complete = p1Active && p2Active && 
                           block.timestamp >= p1StartTime + P1_DURATION &&
                           block.timestamp >= p2StartTime + P2_DURATION;
        return paused && p1p2Complete;
    }
    
    function canRemoveFromDevList() public view returns (bool) {
        // Can remove from dev list only when NOT paused AND P1/P2 completed
        bool notPaused = !isPaused || block.timestamp >= pauseEndTime;
        bool p1p2Complete = p1Active && p2Active && 
                           block.timestamp >= p1StartTime + P1_DURATION &&
                           block.timestamp >= p2StartTime + P2_DURATION;
        return notPaused && p1p2Complete;
    }
    
    /**
     * @dev Get current day since epoch for anti-hack protection
     */
    function getCurrentDay() public view returns (uint256) {
        return block.timestamp / SECONDS_PER_DAY;
    }
    
    /**
     * @dev Get first available dev wallet (for tax distribution)
     */
    function getFirstAvailableDev() public view returns (address) {
        for (uint8 i = 0; i < devWalletCount; i++) {
            if (devWallets[i] != address(0)) {
                return devWallets[i];
            }
        }
        return address(0);
    }
    
    /**
     * @dev Get max transaction amount for an address
     */
    function getMaxTxAmount(address _addr) public view returns (uint256) {
        if (!tradingEnabled) return 0;
        
        uint256 timeSinceLaunch = block.timestamp - launchTime;
        
        if (isDevWallet[_addr]) {
            // DEV limits
            if (timeSinceLaunch < DAY_7) {
                return 1000000 * 10 ** decimals; // 1M tokens before day 7
            } else {
                return 100000 * 10 ** decimals; // 100K tokens after day 7
            }
        } else {
            // NON-DEV limits
            if (timeSinceLaunch < DAY_7) {
                return 0; // Blocked before day 7
            } else if (timeSinceLaunch < YEAR_1) {
                return 40000 * 10 ** decimals; // 40K tokens days 7-365
            } else {
                return 20000 * 10 ** decimals; // 20K tokens after year 1
            }
        }
    }
    
    /**
     * @dev Get effective max tx for a transfer (minimum of sender and receiver limits)
     */
    function getEffectiveMaxTx(address _from, address _to) public view returns (uint256) {
        uint256 fromMax = getMaxTxAmount(_from);
        uint256 toMax = getMaxTxAmount(_to);
        return fromMax < toMax ? fromMax : toMax;
    }
    
    /**
     * @dev Enable trading (can only be called once)
     */
    function enableTrading() external onlyDev {
        require(!tradingEnabled, "Already enabled");
        tradingEnabled = true;
        launchTime = block.timestamp;
        emit TradingEnabled(block.timestamp);
    }
    
    /**
     * @dev Set liquidity pool address
     */
    function setLiquidityPool(address _pool) external onlyDev {
        require(_pool != address(0), "Invalid pool");
        liquidityPool = _pool;
    }
    
    /**
     * @dev Start 72h pause - blocks all transfers and trading
     * During pause:
     * - FORBIDDEN: Remove from blacklist, Remove from dev list
     * - ALLOWED: Add to blacklist, Add to dev list (with P1/P2)
     */
    function startPause() external onlyDev {
        pauseEndTime = block.timestamp + PAUSE_DURATION;
        isPaused = true;
        emit PauseStarted(pauseEndTime);
    }
    
    /**
     * @dev Start P1 period (72h waiting period)
     */
    function startP1() external onlyDev {
        p1StartTime = block.timestamp;
        p1Active = true;
        emit P1Started(block.timestamp);
    }
    
    /**
     * @dev Start P2 period (additional 72h waiting period)
     */
    function startP2() external onlyDev {
        require(p1Active, "P1 not started");
        require(block.timestamp >= p1StartTime + P1_DURATION, "P1 not completed");
        p2StartTime = block.timestamp;
        p2Active = true;
        emit P2Started(block.timestamp);
    }
    
    /**
     * @dev Reset P1/P2 after operation is executed
     */
    function resetP1P2() internal {
        p1Active = false;
        p2Active = false;
        p1StartTime = 0;
        p2StartTime = 0;
    }
    
    /**
     * @dev Add address to blacklist (can be done anytime by any dev, even during pause)
     */
    function addToBlacklist(address _addr) external onlyDev {
        require(_addr != address(0), "Invalid address");
        require(!isDevWallet[_addr], "Cannot blacklist dev");
        isBlacklisted[_addr] = true;
        emit Blacklisted(_addr);
    }
    
    /**
     * @dev MULTI-SIG STEP 1: Propose removing address from blacklist
     * Requires: NOT paused AND P1/P2 completed
     */
    function proposeRemoveFromBlacklist(address _addr) external onlyDev returns (uint256) {
        require(canRemoveFromBlacklist(), "Cannot remove: paused or P1/P2 not done");
        require(isBlacklisted[_addr], "Not blacklisted");
        
        uint256 proposalId = blacklistProposalCount++;
        blacklistProposals[proposalId] = BlacklistRemovalProposal({
            targetAddress: _addr,
            proposer: msg.sender,
            confirmer: address(0),
            executed: false,
            proposedTime: block.timestamp
        });
        
        emit BlacklistRemovalProposed(proposalId, _addr);
        return proposalId;
    }
    
    /**
     * @dev MULTI-SIG STEP 2: Confirm and execute blacklist removal
     * Requires: 2 different dev signatures
     */
    function confirmRemoveFromBlacklist(uint256 _proposalId) external onlyDev {
        BlacklistRemovalProposal storage proposal = blacklistProposals[_proposalId];
        
        require(!proposal.executed, "Already executed");
        require(proposal.proposer != address(0), "Invalid proposal");
        require(proposal.proposer != msg.sender, "Cannot confirm own proposal");
        require(proposal.confirmer == address(0), "Already confirmed");
        
        proposal.confirmer = msg.sender;
        emit BlacklistRemovalConfirmed(_proposalId);
        
        // Execute removal
        isBlacklisted[proposal.targetAddress] = false;
        proposal.executed = true;
        resetP1P2(); // Reset P1/P2 after execution
        
        emit RemovedFromBlacklist(proposal.targetAddress);
    }
    
    /**
     * @dev MULTI-SIG STEP 1: Propose adding a new dev wallet
     * Requires: Paused AND P1/P2 completed
     */
    function proposeAddDev(address _newDev) external onlyDev returns (uint256) {
        require(_newDev != address(0), "Invalid address");
        require(!isDevWallet[_newDev], "Already dev");
        require(devWalletCount < 4, "Max 4 devs");
        require(canAddToDevList(), "Cannot add: not paused or P1/P2 not done");
        
        uint256 proposalId = devProposalCount++;
        devProposals[proposalId] = DevProposal({
            targetAddress: _newDev,
            isAddition: true,
            proposer: msg.sender,
            confirmer: address(0),
            executed: false,
            proposedTime: block.timestamp
        });
        
        emit DevProposed(proposalId, _newDev, true);
        return proposalId;
    }
    
    /**
     * @dev MULTI-SIG STEP 1: Propose removing a dev wallet
     * Requires: NOT paused AND P1/P2 completed
     */
    function proposeRemoveDev(address _devToRemove) external onlyDev returns (uint256) {
        require(isDevWallet[_devToRemove], "Not a dev");
        require(devWalletCount > 1, "Cannot remove last dev");
        require(canRemoveFromDevList(), "Cannot remove: paused or P1/P2 not done");
        
        uint256 proposalId = devProposalCount++;
        devProposals[proposalId] = DevProposal({
            targetAddress: _devToRemove,
            isAddition: false,
            proposer: msg.sender,
            confirmer: address(0),
            executed: false,
            proposedTime: block.timestamp
        });
        
        emit DevProposed(proposalId, _devToRemove, false);
        return proposalId;
    }
    
    /**
     * @dev MULTI-SIG STEP 2: Confirm and execute dev operation
     * Requires: 2 different dev signatures
     */
    function confirmDevProposal(uint256 _proposalId) external onlyDev {
        DevProposal storage proposal = devProposals[_proposalId];
        
        require(!proposal.executed, "Already executed");
        require(proposal.proposer != address(0), "Invalid proposal");
        require(proposal.proposer != msg.sender, "Cannot confirm own proposal");
        require(proposal.confirmer == address(0), "Already confirmed");
        
        proposal.confirmer = msg.sender;
        emit DevConfirmed(_proposalId);
        
        // Execute immediately after confirmation
        if (proposal.isAddition) {
            // Add dev with 288h timeout
            devWallets[devWalletCount] = proposal.targetAddress;
            devWalletCount++;
            isDevWallet[proposal.targetAddress] = true;
            isInitialDev[proposal.targetAddress] = false; // Not initial dev
            devAddedTime[proposal.targetAddress] = block.timestamp; // 288h timeout starts
        } else {
            // Remove dev
            _removeDevFromArray(proposal.targetAddress);
            isDevWallet[proposal.targetAddress] = false;
            isInitialDev[proposal.targetAddress] = false;
            delete devAddedTime[proposal.targetAddress];
        }
        
        proposal.executed = true;
        resetP1P2(); // Reset P1/P2 after execution
        emit DevExecuted(_proposalId);
    }
    
    /**
     * @dev Internal function to remove dev from array
     */
    function _removeDevFromArray(address _dev) private {
        for (uint8 i = 0; i < devWalletCount; i++) {
            if (devWallets[i] == _dev) {
                devWallets[i] = devWallets[devWalletCount - 1];
                devWallets[devWalletCount - 1] = address(0);
                devWalletCount--;
                break;
            }
        }
    }
    
    /**
     * @dev Transfer tokens
     */
    function transfer(address _to, uint256 _value) external nonReentrant returns (bool) {
        _transfer(msg.sender, _to, _value);
        return true;
    }
    
    /**
     * @dev Internal transfer with all security checks
     */
    function _transfer(address _from, address _to, uint256 _value) private whenNotPaused {
        require(_to != address(0), "Invalid address");
        require(balanceOf[_from] >= _value, "Insufficient balance");
        require(!isBlacklisted[_from] && !isBlacklisted[_to], "Blacklisted");
        
        // Trading enabled check
        if (!tradingEnabled) {
            require(isDevWallet[_from], "Trading not enabled");
        }
        
        bool fromIsDev = isDevWallet[_from];
        bool toIsDev = isDevWallet[_to];
        
        // NON-DEV: Block before day 7
        if (!fromIsDev && !toIsDev) {
            require(block.timestamp >= launchTime + DAY_7, "Non-dev blocked before day 7");
        }
        if (!fromIsDev && toIsDev) {
            require(block.timestamp >= launchTime + DAY_7, "Non-dev blocked before day 7");
        }
        if (fromIsDev && !toIsDev) {
            require(block.timestamp >= launchTime + DAY_7, "Non-dev blocked before day 7");
        }
        
        // DEV: Anti-hack first transaction of day must be <= 100 tokens
        if (fromIsDev && tradingEnabled) {
            uint256 currentDay = getCurrentDay();
            
            if (lastTxDay[_from] != currentDay) {
                // New day - reset flag
                lastTxDay[_from] = currentDay;
                firstTxOfDayDone[_from] = false;
            }
            
            if (!firstTxOfDayDone[_from]) {
                require(_value <= 100 * 10 ** decimals, "First tx of day max 100 tokens");
                firstTxOfDayDone[_from] = true;
            }
            
            // DEV: 6h timelock after day 7
            if (block.timestamp >= launchTime + DAY_7) {
                require(
                    block.timestamp >= lastTxTime[_from] + DEV_TIMELOCK,
                    "Dev timelock: wait 6h"
                );
            }
            
            lastTxTime[_from] = block.timestamp;
        }
        
        // Transaction limits (effective = min of sender and receiver limits)
        uint256 maxTx = getEffectiveMaxTx(_from, _to);
        require(_value <= maxTx, "Exceeds max tx amount");
        
        // Calculate tax
        uint256 taxAmount = 0;
        bool isBuy = _from == liquidityPool;
        bool isSell = _to == liquidityPool;
        
        if ((isBuy || isSell) && liquidityPool != address(0)) {
            // DEV wallets are fee-free
            if (!fromIsDev && !toIsDev) {
                if (isBuy) {
                    taxAmount = (_value * BUY_TAX) / 10000;
                } else if (isSell) {
                    taxAmount = (_value * SELL_TAX) / 10000;
                }
            }
        }
        
        uint256 amountAfterTax = _value - taxAmount;
        
        // Execute transfer
        balanceOf[_from] -= _value;
        balanceOf[_to] += amountAfterTax;
        emit Transfer(_from, _to, amountAfterTax);
        
        // Distribute tax: 37.5% burn, 62.5% to first available dev
        if (taxAmount > 0) {
            uint256 burnShare = (taxAmount * BURN_PERCENTAGE) / 10000;
            uint256 devShare = taxAmount - burnShare;
            
            address firstDev = getFirstAvailableDev();
            require(firstDev != address(0), "No dev available for tax");
            
            balanceOf[firstDev] += devShare;
            totalSupply -= burnShare;
            
            emit Transfer(_from, firstDev, devShare);
            emit Transfer(_from, address(0), burnShare);
            emit Burn(_from, burnShare);
        }
    }
    
    /**
     * @dev Approve spender
     */
    function approve(address _spender, uint256 _value) external returns (bool) {
        require(_spender != address(0), "Invalid spender");
        allowance[msg.sender][_spender] = _value;
        emit Approval(msg.sender, _spender, _value);
        return true;
    }
    
    /**
     * @dev Transfer from approved allowance
     */
    function transferFrom(address _from, address _to, uint256 _value) external nonReentrant returns (bool) {
        uint256 currentAllowance = allowance[_from][msg.sender];
        require(currentAllowance >= _value, "Allowance exceeded");
        
        allowance[_from][msg.sender] = currentAllowance - _value;
        _transfer(_from, _to, _value);
        return true;
    }
    
    /**
     * @dev Burn tokens
     */
    function burn(uint256 _value) external nonReentrant {
        require(balanceOf[msg.sender] >= _value, "Insufficient balance");
        balanceOf[msg.sender] -= _value;
        totalSupply -= _value;
        emit Burn(msg.sender, _value);
        emit Transfer(msg.sender, address(0), _value);
    }
    
    /**
     * @dev View: Get all dev wallets
     */
    function getDevWallets() external view returns (address[4] memory) {
        return devWallets;
    }
    
    /**
     * @dev View: Check if address can perform dev operations
     */
    function canDevOperate(address _dev) external view returns (bool) {
        if (!isDevWallet[_dev]) return false;
        if (isBlacklisted[_dev]) return false;
        
        // Initial devs have no timeout
        if (isInitialDev[_dev]) return true;
        
        // New devs must wait 288h
        if (devAddedTime[_dev] > 0 && block.timestamp < devAddedTime[_dev] + NEW_DEV_TIMEOUT) {
            return false;
        }
        return true;
    }
    
    /**
     * @dev View: Get time until dev can operate
     */
    function getDevTimeoutRemaining(address _dev) external view returns (uint256) {
        if (!isDevWallet[_dev]) return 0;
        if (isInitialDev[_dev]) return 0;
        if (devAddedTime[_dev] == 0) return 0;
        
        uint256 canOperateAt = devAddedTime[_dev] + NEW_DEV_TIMEOUT;
        if (block.timestamp >= canOperateAt) return 0;
        
        return canOperateAt - block.timestamp;
    }
    
    /**
     * @dev View: Get pause time remaining
     */
    function getPauseTimeRemaining() external view returns (uint256) {
        if (!isPaused) return 0;
        if (block.timestamp >= pauseEndTime) return 0;
        return pauseEndTime - block.timestamp;
    }
    
    /**
     * @dev View: Get P1 time remaining
     */
    function getP1TimeRemaining() external view returns (uint256) {
        if (!p1Active) return 0;
        uint256 endTime = p1StartTime + P1_DURATION;
        if (block.timestamp >= endTime) return 0;
        return endTime - block.timestamp;
    }
    
    /**
     * @dev View: Get P2 time remaining
     */
    function getP2TimeRemaining() external view returns (uint256) {
        if (!p2Active) return 0;
        uint256 endTime = p2StartTime + P2_DURATION;
        if (block.timestamp >= endTime) return 0;
        return endTime - block.timestamp;
    }
    
    /**
     * @dev View: Get time until next dev transaction allowed
     */
    function getDevNextTxTime(address _dev) external view returns (uint256) {
        if (!isDevWallet[_dev]) return 0;
        if (!tradingEnabled) return 0;
        if (block.timestamp < launchTime + DAY_7) return 0;
        
        uint256 nextTxTime = lastTxTime[_dev] + DEV_TIMELOCK;
        if (block.timestamp >= nextTxTime) return 0;
        
        return nextTxTime - block.timestamp;
    }
}