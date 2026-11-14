export const browserLocation = window.location.href;

// @ts-expect-error Browser production code must not receive Node globals.
process.cwd();

// @ts-expect-error Browser production code must not receive Vitest globals.
describe("browser production scope", () => {});
