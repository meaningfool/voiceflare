import {
  decodeConversationCatalog,
  type CombinationAvailability,
  type ConversationSelection,
} from "../../../../worker/shared/contracts/conversationSelection.ts";
import { createLabWorkerClient, type LabWorkerFetch } from "./labWorkerClient";

export type LabConversationOption = {
  id: string;
  name: string;
  selection: ConversationSelection;
  /** The input format the entry accepts; Lab offers the entry when an editor makes it. */
  inputContract: string;
  /** The connection profiles the entry accepts; each opens the client for its profile. */
  connectionProfiles?: readonly string[];
  /** Whether Runtime can start the entry: the credentials its providers need and it lacks. */
  availability: CombinationAvailability;
};
/** Whether Runtime reports it can start the entry; Lab disables an entry it cannot start. */
export function canStartLabConversation(option: Pick<LabConversationOption, "availability">) {
  return option.availability.missingCredentials.length === 0;
}
export function createLabConversationStore(baseUrl: string, fetchImpl?: LabWorkerFetch) {
  const client = createLabWorkerClient(baseUrl, fetchImpl);
  return { list: () => client.get("/_api/conversation-selections", decodeConversationCatalog) };
}
export type LabConversationStore = ReturnType<typeof createLabConversationStore>;
