/**
 * Stablecoin vault addresses per chain.
 *
 * Keep in sync with the extension's network-config.js AND with the server-side
 * VAULT_TRON / VAULT_SOL / VAULT_BASE environment variables — api/poll-payment.js
 * rejects any request whose vaultAddress does not match its own env value
 * ("Vault mismatch"), so a drift here silently breaks payment detection.
 */
window.PAYMENT_NETWORKS = {
  TRON: {
    name: "Tron (TRC-20)",
    token: "USDT",
    symbol: "USDT",
    address: "TXE8UZejabi93ks73VzsgeBqXM4C3fEydX",
    contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    decimals: 6,
    pollMs: 10000,
    type: "tron",
  },
  SOL: {
    name: "Solana",
    token: "USDC",
    symbol: "USDC",
    address: "A8qcrU1VYQy398C7ESotbQsLgwyeaPXt8K3eYqk6C7D3",
    contract: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
    pollMs: 5000,
    type: "solana",
  },
  BASE: {
    name: "Base",
    token: "USDC",
    symbol: "USDC",
    address: "0x410bd58086F75f61AEe0546A74B7c3D9Ef461bD8",
    contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    pollMs: 5000,
    type: "evm",
  },
};
