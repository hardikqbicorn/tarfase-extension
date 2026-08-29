import * as vscode from "vscode";
import { ContextProvider, EventContext } from "@ide-collector/event-sdk";
import { stableId } from "./paths";
import { GitIntegration } from "./git-integration";

/**
 * Supplies the ambient workspace/project/repository context attached to every
 * event. Reads current state on each call so events emitted after a folder or
 * branch change carry the new context.
 */
export class VSCodeContextProvider implements ContextProvider {
  constructor(
    private readonly ideName: string,
    private readonly ideVersion: string,
    private readonly git: GitIntegration
  ) {}

  getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  getContext(): EventContext {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const root = folder?.uri.fsPath;
    const repo = this.git.getCurrentRepository();

    return {
      ide: { name: this.ideName, version: this.ideVersion },
      workspace: folder
        ? { id: stableId(folder.uri.toString()), name: vscode.workspace.name ?? folder.name }
        : undefined,
      // With no monorepo/project concept in VS Code, the workspace root doubles
      // as the project. Adapters for IDEs with a real project model (JetBrains)
      // populate this differently.
      project: root ? { id: stableId(root), name: folder?.name } : undefined,
      repository: repo
        ? { id: stableId(repo.rootPath), name: repo.name, branch: repo.branch }
        : undefined,
    };
  }
}
