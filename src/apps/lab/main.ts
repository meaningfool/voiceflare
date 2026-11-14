import { createLabConversationStore } from "./data/conversationCatalog";
import { createLabCascadeProviderOptionsStore } from "./data/cascadeProviderOptions";
import "./styles.css";

import { createOpenAiLabRealtimeClient } from "./realtimeClient/openAiLabRealtimeClient";
import { createLabCascadeClient } from "./cascadeClient/labCascadeClient";
import { readBrowserConfig } from "./data/browserConfig";
import { createWorkerLabRunStore } from "./data/labRunStore";
import { mountInterviewLab } from "./InterviewLab";
import { createLabPromptStore } from "./labPrompts";

export function mountConfiguredInterviewLab(appRoot: HTMLElement): void {
  const browserConfig = readBrowserConfig();
  const labRunStore =
    browserConfig.labWorkerUrl === null
      ? null
      : createWorkerLabRunStore(browserConfig.labWorkerUrl);
  const labRealtimeClient =
    labRunStore === null || browserConfig.labWorkerUrl === null
      ? null
      : createOpenAiLabRealtimeClient({
          labWorkerUrl: browserConfig.labWorkerUrl,
        });

  mountInterviewLab({
    appRoot,
    labRunStore,
    labRealtimeClient,
    labCascadeClient:
      browserConfig.labWorkerUrl === null
        ? null
        : createLabCascadeClient({ labWorkerUrl: browserConfig.labWorkerUrl }),
    labConversationStore:
      browserConfig.labWorkerUrl === null
        ? null
        : createLabConversationStore(browserConfig.labWorkerUrl),
    labCascadeProviderOptionsStore:
      browserConfig.labWorkerUrl === null
        ? null
        : createLabCascadeProviderOptionsStore(browserConfig.labWorkerUrl),
    labPromptStore:
      browserConfig.labWorkerUrl === null ? null : createLabPromptStore(browserConfig.labWorkerUrl),
  });
}
