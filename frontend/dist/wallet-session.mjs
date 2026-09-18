const NETWORK_EVENTS = ["networkChanged", "chainChanged"];

export function injectedSolanaWallet(scope = globalThis) {
  const phantom = scope?.phantom?.solana || scope?.solana;
  return phantom?.isPhantom ? phantom : null;
}

export async function connectInjectedWallet(provider, { onlyIfTrusted = false } = {}) {
  if (!provider || typeof provider.connect !== "function") {
    throw new Error("Phantom was not found. Install or enable the Phantom browser extension.");
  }
  const result = onlyIfTrusted
    ? await provider.connect({ onlyIfTrusted: true })
    : await provider.connect();
  return result?.publicKey || provider.publicKey || null;
}

export function createWalletEventRegistry() {
  const attachedProviders = new WeakSet();
  return {
    attach(provider, handlers) {
      if (!provider?.on || attachedProviders.has(provider)) return false;
      provider.on("accountChanged", handlers.accountChanged);
      for (const eventName of NETWORK_EVENTS) provider.on(eventName, handlers[eventName]);
      attachedProviders.add(provider);
      return true;
    },
  };
}
