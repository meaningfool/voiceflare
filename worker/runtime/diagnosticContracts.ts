import { z } from "zod";

/** Declarations belong to the Conversation or execution that interprets the payload. */
export type DiagnosticDeclarations = Readonly<Record<string, z.ZodType>>;
export type DiagnosticDescription = Readonly<{ type: string; payload: unknown }>;
/** Native correlation is resolved by Runtime; authors cannot supply envelope attribution. */
export type DiagnosticCorrelation = Readonly<{ responseId: string | null }>;
export type DiagnosticContributor<Declarations extends DiagnosticDeclarations> = <
  Name extends Extract<keyof Declarations, string>,
>(
  type: Name,
  payload: z.input<Declarations[Name]>,
  correlation?: DiagnosticCorrelation,
) => void;

export function describeDiagnostic<Declarations extends DiagnosticDeclarations>(
  declarations: Declarations,
) {
  return <Name extends Extract<keyof Declarations, string>>(
    type: Name,
    payload: z.input<Declarations[Name]>,
  ): DiagnosticDescription => {
    void declarations;
    return { type, payload };
  };
}
