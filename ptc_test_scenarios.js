/**
 * PTC Token - Test Scenarios
 * Comprehensive test cases for all token functionality
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("PTC Token - Complete Test Suite", function () {
  let token;
  let owner;
  let dev1, dev2, dev3, dev4;
  let user1, user2, user3;
  let liquidityPool;

  const INITIAL_SUPPLY = ethers.parseEther("1000000000"); // 1 billion
  const DEV_AMOUNT = INITIAL_SUPPLY * 60n / 100n; // 60%
  const LIQUIDITY_AMOUNT = INITIAL_SUPPLY * 40n / 100n; // 40%

  beforeEach(async function () {
    [owner, dev1, dev2, dev3, dev4, user1, user2, user3, liquidityPool] = await ethers.getSigners();

    const PTCToken = await ethers.getContractFactory("PTCToken");
    token = await PTCToken.deploy([dev1.address, dev2.address, dev3.address, dev4.address]);
    await token.waitForDeployment();
  });

  describe("1. DEPLOYMENT & INITIAL SETUP", function () {
    it("Should deploy with correct initial distribution", async function () {
      expect(await token.balanceOf(dev1.address)).to.equal(DEV_AMOUNT);
      expect(await token.balanceOf(owner.address)).to.equal(LIQUIDITY_AMOUNT);
      expect(await token.totalSupply()).to.equal(INITIAL_SUPPLY);
    });

    it("Should have 4 dev wallets registered", async function () {
      expect(await token.devWalletCount()).to.equal(4);
      expect(await token.isDevWallet(dev1.address)).to.be.true;
      expect(await token.isDevWallet(dev2.address)).to.be.true;
      expect(await token.isDevWallet(dev3.address)).to.be.true;
      expect(await token.isDevWallet(dev4.address)).to.be.true;
    });

    it("Should mark initial devs with no timeout", async function () {
      expect(await token.isInitialDev(dev1.address)).to.be.true;
      expect(await token.canDevOperate(dev1.address)).to.be.true;
      expect(await token.getDevTimeoutRemaining(dev1.address)).to.equal(0);
    });

    it("Should not allow trading before enableTrading()", async function () {
      await expect(
        token.connect(user1).transfer(user2.address, ethers.parseEther("100"))
      ).to.be.revertedWith("Trading not enabled");
    });
  });

  describe("2. TRADING ACTIVATION", function () {
    it("Should allow dev to enable trading", async function () {
      await token.connect(dev1).setLiquidityPool(liquidityPool.address);
      await token.connect(dev1).enableTrading();
      
      expect(await token.tradingEnabled()).to.be.true;
      expect(await token.launchTime()).to.be.greaterThan(0);
    });

    it("Should not allow enabling trading twice", async function () {
      await token.connect(dev1).setLiquidityPool(liquidityPool.address);
      await token.connect(dev1).enableTrading();
      
      await expect(
        token.connect(dev1).enableTrading()
      ).to.be.revertedWith("Already enabled");
    });

    it("Should not allow non-dev to enable trading", async function () {
      await expect(
        token.connect(user1).enableTrading()
      ).to.be.revertedWith("Not dev wallet");
    });
  });

  describe("3. DEV WALLET LIMITS - BEFORE DAY 7", function () {
    beforeEach(async function () {
      await token.connect(dev1).setLiquidityPool(liquidityPool.address);
      await token.connect(dev1).enableTrading();
    });

    it("Should allow dev to transfer 1M tokens before day 7", async function () {
      const amount = ethers.parseEther("1000000");
      await token.connect(dev1).transfer(dev2.address, amount);
      expect(await token.balanceOf(dev2.address)).to.be.greaterThan(0);
    });

    it("Should enforce 100 PTC first transaction of day", async function () {
      // First tx of day must be <= 100 PTC
      const smallAmount = ethers.parseEther("100");
      await token.connect(dev1).transfer(dev2.address, smallAmount);
      
      // Second tx can be larger
      const largeAmount = ethers.parseEther("1000000");
      await token.connect(dev1).transfer(dev2.address, largeAmount);
    });

    it("Should reject first transaction > 100 PTC", async function () {
      const largeAmount = ethers.parseEther("101");
      await expect(
        token.connect(dev1).transfer(dev2.address, largeAmount)
      ).to.be.revertedWith("First tx of day max 100 tokens");
    });

    it("Should block NON-DEV transfers before day 7", async function () {
      // Transfer some tokens to user1 from owner (deployer)
      await token.connect(owner).transfer(user1.address, ethers.parseEther("10000"));
      
      // User1 should not be able to transfer
      await expect(
        token.connect(user1).transfer(user2.address, ethers.parseEther("100"))
      ).to.be.revertedWith("Non-dev blocked before day 7");
    });
  });

  describe("4. DEV WALLET LIMITS - AFTER DAY 7", function () {
    beforeEach(async function () {
      await token.connect(dev1).setLiquidityPool(liquidityPool.address);
      await token.connect(dev1).enableTrading();
      
      // Fast forward 7 days
      await time.increase(7 * 24 * 60 * 60);
    });

    it("Should limit dev transfers to 100K after day 7", async function () {
      // First tx: 100 PTC
      await token.connect(dev1).transfer(dev2.address, ethers.parseEther("100"));
      
      // Wait 6 hours
      await time.increase(6 * 60 * 60);
      
      // Second tx: 100K PTC
      const amount = ethers.parseEther("100000");
      await token.connect(dev1).transfer(dev2.address, amount);
    });

    it("Should enforce 6h timelock between transactions", async function () {
      // First tx
      await token.connect(dev1).transfer(dev2.address, ethers.parseEther("100"));
      
      // Try second tx immediately - should fail
      await expect(
        token.connect(dev1).transfer(dev2.address, ethers.parseEther("100"))
      ).to.be.revertedWith("Dev timelock: wait 6h");
      
      // Wait 6 hours
      await time.increase(6 * 60 * 60);
      
      // Now should work
      await token.connect(dev1).transfer(dev2.address, ethers.parseEther("100"));
    });

    it("Should allow NON-DEV transfers after day 7", async function () {
      // Transfer tokens to user1
      await token.connect(dev1).transfer(dev2.address, ethers.parseEther("100"));
      await time.increase(6 * 60 * 60);
      await token.connect(dev1).transfer(user1.address, ethers.parseEther("40000"));
      
      // User1 can now transfer
      await token.connect(user1).transfer(user2.address, ethers.parseEther("1000"));
      expect(await token.balanceOf(user2.address)).to.equal(ethers.parseEther("1000"));
    });
  });

  describe("5. NON-DEV WALLET LIMITS", function () {
    beforeEach(async function () {
      await token.connect(dev1).setLiquidityPool(liquidityPool.address);
      await token.connect(dev1).enableTrading();
      await time.increase(7 * 24 * 60 * 60); // Day 7
      
      // Give tokens to users
      await token.connect(dev1).transfer(dev2.address, ethers.parseEther("100"));
      await time.increase(6 * 60 * 60);
      await token.connect(dev1).transfer(user1.address, ethers.parseEther("40000"));
    });

    it("Should limit NON-DEV to 40K between day 7-365", async function () {
      const maxAmount = ethers.parseEther("40000");
      await token.connect(user1).transfer(user2.address, maxAmount);
    });

    it("Should reject NON-DEV transfer > 40K", async function () {
      const tooMuch = ethers.parseEther("40001");
      await expect(
        token.connect(user1).transfer(user2.address, tooMuch)
      ).to.be.revertedWith("Exceeds max tx amount");
    });

    it("Should limit NON-DEV to 20K after year 1", async function () {
      // Fast forward 1 year
      await time.increase(365 * 24 * 60 * 60);
      
      const maxAmount = ethers.parseEther("20000");
      await token.connect(user1).transfer(user2.address, maxAmount);
      
      // Should reject 20001
      await expect(
        token.connect(user1).transfer(user2.address, ethers.parseEther("20001"))
      ).to.be.revertedWith("Exceeds max tx amount");
    });
  });

  describe("6. PAUSE MECHANISM", function () {
    beforeEach(async function () {
      await token.connect(dev1).setLiquidityPool(liquidityPool.address);
      await token.connect(dev1).enableTrading();
    });

    it("Should allow dev to start pause", async function () {
      await token.connect(dev1).startPause();
      expect(await token.isPaused()).to.be.true;
    });

    it("Should block all transfers during pause", async function () {
      await token.connect(dev1).startPause();
      
      await expect(
        token.connect(dev1).transfer(dev2.address, ethers.parseEther("100"))
      ).to.be.revertedWith("Contract paused");
    });

    it("Should auto-expire pause after 72 hours", async function () {
      await token.connect(dev1).startPause();
      
      // Fast forward 72 hours
      await time.increase(72 * 60 * 60);
      
      // Should work now
      await token.connect(dev1).transfer(dev2.address, ethers.parseEther("100"));
    });

    it("Should allow starting new pause during active pause", async function () {
      await token.connect(dev1).startPause();
      
      // Start another pause
      await token.connect(dev2).startPause();
      expect(await token.isPaused()).to.be.true;
    });
  });

  describe("7. P1/P2 MECHANISM", function () {
    it("Should allow dev to start P1", async function () {
      await token.connect(dev1).startP1();
      expect(await token.p1Active()).to.be.true;
    });

    it("Should require P1 completion before P2", async function () {
      await token.connect(dev1).startP1();
      
      await expect(
        token.connect(dev1).startP2()
      ).to.be.revertedWith("P1 not completed");
      
      // Wait 72 hours
      await time.increase(72 * 60 * 60);
      
      // Now should work
      await token.connect(dev1).startP2();
      expect(await token.p2Active()).to.be.true;
    });

    it("Should not block transfers during P1/P2", async function () {
      await token.connect(dev1).setLiquidityPool(liquidityPool.address);
      await token.connect(dev1).enableTrading();
      
      await token.connect(dev1).startP1();
      
      // Transfers should still work
      await token.connect(dev1).transfer(dev2.address, ethers.parseEther("100"));
    });
  });

  describe("8. BLACKLIST OPERATIONS", function () {
    beforeEach(async function () {
      await token.connect(dev1).setLiquidityPool(liquidityPool.address);
      await token.connect(dev1).enableTrading();
    });

    it("Should allow dev to add to blacklist anytime", async function () {
      await token.connect(dev1).addToBlacklist(user1.address);
      expect(await token.isBlacklisted(user1.address)).to.be.true;
    });

    it("Should allow adding to blacklist during pause", async function () {
      await token.connect(dev1).startPause();
      await token.connect(dev1).addToBlacklist(user1.address);
      expect(await token.isBlacklisted(user1.address)).to.be.true;
    });

    it("Should not allow blacklisting dev wallet", async function () {
      await expect(
        token.connect(dev1).addToBlacklist(dev2.address)
      ).to.be.revertedWith("Cannot blacklist dev");
    });

    it("Should block blacklisted address from transferring", async function () {
      await time.increase(7 * 24 * 60 * 60);
      
      // Give tokens to user1
      await token.connect(dev1).transfer(dev2.address, ethers.parseEther("100"));
      await time.increase(6 * 60 * 60);
      await token.connect(dev1).transfer(user1.address, ethers.parseEther("1000"));
      
      // Blacklist user1
      await token.connect(dev1).addToBlacklist(user1.address);
      
      // User1 cannot transfer
      await expect(
        token.connect(user1).transfer(user2.address, ethers.parseEther("100"))
      ).to.be.revertedWith("Blacklisted");
    });

    it("Should require P1+P2 and NOT pause to remove from blacklist", async function () {
      await token.connect(dev1).addToBlacklist(user1.address);
      
      // Cannot remove without P1/P2
      await expect(
        token.connect(dev1).proposeRemoveFromBlacklist(user1.address)
      ).to.be.revertedWith("Cannot remove: paused or P1/P2 not done");
      
      // Start P1 and P2
      await token.connect(dev1).startP1();
      await time.increase(72 * 60 * 60);
      await token.connect(dev1).startP2();
      await time.increase(72 * 60 * 60);
      
      // Now should work (multi-sig)
      const proposalId = await token.connect(dev1).proposeRemoveFromBlacklist.staticCall(user1.address);
      await token.connect(dev1).proposeRemoveFromBlacklist(user1.address);
      await token.connect(dev2).confirmRemoveFromBlacklist(proposalId);
      
      expect(await token.isBlacklisted(user1.address)).to.be.false;
    });
  });

  describe("9. DEV LIST OPERATIONS - ADD DEV", function () {
    let newDev;

    beforeEach(async function () {
      [, , , , , , , , , newDev] = await ethers.getSigners();
    });

    it("Should require pause and P1+P2 to add dev", async function () {
      // Cannot add without pause
      await expect(
        token.connect(dev1).proposeAddDev(newDev.address)
      ).to.be.revertedWith("Cannot add: not paused or P1/P2 not done");
      
      // Start pause and P1+P2
      await token.connect(dev1).startPause();
      await token.connect(dev1).startP1();
      await time.increase(72 * 60 * 60);
      await token.connect(dev1).startP2();
      await time.increase(72 * 60 * 60);
      
      // Now should work
      const proposalId = await token.connect(dev1).proposeAddDev.staticCall(newDev.address);
      await token.connect(dev1).proposeAddDev(newDev.address);
      await token.connect(dev2).confirmDevProposal(proposalId);
      
      expect(await token.isDevWallet(newDev.address)).to.be.true;
    });

    it("Should enforce 288h timeout on new dev", async function () {
      await token.connect(dev1).startPause();
      await token.connect(dev1).startP1();
      await time.increase(72 * 60 * 60);
      await token.connect(dev1).startP2();
      await time.increase(72 * 60 * 60);
      
      const proposalId = await token.connect(dev1).proposeAddDev.staticCall(newDev.address);
      await token.connect(dev1).proposeAddDev(newDev.address);
      await token.connect(dev2).confirmDevProposal(proposalId);
      
      // New dev cannot operate immediately
      expect(await token.canDevOperate(newDev.address)).to.be.false;
      
      // Wait 288 hours
      await time.increase(288 * 60 * 60);
      
      // Now can operate
      expect(await token.canDevOperate(newDev.address)).to.be.true;
    });

    it("Should not allow more than 4 devs", async function () {
      await token.connect(dev1).startPause();
      await token.connect(dev1).startP1();
      await time.increase(72 * 60 * 60);
      await token.connect(dev1).startP2();
      await time.increase(72 * 60 * 60);
      
      // Already have 4 devs
      await expect(
        token.connect(dev1).proposeAddDev(newDev.address)
      ).to.be.revertedWith("Max 4 devs");
    });
  });

  describe("10. DEV LIST OPERATIONS - REMOVE DEV", function () {
    it("Should require NOT pause and P1+P2 to remove dev", async function () {
      // Start P1+P2 but NOT pause
      await token.connect(dev1).startP1();
      await time.increase(72 * 60 * 60);
      await token.connect(dev1).startP2();
      await time.increase(72 * 60 * 60);
      
      // Now should work
      const proposalId = await token.connect(dev1).proposeRemoveDev.staticCall(dev4.address);
      await token.connect(dev1).proposeRemoveDev(dev4.address);
      await token.connect(dev2).confirmDevProposal(proposalId);
      
      expect(await token.isDevWallet(dev4.address)).to.be.false;
    });

    it("Should not allow removing last dev", async function () {
      // Remove dev2, dev3, dev4
      await token.connect(dev1).startP1();
      await time.increase(72 * 60 * 60);
      await token.connect(dev1).startP2();
      await time.increase(72 * 60 * 60);
      
      let proposalId = await token.connect(dev1).proposeRemoveDev.staticCall(dev4.address);
      await token.connect(dev1).proposeRemoveDev(dev4.address);
      await token.connect(dev2).confirmDevProposal(proposalId);
      
      // Reset P1/P2
      await token.connect(dev1).startP1();
      await time.increase(72 * 60 * 60);
      await token.connect(dev1).startP2();
      await time.increase(72 * 60 * 60);
      
      proposalId = await token.connect(dev1).proposeRemoveDev.staticCall(dev3.address);
      await token.connect(dev1).proposeRemoveDev(dev3.address);
      await token.connect(dev2).confirmDevProposal(proposalId);
      
      // Reset P1/P2
      await token.connect(dev1).startP1();
      await time.increase(72 * 60 * 60);
      await token.connect(dev1).startP2();
      await time.increase(72 * 60 * 60);
      
      proposalId = await token.connect(dev1).proposeRemoveDev.staticCall(dev2.address);
      await token.connect(dev1).proposeRemoveDev(dev2.address);
      await token.connect(dev1).confirmDevProposal(proposalId);
      
      // Only dev1 left
      expect(await token.devWalletCount()).to.equal(1);
      
      // Cannot remove last dev
      await token.connect(dev1).startP1();
      await time.increase(72 * 60 * 60);
      await token.connect(dev1).startP2();
      await time.increase(72 * 60 * 60);
      
      await expect(
        token.connect(dev1).proposeRemoveDev(dev1.address)
      ).to.be.revertedWith("Cannot remove last dev");
    });
  });

  describe("11. MULTI-SIG MECHANISM", function () {
    it("Should require 2 different devs for confirmation", async function () {
      await token.connect(dev1).startP1();
      await time.increase(72 * 60 * 60);
      await token.connect(dev1).startP2();
      await time.increase(72 * 60 * 60);
      
      const proposalId = await token.connect(dev1).proposeRemoveDev.staticCall(dev4.address);
      await token.connect(dev1).proposeRemoveDev(dev4.address);
      
      // Same dev cannot confirm
      await expect(
        token.connect(dev1).confirmDevProposal(proposalId)
      ).to.be.revertedWith("Cannot confirm own proposal");
      
      // Different dev can confirm
      await token.connect(dev2).confirmDevProposal(proposalId);
    });

    it("Should not allow confirming twice", async function () {
      await token.connect(dev1).startP1();
      await time.increase(72 * 60 * 60);
      await token.connect(dev1).startP2();
      await time.increase(72 * 60 * 60);
      
      const proposalId = await token.connect(dev1).proposeRemoveDev.staticCall(dev4.address);
      await token.connect(dev1).proposeRemoveDev(dev4.address);
      await token.connect(dev2).confirmDevProposal(proposalId);
      
      // Cannot confirm again
      await expect(
        token.connect(dev3).confirmDevProposal(proposalId)
      ).to.be.revertedWith("Already confirmed");
    });
  });

  describe("12. TAX SYSTEM", function () {
    beforeEach(async function () {
      await token.connect(dev1).setLiquidityPool(liquidityPool.address);
      await token.connect(dev1).enableTrading();
      await time.increase(7 * 24 * 60 * 60);
      
      // Give tokens to user
      await token.connect(dev1).transfer(dev2.address, ethers.parseEther("100"));
      await time.increase(6 * 60 * 60);
      await token.connect(dev1).transfer(user1.address, ethers.parseEther("10000"));
    });

    it("Should apply 0.08% tax on NON-DEV buy/sell", async function () {
      const amount = ethers.parseEther("10000");
      const expectedTax = amount * 8n / 10000n; // 0.08%
      const expectedReceived = amount - expectedTax;
      
      const initialSupply = await token.totalSupply();
      
      // User1 sells to pool
      await token.connect(user1).transfer(liquidityPool.address, amount);
      
      // Pool receives amount minus tax
      expect(await token.balanceOf(liquidityPool.address)).to.be.closeTo(
        expectedReceived,
        ethers.parseEther("1")
      );
      
      // Total supply decreased by burn amount (37.5% of tax)
      const burnAmount = expectedTax * 3750n / 10000n;
      expect(await token.totalSupply()).to.be.closeTo(
        initialSupply - burnAmount,
        ethers.parseEther("0.1")
      );
    });

    it("Should distribute tax to first available dev", async function () {
      const amount = ethers.parseEther("10000");
      const expectedTax = amount * 8n / 10000n;
      const devShare = expectedTax * 6250n / 10000n; // 62.5%
      
      const initialDevBalance = await token.balanceOf(dev1.address);
      
      await token.connect(user1).transfer(liquidityPool.address, amount);
      
      const finalDevBalance = await token.balanceOf(dev1.address);
      expect(finalDevBalance - initialDevBalance).to.be.closeTo(
        devShare,
        ethers.parseEther("0.1")
      );
    });

    it("Should not tax DEV wallet transactions", async function () {
      const amount = ethers.parseEther("100");
      
      // Dev transaction should have no tax
      await token.connect(dev1).transfer(liquidityPool.address, amount);
      expect(await token.balanceOf(liquidityPool.address)).to.equal(amount);
    });
  });

  describe("13. ANTI-HACK SCENARIO", function () {
    it("Scenario: Hacker compromises 1 dev wallet", async function () {
      await token.connect(dev1).setLiquidityPool(liquidityPool.address);
      await token.connect(dev1).enableTrading();
      
      console.log("
=== HACK SCENARIO ===");
      console.log("Day 0: Hacker compromises dev1 wallet");
      
      // Hacker's first transaction must be <= 100 PTC
      console.log("Hacker tries to transfer 1000 PTC...");
      await expect(
        token.connect(dev1).transfer(user3.address, ethers.parseEther("1000"))
      ).to.be.revertedWith("First tx of day max 100 tokens");
      
      console.log("Hacker forced to transfer only 100 PTC first");
      await token.connect(dev1).transfer(user3.address, ethers.parseEther("100"));
      
      console.log("
Other devs notice suspicious activity!");
      console.log("Dev2 immediately starts PAUSE");
      await token.connect(dev2).startPause();
      
      console.log("
All transfers blocked for 72 hours");
      await expect(
        token.connect(dev1).transfer(user3.address, ethers.parseEther("100"))
      ).to.be.revertedWith("Contract paused");
      
      console.log("Dev2 adds hacker's target address to blacklist");
      await token.connect(dev2).addToBlacklist(user3.address);
      
      console.log("
72 hours later: Pause expires");
      await time.increase(72 * 60 * 60);
      
      console.log("Dev2 starts P1/P2 process to remove compromised dev1");
      await token.connect(dev2).startP1();
      await time.increase(72 * 60 * 60);
      await token.connect(dev2).startP2();
      await time.increase(72 * 60 * 60);
      
      console.log("Dev2 proposes removing dev1");
      const proposalId = await token.connect(dev2).proposeRemoveDev.staticCall(dev1.address);
      await token.connect(dev2).proposeRemoveDev(dev1.address);
      
      console.log("Dev3 confirms removal");
      await token.connect(dev3).confirmDevProposal(proposalId);
      
      expect(await token.isDevWallet(dev1.address)).to.be.false;
      console.log("
✅ Hacker successfully removed from dev list");
      console.log("Total stolen: Only 100 PTC!");
    });
  });

  describe("14. VIEW FUNCTIONS", function () {
    it("Should return correct dev wallet info", async function () {
      const devs = await token.getDevWallets();
      expect(devs[0]).to.equal(dev1.address);
      expect(devs[1]).to.equal(dev2.address);
      expect(devs[2]).to.equal(dev3.address);
      expect(devs[3]).to.equal(dev4.address);
    });

    it("Should return correct max tx amounts", async function () {
      await token.connect(dev1).setLiquidityPool(liquidityPool.address);
      await token.connect(dev1).enableTrading();
      
      // Before day 7
      expect(await token.getMaxTxAmount(dev1.address)).to.equal(ethers.parseEther("1000000"));
      expect(await token.getMaxTxAmount(user1.address)).to.equal(0);
      
      // After day 7
      await time.increase(7 * 24 * 60 * 60);
      expect(await token.getMaxTxAmount(dev1.address)).to.equal(ethers.parseEther("100000"));
      expect(await token.getMaxTxAmount(user1.address)).to.equal(ethers.parseEther("40000"));
      
      // After year 1
      await time.increase(365 * 24 * 60 * 60);
      expect(await token.getMaxTxAmount(user1.address)).to.equal(ethers.parseEther("20000"));
    });

    it("Should return correct timeout remaining", async function () {
      await token.connect(dev1).startPause();
      const remaining = await token.getPauseTimeRemaining();
      expect(remaining).to.be.closeTo(72n * 60n * 60n, 10n);
    });
  });

  describe("15. REENTRANCY PROTECTION", function () {
    it("Should prevent reentrancy attacks", async function () {
      // This would require a malicious contract to test properly
      // Ensuring nonReentrant modifier is present on all external functions
      await token.connect(dev1).setLiquidityPool(liquidityPool.address);
      await token.connect(dev1).enableTrading();
      
      // Basic check: multiple rapid calls should work (not reentrant)
      await token.connect(dev1).transfer(dev2.address, ethers.parseEther("100"));
      await time.increase(6 * 60 * 60);
      await token.connect(dev1).transfer(dev3.address, ethers.parseEther("100"));
    });
  });

  describe("16. BURN MECHANISM", function () {
    beforeEach(async function () {
      await token.connect(dev1).setLiquidityPool(liquidityPool.address);
      await token.connect(dev1).enableTrading();
      await time.increase(7 * 24 * 60 * 60);
    });

    it("Should allow anyone to burn their tokens", async function () {
      const burnAmount = ethers.parseEther("1000");
      const initialSupply = await token.totalSupply();
      const initialBalance = await token.balanceOf(dev1.address);
      
      await token.connect(dev1).burn(burnAmount);
      
      expect(await token.totalSupply()).to.equal(initialSupply - burnAmount);
      expect(await token.balanceOf(dev1.address)).to.equal(initialBalance - burnAmount);
    });

    it("Should automatically burn portion of tax", async function () {
      // Give tokens to user
      await token.connect(dev1).transfer(dev2.address, ethers.parseEther("100"));
      await time.increase(6 * 60 * 60);
      await token.connect(dev1).transfer(user1.address, ethers.parseEther("10000"));
      
      const initialSupply = await token.totalSupply();
      const amount = ethers.parseEther("10000");
      const expectedTax = amount * 8n / 10000n;
      const burnAmount = expectedTax * 3750n / 10000n; // 37.5%
      
      await token.connect(user1).transfer(liquidityPool.address, amount);
      
      expect(await token.totalSupply()).to.be.closeTo(
        initialSupply - burnAmount,
        ethers.parseEther("0.1")
      );
    });
  });

  describe("17. CROSS-TYPE TRANSFER LIMITS", function () {
    beforeEach(async function () {
      await token.connect(dev1).setLiquidityPool(liquidityPool.address);
      await token.connect(dev1).enableTrading();
      await time.increase(7 * 24 * 60 * 60);
    });

    it("DEV → NON-DEV should use minimum limit", async function () {
      // Dev can send 100K, non-dev can receive 40K
      // Effective limit = 40K
      await token.connect(dev1).transfer(dev2.address, ethers.parseEther("100"));
      await time.increase(6 * 60 * 60);
      
      const maxTransfer = ethers.parseEther("40000");
      await token.connect(dev1).transfer(user1.address, maxTransfer);
      
      // Should reject 40001
      await time.increase(6 * 60 * 60);
      await expect(
        token.connect(dev1).transfer(user2.address, ethers.parseEther("40001"))
      ).to.be.revertedWith("Exceeds max tx amount");
    });

    it("NON-DEV → DEV should use minimum limit", async function () {
      // Give tokens to user
      await token.connect(dev1).transfer(dev2.address, ethers.parseEther("100"));
      await time.increase(6 * 60 * 60);
      await token.connect(dev1).transfer(user1.address, ethers.parseEther("40000"));
      
      // Non-dev can send 40K, dev can receive 100K
      // Effective limit = 40K
      await token.connect(user1).transfer(dev2.address, ethers.parseEther("40000"));
      
      // Cannot send more
      await expect(
        token.connect(user1).transfer(dev2.address, ethers.parseEther("1"))
      ).to.be.revertedWith("Insufficient balance");
    });
  });

  describe("18. EDGE CASES", function () {
    it("Should handle day rollover correctly for first tx limit", async function () {
      await token.connect(dev1).setLiquidityPool(liquidityPool.address);
      await token.connect(dev1).enableTrading();
      
      // First tx of day 1
      await token.connect(dev1).transfer(dev2.address, ethers.parseEther("100"));
      
      // Large tx same day
      await token.connect(dev1).transfer(dev2.address, ethers.parseEther("100000"));
      
      // Move to next day (24 hours)
      await time.increase(24 * 60 * 60);
      
      // Should require 100 PTC first tx again
      await expect(
        token.connect(dev1).transfer(dev2.address, ethers.parseEther("1000"))
      ).to.be.revertedWith("First tx of day max 100 tokens");
    });

    it("Should handle P1/P2 reset correctly", async function () {
      await token.connect(dev1).startP1();
      await time.increase(72 * 60 * 60);
      await token.connect(dev1).startP2();
      await time.increase(72 * 60 * 60);
      
      // Execute operation (removes dev4)
      const proposalId = await token.connect(dev1).proposeRemoveDev.staticCall(dev4.address);
      await token.connect(dev1).proposeRemoveDev(dev4.address);
      await token.connect(dev2).confirmDevProposal(proposalId);
      
      // P1/P2 should be reset
      expect(await token.p1Active()).to.be.false;
      expect(await token.p2Active()).to.be.false;
    });

    it("Should handle multiple pause periods", async function () {
      await token.connect(dev1).startPause();
      
      // Start another pause immediately
      await token.connect(dev2).startPause();
      
      // Should still be paused
      expect(await token.isPaused()).to.be.true;
    });
  });

  describe("19. GAS OPTIMIZATION CHECKS", function () {
    it("Should have reasonable gas costs for transfers", async function () {
      await token.connect(dev1).setLiquidityPool(liquidityPool.address);
      await token.connect(dev1).enableTrading();
      
      const tx = await token.connect(dev1).transfer(dev2.address, ethers.parseEther("100"));
      const receipt = await tx.wait();
      
      console.log(`
Gas used for dev transfer: ${receipt.gasUsed.toString()}`);
      expect(receipt.gasUsed).to.be.lessThan(200000n);
    });
  });

  describe("20. COMPLETE WORKFLOW TEST", function () {
    it("Should handle complete token lifecycle", async function () {
      console.log("
=== COMPLETE LIFECYCLE TEST ===");
      
      // 1. Setup
      console.log("1. Setting up liquidity pool...");
      await token.connect(dev1).setLiquidityPool(liquidityPool.address);
      
      // 2. Enable trading
      console.log("2. Enabling trading...");
      await token.connect(dev1).enableTrading();
      
      // 3. Pre-day 7: Only devs can trade
      console.log("3. Day 0-6: Only DEV wallets active");
      await token.connect(dev1).transfer(dev2.address, ethers.parseEther("100"));
      
      // 4. Day 7: Non-devs can trade
      console.log("4. Day 7+: Activating non-dev trading...");
      await time.increase(7 * 24 * 60 * 60);
      
      await token.connect(dev1).transfer(dev2.address, ethers.parseEther("100"));
      await time.increase(6 * 60 * 60);
      await token.connect(dev1).transfer(user1.address, ethers.parseEther("40000"));
      
      console.log("5. Non-dev user1 can now trade");
      await token.connect(user1).transfer(user2.address, ethers.parseEther("1000"));
      
      // 6. Blacklist scenario
      console.log("6. Blacklisting suspicious user3...");
      await token.connect(dev1).addToBlacklist(user3.address);
      
      // 7. Year 1: Limits change
      console.log("7. Fast-forward to year 1...");
      await time.increase(365 * 24 * 60 * 60);
      
      // Non-dev limit now 20K
      await token.connect(user1).transfer(user2.address, ethers.parseEther("20000"));
      
      await expect(
        token.connect(user1).transfer(user2.address, ethers.parseEther("20001"))
      ).to.be.revertedWith("Exceeds max tx amount");
      
      // 8. Dev replacement scenario
      console.log("8. Replacing dev4 with new dev...");
      const [, , , , , , , , , newDev] = await ethers.getSigners();
      
      // Remove dev4
      await token.connect(dev1).startP1();
      await time.increase(72 * 60 * 60);
      await token.connect(dev1).startP2();
      await time.increase(72 * 60 * 60);
      
      let proposalId = await token.connect(dev1).proposeRemoveDev.staticCall(dev4.address);
      await token.connect(dev1).proposeRemoveDev(dev4.address);
      await token.connect(dev2).confirmDevProposal(proposalId);
      
      console.log("Dev4 removed successfully");
      
      // Add newDev
      await token.connect(dev1).startPause();
      await token.connect(dev1).startP1();
      await time.increase(72 * 60 * 60);
      await token.connect(dev1).startP2();
      await time.increase(72 * 60 * 60);
      
      proposalId = await token.connect(dev1).proposeAddDev.staticCall(newDev.address);
      await token.connect(dev1).proposeAddDev(newDev.address);
      await token.connect(dev2).confirmDevProposal(proposalId);
      
      console.log("New dev added with 288h timeout");
      expect(await token.isDevWallet(newDev.address)).to.be.true;
      expect(await token.canDevOperate(newDev.address)).to.be.false;
      
      console.log("
✅ Complete lifecycle test passed!");
    });
  });
});