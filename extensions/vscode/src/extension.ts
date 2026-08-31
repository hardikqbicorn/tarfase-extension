import { randomUUID } from "crypto";
import { readFile, rm } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import * as vscode from "vscode";
import { EVENT_TYPES } from "@ide-collector/event-schema";
import {
  EncryptedQueuePersistence,
  EventCollector,
  EventQueue,
  FileSystemQueuePersistence,
  HttpEventTransport,
  QueuePersistence,
  RegistrationClient,
} from "@ide-collector/event-sdk";
import { generateInstallationSecret } from "@ide-collector/crypto";
import { Logger } from "@ide-collector/shared-utils";
import { readConfig } from "./vscode-config";
import { VSCodeContextProvider } from "./context-provider";
import { GitIntegration } from "./git-integration";
import { VSCodeAdapter } from "./adapter";
import { VSCodeSecretStore } from "./secret-store";
import { AiEventReporter } from "./collectors/ai";

/**
 * Extension entry point. The IDE name is overridable so the Cursor and
 * Windsurf builds - which are VS Code forks running this same code - report
 * their own identity.
 */
const IDE_NAME = process.env.IDE_COLLECTOR_IDE_NAME ?? detectIdeName();

const QUEUE_ENCRYPTION_KEY = "ide-collector.queueKey";

let collector: EventCollector | undefined;
let adapter: VSCodeAdapter | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let outputChannel: vscode.OutputChannel | undefined;

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("IDE Event Collector");
  context.subscriptions.push(outputChannel);

  const config = readConfig();
  const logger = new Logger({
    service: "vscode-extension",
    level: config.logLevel,
    sink: { write: (line) => outputChannel?.appendLine(line) },
  });

  const secretStore = new VSCodeSecretStore(context.secrets);
  const registrationClient = new RegistrationClient(secretStore);

  // ---- Commands are always registered, even with telemetry off, so the user
  // ---- can turn it on, register, and inspect status.
  context.subscriptions.push(
    vscode.commands.registerCommand("ideCollector.register", () =>
      registerInstallation(context, registrationClient, logger),
    ),
    vscode.commands.registerCommand("ideCollector.showStatus", () =>
      showStatus(registrationClient),
    ),
    vscode.commands.registerCommand("ideCollector.flushNow", async () => {
      await collector?.flush();
      vscode.window.showInformationMessage(
        `IDE Collector: flushed. ${collector?.getMetrics().queueSize ?? 0} events still queued.`,
      );
    }),
    vscode.commands.registerCommand(
      "ideCollector.toggleTelemetry",
      async () => {
        const settings = vscode.workspace.getConfiguration("telemetry");
        const next = !settings.get<boolean>("enabled", false);
        await settings.update(
          "enabled",
          next,
          vscode.ConfigurationTarget.Global,
        );
        vscode.window.showInformationMessage(
          `IDE Collector: telemetry ${next ? "enabled" : "disabled"}.`,
        );
      },
    ),
    vscode.commands.registerCommand("ideCollector.signOut", async () => {
      await registrationClient.clearCredentials();
      await stopCollector();
      vscode.window.showInformationMessage(
        "IDE Collector: credentials cleared.",
      );
    }),
  );

  // Restart the pipeline when relevant settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("telemetry")) {
        await stopCollector();
        await startCollector(context, registrationClient, logger);
      }
    }),
  );

  await startCollector(context, registrationClient, logger);

  // Public API other extensions use to contribute AI events.
  return {
    ai: new AiEventReporter(
      (input) => collector?.capture(input),
      () => readConfig().capture.aiContent,
    ),
    getMetrics: () => collector?.getMetrics(),
  };
}

export async function deactivate() {
  // Emit a session-end marker and drain the queue to disk so nothing is lost
  // across an IDE restart.
  collector?.capture({ eventType: EVENT_TYPES.SESSION_ENDED, payload: {} });
  collector?.capture({
    eventType: EVENT_TYPES.EXTENSION_DEACTIVATED,
    payload: {},
  });
  await collector?.flush().catch(() => undefined);
  await stopCollector();
}

