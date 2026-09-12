import {
  assistantOnlyResponse,
  createScriptedAgentModel,
  toolCallResponse,
  type AgentModel,
} from "@opensuite/agent-core";

/** Fixed, local tool-call plans for benchmark scenarios. Never contacts a provider. */
export function createScriptedBenchmarkModel(scenario: string): AgentModel {
  switch (scenario) {
    case "target-duplicate":
      return createScriptedAgentModel([
        toolCallResponse("", [{
          id: "style-second-note",
          name: "document.set_paragraph_style",
          input: { target: { text: "Note", occurrence: 2 }, style: "Heading 1" },
        }]),
        assistantOnlyResponse("Done."),
      ]);
    case "target-recovery":
      return createScriptedAgentModel([
        toolCallResponse("", [{
          id: "ambiguous-note",
          name: "document.set_paragraph_style",
          input: { target: { text: "Note" }, style: "Heading 1" },
        }]),
        toolCallResponse("", [{
          id: "inspect-notes",
          name: "document.inspect",
          input: { focus: { kind: "paragraphs", offset: 0, limit: 4 } },
        }]),
        toolCallResponse("", [{
          id: "style-second-note",
          name: "document.set_paragraph_style",
          input: { target: { text: "Note", occurrence: 2 }, style: "Heading 1" },
        }]),
        assistantOnlyResponse("Done."),
      ]);
    case "greenfield-poems":
      return createScriptedAgentModel([
        toolCallResponse("", [{
          id: "create-poems",
          name: "workspace.create_blank_docx",
          input: { name: "Poems.docx" },
        }]),
        toolCallResponse("Done — poems are ready.", [
          {
            id: "poem-body",
            name: "document.insert_paragraphs",
            input: {
              texts: ["Five Small Poems", "An introduction.", "First Poem", "A small line.", "Second Poem", "Another line.", "Third Poem", "Third line.", "Fourth Poem", "Fourth line.", "Fifth Poem", "Fifth line.", "A closing section."],
              placement: { kind: "end" },
            },
          },
          ...["Five Small Poems", "First Poem", "Second Poem", "Third Poem", "Fourth Poem", "Fifth Poem"].map((text, index) => ({
            id: `style-${index}`,
            name: "document.set_paragraph_style",
            input: { target: { text }, style: index === 0 ? "Heading 1" : "Heading 2" },
          })),
        ]),
      ]);
    case "authoring-memo":
      return createScriptedAgentModel([
        toolCallResponse("", [{
          id: "create-memo",
          name: "workspace.create_blank_docx",
          input: { name: "Weekly Status Memo.docx" },
        }]),
        toolCallResponse("Done — memo drafted.", [
          {
            id: "memo-body",
            name: "document.insert_paragraphs",
            input: {
              texts: [
                "Weekly Status Memo",
                "To: Product Team",
                "From: OpenSuite Agent",
                "Subject: Sprint progress",
                "We closed targeting work and batched safe formatting mutations.",
                "Next week focuses on authoring quality.",
                "Please reply with blockers by Thursday.",
              ],
              placement: { kind: "end" },
            },
          },
          {
            id: "memo-title",
            name: "document.set_paragraph_style",
            input: { target: { text: "Weekly Status Memo" }, style: "Heading 1" },
          },
          {
            id: "memo-space",
            name: "document.set_paragraph_formatting",
            input: {
              target: { text: "Subject: Sprint progress" },
              spacingAfterTwips: 200,
            },
          },
        ]),
      ]);
    case "authoring-guide":
      return createScriptedAgentModel([
        toolCallResponse("", [{
          id: "create-guide",
          name: "workspace.create_blank_docx",
          input: { name: "Onboarding Guide.docx" },
        }]),
        toolCallResponse("Done — onboarding guide is ready.", [
          {
            id: "guide-body",
            name: "document.insert_paragraphs",
            input: {
              texts: [
                "Onboarding Guide",
                "Overview",
                "This guide covers account setup and first document creation.",
                "Setup steps",
                "Create a workspace",
                "Invite teammates",
                "Open Casual Docs",
                "Tips",
                "Prefer structured authoring over decorative formatting.",
              ],
              placement: { kind: "end" },
            },
          },
          {
            id: "guide-title",
            name: "document.set_paragraph_style",
            input: { target: { text: "Onboarding Guide" }, style: "Heading 1" },
          },
          {
            id: "guide-h1",
            name: "document.set_paragraph_style",
            input: { target: { text: "Overview" }, style: "Heading 2" },
          },
          {
            id: "guide-h2",
            name: "document.set_paragraph_style",
            input: { target: { text: "Setup steps" }, style: "Heading 2" },
          },
          {
            id: "guide-h3",
            name: "document.set_paragraph_style",
            input: { target: { text: "Tips" }, style: "Heading 2" },
          },
          {
            id: "guide-list",
            name: "document.set_paragraphs_list",
            input: {
              targets: [
                { text: "Create a workspace" },
                { text: "Invite teammates" },
                { text: "Open Casual Docs" },
              ],
              kind: "bullet",
              level: 0,
            },
          },
        ]),
      ]);
    case "authoring-creative":
      return createScriptedAgentModel([
        toolCallResponse("", [{
          id: "create-creative",
          name: "workspace.create_blank_docx",
          input: { name: "Evening Notes.docx" },
        }]),
        toolCallResponse("Done — evening notes are ready.", [
          {
            id: "creative-body",
            name: "document.insert_paragraphs",
            input: {
              texts: [
                "Evening Notes",
                "Harbor Light",
                "A short line.",
                "Another short line.",
                "Window Rain",
                "Soft drumming.",
                "Closing thought.",
              ],
              placement: { kind: "end" },
            },
          },
          {
            id: "creative-title",
            name: "document.set_paragraph_style",
            input: { target: { text: "Evening Notes" }, style: "Heading 1" },
          },
          {
            id: "creative-h1",
            name: "document.set_paragraph_style",
            input: { target: { text: "Harbor Light" }, style: "Heading 2" },
          },
          {
            id: "creative-h2",
            name: "document.set_paragraph_style",
            input: { target: { text: "Window Rain" }, style: "Heading 2" },
          },
          {
            id: "creative-space-a",
            name: "document.set_paragraph_formatting",
            input: { target: { text: "A short line." }, spacingAfterTwips: 60 },
          },
          {
            id: "creative-space-b",
            name: "document.set_paragraph_formatting",
            input: { target: { text: "Soft drumming." }, spacingAfterTwips: 60 },
          },
        ]),
      ]);
    default:
      throw new Error(`No scripted benchmark plan for ${scenario}`);
  }
}
