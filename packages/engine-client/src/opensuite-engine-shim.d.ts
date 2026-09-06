/**
 * Local TypeScript surface for the sibling opensuite-engine Node binding.
 * The published/native package currently ships an empty index.d.ts.
 */
declare module "@opensuite/engine" {
  export interface TextTargetInput {
    text: string;
    occurrence?: number;
  }

  export interface ReplaceTextInput {
    target: TextTargetInput;
    expectedCurrentText: string;
    replacement: string;
    baseRevision?: string;
  }

  export interface DiagnosticOutput {
    code: string;
    severity: string;
    message: string;
  }

  export interface OperationChangeOutput {
    kind: string;
    before: string;
    after: string;
  }

  export interface OperationResultOutput {
    ok: boolean;
    status: string;
    diagnostics: DiagnosticOutput[];
    changes: OperationChangeOutput[];
  }

  export interface ExecuteDocxReplaceTextOutput {
    result: OperationResultOutput;
    output?: Buffer;
  }

  export function executeDocxReplaceText(
    input: Buffer,
    operation: ReplaceTextInput,
  ): Promise<ExecuteDocxReplaceTextOutput>;
}
