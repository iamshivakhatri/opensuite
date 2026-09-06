/**
 * Local TypeScript surface for the sibling opensuite-engine Node binding.
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

  export interface RuntimeCapabilitiesOutput {
    ok: boolean;
    protocolVersion: number;
    engineVersion: string;
    formats: Array<{ format: string; capabilities: string[] }>;
  }

  export interface FindTextOutput {
    ok: boolean;
    query: string;
    matchCount: number;
    matches: Array<{
      occurrence: number;
      text: string;
      before: string;
      after: string;
      container: string;
    }>;
    diagnostics: DiagnosticOutput[];
  }

  export interface InspectDocxOutput {
    ok: boolean;
    target: TextTargetInput;
    container?: {
      relativePosition: number;
      text: string;
      container: string;
    };
    nearby: Array<{
      relativePosition: number;
      text: string;
      container: string;
    }>;
    diagnostics: DiagnosticOutput[];
  }

  export function getDocxCapabilities(): RuntimeCapabilitiesOutput;
  export function findDocxText(
    input: Buffer,
    request: { text: string },
  ): Promise<FindTextOutput>;
  export function inspectDocx(
    input: Buffer,
    request: {
      target: TextTargetInput;
      before?: number;
      after?: number;
    },
  ): Promise<InspectDocxOutput>;
  export function executeDocxReplaceText(
    input: Buffer,
    operation: ReplaceTextInput,
  ): Promise<ExecuteDocxReplaceTextOutput>;
}
