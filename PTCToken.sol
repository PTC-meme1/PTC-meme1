// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title PTC Meme Token
 * @dev Optimized meme token with monthly trading restrictions and minimal tax
 */
contract PTCToken {
    string public constant name = "PTC";
    string public constant symbol = "PTC";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isExcludedFromFees;
    mapping(address => bool) public isExcludedFromRestrictions;
    
    address public owner;
    address public liquidityPool;
    address public immutable devWallet;
    
    uint256 public launchTime;
    uint256 private constant SNIPER_PROTECTION_TIME = 2 days;
    uint256 private constant SECONDS_PER_DAY = 86400;
    
    // Transaction limits
    uint256 public maxTxAmount;
    uint256 public maxWalletAmount;
    
    // Tax settings (in basis points: 10000 = 100%)
    uint256 public buyTax = 8;  // 0.08%
    uint256 public sellTax = 8; // 0.08%
    uint256 private constant BURN_PERCENTAGE = 3750; // 37.5% of tax = 0.03%
    
    bool public tradingEnabled;
    
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Burn(address indexed from, uint256 value);
    event TradingEnabled(uint256 timestamp);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }
    
    constructor(uint256 _initialSupply, address _devWallet) {
        require(_devWallet != address(0), "Invalid dev wallet");
        
        owner = msg.sender;
        devWallet = _devWallet;
        
        // Default 1 billion tokens if 0 is passed
        uint256 supply = _initialSupply == 0 ? 1000000000 : _initialSupply;
        totalSupply = supply * 10 ** uint256(decimals);
        balanceOf[msg.sender] = totalSupply;
        
        // Set limits: 1% per tx, 2% max wallet
        maxTxAmount = totalSupply / 100;
        maxWalletAmount = (totalSupply * 2) / 100;
        
        // Exclude from fees and restrictions
        isExcludedFromFees[msg.sender] = true;
        isExcludedFromFees[_devWallet] = true;
        isExcludedFromRestrictions[msg.sender] = true;
        
        emit Transfer(address(0), msg.sender, totalSupply);
    }
    
    /**
     * @dev Simplified check: if day of month is 1-7, selling is prohibited
     * Uses 30-day cycle approximation for gas efficiency
     */
    function isNoSellPeriod() public view returns (bool) {
        if (!tradingEnabled) return false;
        
        uint256 daysSinceEpoch = block.timestamp / SECONDS_PER_DAY;
        uint256 dayOfMonth = (daysSinceEpoch % 30) + 1;
        
        return dayOfMonth <= 7;
    }
    
    function enableTrading() external onlyOwner {
        require(!tradingEnabled, "Already enabled");
        tradingEnabled = true;
        launchTime = block.timestamp;
        emit TradingEnabled(block.timestamp);
    }
    
    function setLiquidityPool(address _pool) external onlyOwner {
        require(_pool != address(0), "Invalid pool");
        liquidityPool = _pool;
        isExcludedFromFees[_pool] = true;
    }
    
    function transfer(address _to, uint256 _value) external returns (bool) {
        _transfer(msg.sender, _to, _value);
        return true;
    }
    
    function _transfer(address _from, address _to, uint256 _value) private {
        require(_to != address(0), "Invalid address");
        require(balanceOf[_from] >= _value, "Insufficient balance");
        
        // Trading enabled check
        if (!tradingEnabled) {
            require(_from == owner, "Trading not enabled");
        }
        
        bool isExcluded = isExcludedFromRestrictions[_from] || isExcludedFromRestrictions[_to];
        
        // Anti-sniper: first 2 days no buying
        if (!isExcluded && tradingEnabled && block.timestamp < launchTime + SNIPER_PROTECTION_TIME) {
            require(_from != liquidityPool, "Anti-sniper active");
        }
        
        // Monthly no-sell period (1st-7th)
        if (!isExcluded && isNoSellPeriod() && _to == liquidityPool) {
            revert("No selling on days 1-7");
        }
        
        // Anti-whale limits
        bool isFeesExcluded = isExcludedFromFees[_from] || isExcludedFromFees[_to];
        if (!isFeesExcluded) {
            require(_value <= maxTxAmount, "Exceeds max tx");
            if (_from == liquidityPool) {
                require(balanceOf[_to] + _value <= maxWalletAmount, "Exceeds max wallet");
            }
        }
        
        uint256 taxAmount;
        
        // Calculate tax
        if (!isFeesExcluded && liquidityPool != address(0)) {
            if (_from == liquidityPool) {
                taxAmount = (_value * buyTax) / 10000;
            } else if (_to == liquidityPool) {
                taxAmount = (_value * sellTax) / 10000;
            }
        }
        
        uint256 amountAfterTax = _value - taxAmount;
        
        // Execute transfer
        balanceOf[_from] -= _value;
        balanceOf[_to] += amountAfterTax;
        emit Transfer(_from, _to, amountAfterTax);
        
        // Distribute tax: 0.03% burn, 0.05% dev
        if (taxAmount > 0) {
            uint256 burnShare = (taxAmount * BURN_PERCENTAGE) / 10000;
            uint256 devShare = taxAmount - burnShare;
            
            balanceOf[devWallet] += devShare;
            totalSupply -= burnShare;
            
            emit Transfer(_from, devWallet, devShare);
            emit Transfer(_from, address(0), burnShare);
            emit Burn(_from, burnShare);
        }
    }
    
    function approve(address _spender, uint256 _value) external returns (bool) {
        require(_spender != address(0), "Invalid spender");
        allowance[msg.sender][_spender] = _value;
        emit Approval(msg.sender, _spender, _value);
        return true;
    }
    
    function transferFrom(address _from, address _to, uint256 _value) external returns (bool) {
        uint256 currentAllowance = allowance[_from][msg.sender];
        require(currentAllowance >= _value, "Allowance exceeded");
        
        allowance[_from][msg.sender] = currentAllowance - _value;
        _transfer(_from, _to, _value);
        return true;
    }
    
    function setTaxes(uint256 _buyTax, uint256 _sellTax) external onlyOwner {
        require(_buyTax <= 1000 && _sellTax <= 1000, "Tax max 10%");
        buyTax = _buyTax;
        sellTax = _sellTax;
    }
    
    function setLimits(uint256 _maxTxBasisPoints, uint256 _maxWalletBasisPoints) external onlyOwner {
        require(_maxTxBasisPoints >= 10 && _maxWalletBasisPoints >= 20, "Too restrictive");
        maxTxAmount = (totalSupply * _maxTxBasisPoints) / 10000;
        maxWalletAmount = (totalSupply * _maxWalletBasisPoints) / 10000;
    }
    
    function excludeFromFees(address _account, bool _excluded) external onlyOwner {
        isExcludedFromFees[_account] = _excluded;
    }
    
    function excludeFromRestrictions(address _account, bool _excluded) external onlyOwner {
        isExcludedFromRestrictions[_account] = _excluded;
    }
    
    function mint(address _to, uint256 _value) external onlyOwner {
        require(_to != address(0), "Invalid address");
        
        totalSupply += _value;
        balanceOf[_to] += _value;
        
        // Update limits
        maxTxAmount = totalSupply / 100;
        maxWalletAmount = (totalSupply * 2) / 100;
        
        emit Transfer(address(0), _to, _value);
    }
    
    function burn(uint256 _value) external {
        require(balanceOf[msg.sender] >= _value, "Insufficient balance");
        balanceOf[msg.sender] -= _value;
        totalSupply -= _value;
        emit Burn(msg.sender, _value);
        emit Transfer(msg.sender, address(0), _value);
    }
    
    function renounceOwnership() external onlyOwner {
        address oldOwner = owner;
        owner = address(0);
        emit OwnershipTransferred(oldOwner, address(0));
    }
    
    // View functions
    function getCirculatingSupply() external view returns (uint256) {
        return totalSupply;
    }
    
    function isAntiSniperActive() external view returns (bool) {
        return tradingEnabled && block.timestamp < launchTime + SNIPER_PROTECTION_TIME;
    }
    
    function getCurrentDayOfMonth() external view returns (uint256) {
        uint256 daysSinceEpoch = block.timestamp / SECONDS_PER_DAY;
        return (daysSinceEpoch % 30) + 1;
    }
}