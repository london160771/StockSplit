export function createWalletAtaInstruction(createInstruction, wallet, associatedToken, mint, tokenProgram, associatedTokenProgram) {
  // The wallet funds the ATA. The associated token address is never a signer.
  return createInstruction(wallet, associatedToken, wallet, mint, tokenProgram, associatedTokenProgram);
}
