import * as vscode from "vscode";
import { EVENT_TYPES } from "@ide-collector/event-schema";
import { CollectorRegistration } from "./types";

/**
 * AI assistant events.
 *
 * IMPORTANT: no IDE in the target set exposes a public, stable API for
 * observing another extension's AI chat. VS Code's `vscode.lm` /
 * `vscode.chat` APIs let an extension *be* a chat participant or *call* a
 * model - they do not let it eavesdrop on Copilot, Cursor, or Windsurf
 * sessions. Cursor and Windsurf ship no public AI telemetry API at all.
 *
 * So this collector does two honest things instead of pretending:
 *
 *   1. Probes what this host actually exposes and emits a single
 *      `ai.feature_unavailable` event describing the gap, so downstream
 *      analytics can distinguish "the developer used no AI" from "we cannot
 *      see AI here".
 *   2. Exposes a public reporting API (see `AiEventReporter`) that a
 *      first-party AI extension - or a Cursor/Windsurf adapter with private
 *      API access - can call to push AI events through the same pipeline.
 *
 * Prompts and responses are never captured wholesale: the reporter records
 * metadata (token counts, model, latency, accepted/rejected) and any text it
 * is given still passes through the redactor.
 */

export interface AiCapabilities {
  /** `vscode.lm` present: this extension could call models itself. */
  languageModelApi: boolean;
  /** `vscode.chat` present: this extension could register a chat participant. */
  chatParticipantApi: boolean;
  /** True only where a host exposes observable AI activity (none today). */
  observableAssistant: boolean;
}

export function probeAiCapabilities(): AiCapabilities {
  const api = vscode as unknown as Record<string, unknown>;
  return {
    languageModelApi: typeof api.lm === "object" && api.lm !== null,
    chatParticipantApi: typeof api.chat === "object" && api.chat !== null,
    observableAssistant: false,
  };
}

export const registerAiCollectors: CollectorRegistration = ({ collector }) => {
  const capabilities = probeAiCapabilities();

  if (!capabilities.observableAssistant) {
    collector.capture({
      eventType: EVENT_TYPES.AI_FEATURE_UNAVAILABLE,
      payload: {
        reason: "no_public_api_for_observing_assistant_activity",
        language_model_api: capabilities.languageModelApi,
        chat_participant_api: capabilities.chatParticipantApi,
        note: "AI events must be pushed by a cooperating extension via the reporter API",
      },
    });
  }

  return [];
};

/**
 * Public surface other extensions use to contribute AI events:
 *
 *   const collector = vscode.extensions
 *     .getExtension('ide-collector.ide-event-collector')?.exports;
 *   collector?.ai.reportPrompt({ model: 'claude-opus-5', promptTokens: 120 });
 */
export class AiEventReporter {
  constructor(
    private readonly capture: (input: {
      eventType: string;
      payload?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      file?: { path?: string; language?: string };
    }) => unknown,
    private readonly isContentCaptureEnabled: () => boolean = () => false,
  ) {}

  sessionStarted(
    payload: { provider?: string; model?: string; session_ref?: string } = {},
  ) {
    this.capture({ eventType: EVENT_TYPES.AI_SESSION_STARTED, payload });
  }

  sessionEnded(
    payload: {
      provider?: string;
      duration_ms?: number;
      turn_count?: number;
    } = {},
  ) {
    this.capture({ eventType: EVENT_TYPES.AI_SESSION_ENDED, payload });
  }

  chatStarted(payload: { provider?: string; surface?: string } = {}) {
    this.capture({ eventType: EVENT_TYPES.AI_CHAT_STARTED, payload });
  }

  /** Prompt *metadata*. Pass `text` only if the user opted into content capture. */
  reportPrompt(payload: {
    provider?: string;
    model?: string;
    prompt_tokens?: number;
    prompt_chars?: number;
    has_file_context?: boolean;
    text?: string;
  }) {
    this.capture({
      eventType: EVENT_TYPES.AI_USER_PROMPT,
      payload: this.withOptionalContent(payload),
    });
  }

  reportResponse(payload: {
    provider?: string;
    model?: string;
    completion_tokens?: number;
    latency_ms?: number;
    finish_reason?: string;
    error?: string;
    text?: string;
  }) {
    this.capture({
      eventType: EVENT_TYPES.AI_RESPONSE,
      payload: this.withOptionalContent(payload),
    });
  }

  agentInvoked(payload: { agent?: string; provider?: string; task?: string }) {
    this.capture({ eventType: EVENT_TYPES.AI_AGENT_INVOKED, payload });
  }

  toolInvoked(payload: {
    tool?: string;
    agent?: string;
    arguments_count?: number;
  }) {
    this.capture({ eventType: EVENT_TYPES.AI_TOOL_INVOKED, payload });
  }

  toolResult(payload: {
    tool?: string;
    succeeded?: boolean;
    duration_ms?: number;
  }) {
    this.capture({ eventType: EVENT_TYPES.AI_TOOL_RESULT, payload });
  }

  codeGenerated(payload: {
    provider?: string;
    model?: string;
    lines_generated?: number;
    accepted?: boolean;
    file?: { path?: string; language?: string };
  }) {
    this.capture({
      eventType: EVENT_TYPES.AI_CODE_GENERATED,
      file: payload.file,
      payload: { ...payload, file: undefined },
    });
  }

  codeModified(payload: {
    provider?: string;
    lines_added?: number;
    lines_removed?: number;
    accepted?: boolean;
    file?: { path?: string; language?: string };
  }) {
    this.capture({
      eventType: EVENT_TYPES.AI_CODE_MODIFIED,
      file: payload.file,
      payload: { ...payload, file: undefined },
    });
  }

  private withOptionalContent<T extends { text?: string }>(payload: T): T {
    if (this.isContentCaptureEnabled()) return payload;
    const { text: _text, ...metadata } = payload;
    return metadata as T;
  }
}
