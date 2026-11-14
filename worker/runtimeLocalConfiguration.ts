import { cascadeStandIns, type StandInUtterance } from "./providers/cascade/testing/standIns.ts";
import { standInInterviewResponse } from "./runtimeLocalInterviewScript.ts";
import type { RuntimeHostConfiguration } from "./runtimeHostComposition.ts";

/**
 * Build constants, not Worker settings: only the local environment's `wrangler dev` defines
 * them (`scripts/local-environment/profiles.ts`), so no deployed variable, secret or
 * dashboard setting can select the Cascade stand-ins or a Gate test option.
 */
declare const LOCAL_CASCADE_STAND_INS: boolean | undefined;
declare const LOCAL_CASCADE_STAND_IN_UTTERANCES: readonly StandInUtterance[] | undefined;
declare const LOCAL_GATE_NO_TOOLS: boolean | undefined;
declare const LOCAL_GATE_SUPPLIED_NEXT_QUESTION: boolean | undefined;

const cascadeStandInsSelected =
  typeof LOCAL_CASCADE_STAND_INS !== "undefined" && LOCAL_CASCADE_STAND_INS === true;
const noToolsSelected = typeof LOCAL_GATE_NO_TOOLS !== "undefined" && LOCAL_GATE_NO_TOOLS === true;
const suppliedNextQuestionSelected =
  typeof LOCAL_GATE_SUPPLIED_NEXT_QUESTION !== "undefined" &&
  LOCAL_GATE_SUPPLIED_NEXT_QUESTION === true;

/**
 * This Runtime's registry configuration: the real Cascade providers unless a local build selects
 * the stand-ins, whose model then follows the local interview script, and the voice Gate's test
 * options only when a local build selects them.
 */
export const localRuntimeConfiguration: RuntimeHostConfiguration = Object.freeze({
  cascadeProviders: cascadeStandInsSelected
    ? cascadeStandIns({
        responses: standInInterviewResponse,
        utterances:
          typeof LOCAL_CASCADE_STAND_IN_UTTERANCES === "undefined"
            ? []
            : LOCAL_CASCADE_STAND_IN_UTTERANCES,
      })
    : undefined,
  gateTestOptions:
    noToolsSelected || suppliedNextQuestionSelected
      ? Object.freeze({
          noTools: noToolsSelected,
          suppliedNextQuestion: suppliedNextQuestionSelected,
        })
      : undefined,
});
