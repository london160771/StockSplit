function keyText(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value.toBase58 !== "function") return null;
  try {
    return value.toBase58();
  } catch {
    return null;
  }
}

export function publicKeyText(value) {
  return keyText(value);
}

export function publicKeyEquals(left, right) {
  if (!left || !right) return false;
  if (typeof left.equals === "function") {
    try {
      return Boolean(left.equals(right));
    } catch {
      // Fall through to a text comparison for compatible key-like values.
    }
  }
  const leftText = keyText(left);
  const rightText = keyText(right);
  return leftText !== null && rightText !== null && leftText === rightText;
}

export function memberRole(member, creator, wallet) {
  if (publicKeyEquals(member?.wallet, creator)) return "Creator";
  if (publicKeyEquals(member?.wallet, wallet)) return "You";
  return "Invited member";
}
