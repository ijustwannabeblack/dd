# Solana Memecoin Alpha & Snipe Bot

Autonomous Solana meme coin sniper, caller, and on-chain intelligence system with real-time TradingView candlestick chart rendering, multi-cluster bubblemap analysis, and Pump.fun livestream tracking.

## Features

- **Multi-Stage Detection**:
  - `Final Stretch`: High-velocity bonding curve tokens (85%+ curve).
  - `Migrated`: Raydium migrations with confirmed liquidity pool burn/lock.
  - `Active Runner Scanner`: Auto-discovers trending momentum runners.
- **On-Chain Anti-Rug Security Engine**:
  - Honeypot freeze authority verification via Solana RPC.
  - Mintable supply detection.
  - Dev dump cap (max 18%, or 22% with live viewers).
  - Dev + Insiders cabal concentration control (max 25%).
  - Top 10 non-pool concentration filter.
  - Jito slot 0 / block 0 sniper and bundler ring protection.
  - Staircase chart manipulation detection.
- **Pump.fun Livestream & Viewers Integration**:
  - Live status and participant/viewer tracking via Pump.fun API.
  - "Good viewers" priority boost when creators stream to real audiences.
- **TradingView / Birdeye Live Candlestick Charts**:
  - Clean TradingView charts embedded directly into Discord alert cards.
- **Multi-Channel Discord Architecture**:
  - `Calls Channel`: Instant alerts with embedded charts, token metrics, and security audits.
  - `Plain CAs Channel`: Raw contract addresses for 1-click copying and bot execution.
  - `Results Channel`: Post-trade summaries when tokens hit > 1.5x.
  - `Not Passed Channel`: Filter diagnostics explaining why rejected coins failed.
  - `AI Chat Channel`: Interactive AI crypto trading analyst.

## Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/ijustwannabeblack/dd.git
   cd dd
   ```

2. **Install Python dependencies**:
   ```bash
   pip install -r requirements.txt
   playwright install chromium
   ```

3. **Configure Environment Variables**:
   Copy `.env.example` to `.env` and fill in your API keys:
   ```bash
   cp .env.example .env
   ```

4. **Run the Bot**:
   ```bash
   python bot.py
   ```

## Test Chart Generator
Generate live 1-minute candlestick charts directly:
```bash
python test_chart.py <TOKEN_CONTRACT_ADDRESS>
```