async function startCollector(
  context: vscode.ExtensionContext,
  registrationClient: RegistrationClient,
  logger: Logger,
): Promise<void> {
  const config = readConfig();

  if (!config.enabled) {
    logger.info("telemetry disabled; collector not started");
    updateStatusBar("$(circle-slash) Collector off");
    return;
  }

  // The CLI cannot write to SecretStorage, so `ide-collector login` stages the
  // credential in a file. Import it here, into the keychain, and delete it.
  await importStagedCredential(registrationClient, logger);

  const credentials = await registrationClient.getStoredCredentials();
  if (!credentials) {
    logger.warn(
      "no installation credentials; run 'IDE Collector: Register This Installation'",
    );
    updateStatusBar("$(key) Collector: register");
    vscode.window
      .showInformationMessage(
        "IDE Event Collector is enabled but this installation is not registered.",
        "Register now",
      )
      .then((choice) => {
        if (choice === "Register now") {
          void vscode.commands.executeCommand("ideCollector.register");
        }
      });
    return;
  }

  const git = new GitIntegration();
  await git.initialize();

  const contextProvider = new VSCodeContextProvider(
    IDE_NAME,
    vscode.version ?? "unknown",
    git,
  );

  // Queue file lives in the extension's own storage directory, which is
  // per-user and outside any workspace, so queued events are never committed.
  const queuePath = join(context.globalStorageUri.fsPath, "event-queue.json");
  const persistence = await buildPersistence(
    context,
    queuePath,
    config.encryptLocalQueue,
  );

  const queue = new EventQueue({
    maxQueueSize: config.maxQueueSize,
    persistence,
    onDrop: () => logger.warn("local queue full; dropped oldest event"),
  });

  const transport = new HttpEventTransport({
    endpoint: config.ingestionEndpoint,
    installationId: credentials.installationId,
    getAuthToken: async () =>
      (await registrationClient.getStoredCredentials())?.installationToken,
  });

  collector = new EventCollector({
    config,
    identity: {
      userId: credentials.userId,
      installationId: credentials.installationId,
      // A fresh session id per IDE window, which is what "session" means here.
      sessionId: randomUUID(),
    },
    contextProvider,
    queue,
    transport,
    logger,
  });

  await collector.start();

  collector.capture({
    eventType: EVENT_TYPES.SESSION_STARTED,
    payload: { ide_version: vscode.version, platform: process.platform },
  });
  collector.capture({
    eventType: EVENT_TYPES.EXTENSION_ACTIVATED,
    payload: { extension_version: context.extension?.packageJSON?.version },
  });

  adapter = new VSCodeAdapter(IDE_NAME, config, contextProvider, git);
  adapter.activate(collector);

  logger.info("collector active", {
    ide: IDE_NAME,
    capabilities: adapter.capabilities,
  });
  startStatusBar(context);
}

/**
 * Imports a credential staged by `ide-collector login`.
 *
 * The CLI cannot reach VS Code's SecretStorage, so it leaves the credential in
 * a 0600 file. This moves it into the OS keychain and deletes the file, so the
 * plaintext token exists on disk for as long as it takes the user to restart
 * the IDE rather than indefinitely.
 *
 * An expired or malformed file is deleted rather than imported: a credential
 * that sat around long enough to expire is one we should make the user
 * re-issue, not quietly accept.
 */
async function importStagedCredential(
  registrationClient: RegistrationClient,
  logger: Logger
): Promise<void> {
  const path = join(homedir(), ".ide-collector", "pending-credential.json");

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return; // Nothing staged, which is the normal case.
  }

  const discard = async (reason: string) => {
    await rm(path, { force: true }).catch(() => undefined);
    logger.warn("discarded staged credential", { reason });
    vscode.window.showWarningMessage(
      `IDE Event Collector: staged credential ${reason}. Run \`ide-collector login\` again.`
    );
  };

  let payload: {
    version?: number;
    installation_id?: string;
    installation_token?: string;
    user_id?: string;
    expires_at?: string;
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    await discard("was unreadable");
    return;
  }

  if (
    payload.version !== 1 ||
    !payload.installation_id ||
    !payload.installation_token ||
    !payload.user_id
  ) {
    await discard("was malformed");
    return;
  }

  const expiresAt = Date.parse(payload.expires_at ?? "");
  if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
    await discard("expired before it was imported");
    return;
  }

  await registrationClient.storeCredentials({
    installationId: payload.installation_id,
    installationToken: payload.installation_token,
    userId: payload.user_id,
  });

  // Only remove the file once the keychain write succeeded, so a failure there
  // does not lose the credential entirely.
  await rm(path, { force: true }).catch(() => undefined);

  logger.info("imported staged credential from the CLI", {
    installationId: payload.installation_id,
  });
  vscode.window.showInformationMessage(
    "IDE Event Collector: credential imported and stored in your OS keychain."
  );
}

async function stopCollector(): Promise<void> {
  adapter?.deactivate();
  adapter = undefined;
  await collector?.dispose();
  collector = undefined;
  updateStatusBar("$(circle-slash) Collector off");
}

