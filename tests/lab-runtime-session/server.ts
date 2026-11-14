import { createLabRuntimePlatform } from "./platform.ts";

const [port, labAssets, labState] = process.argv.slice(2);
if (port === undefined || labAssets === undefined || labState === undefined)
  throw new Error("Expected the owned Lab port, the built Lab page and the migrated Lab state");
const platform = await createLabRuntimePlatform({
  port: Number(port),
  root: process.cwd(),
  labAssets,
  labState,
});
const stop = async () => {
  await platform.dispose();
  process.exit(0);
};
process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
console.log("Lab and Runtime ready");
