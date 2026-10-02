export type WriteApprovalPrompt = (message: string) => Promise<boolean>;

export async function requestInteractiveWriteApproval(input: {
  interactive: boolean;
  profileName: string;
  target: string;
  operation: string;
  prompt: WriteApprovalPrompt;
}): Promise<void> {
  if (!input.interactive) {
    throw new Error(
      `Profile "${input.profileName}" requires interactive write approval. Run this command in a terminal; no Convex command was run.`,
    );
  }

  const approved = await input.prompt(
    `Approve ${input.operation} on profile "${input.profileName}" (${input.target})?`,
  );
  if (!approved) {
    throw new Error("Write cancelled. No Convex command was run.");
  }
}
