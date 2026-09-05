/** Guard against empty / duplicate agent composer submits. */
export function shouldAcceptSubmit(input: {
  instruction: string;
  busy: boolean;
  locked: boolean;
}): boolean {
  return (
    input.instruction.trim().length > 0 && !input.busy && !input.locked
  );
}
