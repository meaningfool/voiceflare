import { mountConfiguredInterviewLab } from "./apps/lab/main";
import { mountNotFound } from "./shared/browser/notFound";

const appRoot = document.querySelector<HTMLDivElement>("#app");

if (appRoot === null) {
  throw new Error("Missing app root");
}

if (window.location.pathname === "/") {
  mountConfiguredInterviewLab(appRoot);
} else {
  mountNotFound(appRoot, "Interview Lab");
}