/**
 * Wraps the on-disk queue in AES-256-GCM when enabled. The key lives in the OS
 * keychain, so the queue file alone is useless to anyone reading the disk.
 */
async function buildPersistence(
  context: vscode.ExtensionContext,
  queuePath: string,
  encrypt: boolean,
): Promise<QueuePersistence> {
  const fileStore = new FileSystemQueuePersistence(queuePath);
  if (!encrypt) return fileStore;

  let key = await context.secrets.get(QUEUE_ENCRYPTION_KEY);
  if (!key) {
    key = generateInstallationSecret();
    await context.secrets.store(QUEUE_ENCRYPTION_KEY, key);
  }
  return new EncryptedQueuePersistence(fileStore, key);
}

async function registerInstallation(
  context: vscode.ExtensionContext,
  registrationClient: RegistrationClient,
  logger: Logger,
): Promise<void> {
  const config = readConfig();

  const enrollmentCode = await vscode.window.showInputBox({
    title: "IDE Event Collector - Register Installation",
    prompt: "Paste the enrollment code issued by your platform administrator",
    password: true,
    ignoreFocusOut: true,
    placeHolder:
      "Leave blank only if your backend allows open enrollment (development)",
  });

  // `undefined` means the user dismissed the box; an empty string is a
  // deliberate choice to try open enrollment.
  if (enrollmentCode === undefined) return;

  try {
    const credentials = await registrationClient.register({
      registrationEndpoint: config.registrationEndpoint,
      enrollmentCode,
      ide: { name: IDE_NAME, version: vscode.version },
      machineId: vscode.env.machineId,
    });

    logger.info("installation registered", {
      installationId: credentials.installationId,
    });
    vscode.window.showInformationMessage(
      `IDE Event Collector registered (installation ${credentials.installationId.slice(0, 8)}...).`,
    );

    await stopCollector();
    await startCollector(context, registrationClient, logger);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("registration failed", { error: message });
    vscode.window.showErrorMessage(
      `IDE Event Collector registration failed: ${message}`,
    );
  }
}

async function showStatus(
  registrationClient: RegistrationClient,
): Promise<void> {
  const credentials = await registrationClient.getStoredCredentials();
  const metrics = collector?.getMetrics();

  const lines = [
    `IDE:               ${IDE_NAME} ${vscode.version}`,
    `Telemetry:         ${readConfig().enabled ? "enabled" : "disabled"}`,
    `Registered:        ${credentials ? "yes" : "no"}`,
    `Installation:      ${credentials?.installationId ?? "-"}`,
    `Queue size:        ${metrics?.queueSize ?? 0}`,
    `Events captured:   ${metrics?.eventsCaptured ?? 0}`,
    `Events sent:       ${metrics?.eventsSent ?? 0}`,
    `Events throttled:  ${metrics?.eventsThrottled ?? 0}`,
    `Events dropped:    ${metrics?.eventsDropped ?? 0}`,
    `Flush failures:    ${metrics?.flushFailures ?? 0}`,
    `Last flush:        ${metrics?.lastFlushAt ?? "never"}`,
    `Last error:        ${metrics?.lastErrorMessage ?? "none"}`,
  ];

  outputChannel?.appendLine(lines.join("\n"));
  outputChannel?.show(true);
}

function startStatusBar(context: vscode.ExtensionContext) {
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    statusBarItem.command = "ideCollector.showStatus";
    context.subscriptions.push(statusBarItem);
  }
  updateStatusBar("$(pulse) Collector on");

  const interval = setInterval(() => {
    const metrics = collector?.getMetrics();
    if (!metrics) return;
    updateStatusBar(
      metrics.queueSize > 0
        ? `$(cloud-upload) Collector ${metrics.queueSize} queued`
        : "$(pulse) Collector on",
    );
  }, 10_000);
  (interval as unknown as { unref?: () => void }).unref?.();
  context.subscriptions.push({ dispose: () => clearInterval(interval) });
}

function updateStatusBar(text: string) {
  if (!statusBarItem) return;
  statusBarItem.text = text;
  statusBarItem.tooltip = "IDE Event Collector - click for status";
  statusBarItem.show();
}

/**
 * Cursor and Windsurf are VS Code forks; `vscode.env.appName` is how they
 * identify themselves at runtime. Falling back to "vscode" is correct for
 * genuine VS Code and safe for any other fork.
 */
function detectIdeName(): string {
  try {
    const appName = (vscode.env?.appName ?? "").toLowerCase();
    if (appName.includes("cursor")) return "cursor";
    if (appName.includes("windsurf")) return "windsurf";
    return "vscode";
  } catch {
    return "vscode";
  }
}
