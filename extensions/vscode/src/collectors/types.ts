import * as vscode from "vscode";
import { CollectorConfig, EventCollector } from "@ide-collector/event-sdk";
import { VSCodeContextProvider } from "../context-provider";
import { GitIntegration } from "../git-integration";

export interface CollectorDeps {
  collector: EventCollector;
  config: CollectorConfig;
  contextProvider: VSCodeContextProvider;
  git: GitIntegration;
}

export type CollectorRegistration = (deps: CollectorDeps) => vscode.Disposable[];
