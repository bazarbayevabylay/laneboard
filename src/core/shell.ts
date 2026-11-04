// Shell quoting for the commands laneboard prints (fix, next step, warnings): a path with spaces must still run when copied.

// Quote one argv token for a copy-pasteable shell command: plain tokens as they are, others in single quotes.
export function shellQuote(token: string): string {
  if (/^[A-Za-z0-9_\-.,:/=@+%]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}
