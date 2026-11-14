export const nodeVersion = process.versions.node;

// @ts-expect-error Node tooling must not receive browser DOM globals.
document.title = "Interview Lab";
