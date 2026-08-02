export const assertServiceSecret = (provided: string) => {
  const expected = process.env.MCP_SERVICE_SECRET;
  if (!expected || provided !== expected) {
    throw new Error('Unauthorized');
  }
};

export const normalizeEmail = (email: string): string => {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    throw new Error('An email address is required to use One Blog MCP.');
  }
  return normalized;
};
