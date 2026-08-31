# `ide-collector` CLI

Installs and configures the IDE Event Collector extension from the command line.

```bash
npx @ide-collector/cli install
npx @ide-collector/cli config set telemetry.enabled true
npx @ide-collector/cli login --code <enrollment-code> \
    --registration-endpoint https://api.example.com \
    --ingestion-endpoint https://ingest.example.com
# restart your IDE
```

## Commands

| Command | What it does |
| --- | --- |
| `install` | Detects your IDEs, resolves a `.vsix`, installs it |
| `login` | Registers this installation and stages the credential for the extension |
| `config get\|set` | Reads or writes the extension's `telemetry.*` settings |
| `doctor` | Diagnoses why collection is not working |
| `uninstall` | Removes the extension and clears local state |

Run `ide-collector --help` for the full flag list.

## How the credential reaches the extension

This is the one non-obvious part of the design.

The extension stores its installation token in the **OS keychain**, through
VS Code's `SecretStorage`. That API is only reachable from inside the extension
host — a separate CLI process cannot write to it. So `login` cannot put the
token where the extension will look for it.

Instead:

```
ide-collector login
   → registers with the control plane
   → writes ~/.ide-collector/pending-credential.json   (mode 0600, 30-min expiry)

you restart the IDE
   → extension reads the file
   → stores the token in the OS keychain
   → deletes the file
```

The staged file is the weak link, so it is deliberately short-lived: owner-only
permissions, in your home directory rather than a shared temp dir, and carrying
an expiry the extension enforces. A file that sat unimported past its expiry is
discarded rather than accepted, and you are told to log in again — a credential
old enough to expire is one worth re-issuing.

## Where the `.vsix` comes from

`install` tries three sources in order:

1. `--vsix <path>` — an explicit local file
2. A local build (`extensions/vscode/*.vsix`) if run from a repo checkout
3. The latest GitHub release

Until a release exists, contributors can build and install locally:

```bash
npm run build -w extensions/vscode
cd extensions/vscode && npx @vscode/vsce package
ide-collector install --vsix extensions/vscode/*.vsix
```

## Design notes

**No runtime dependencies beyond the workspace packages.** This CLI installs
software and handles credentials, and is meant to be run via `npx` by people
who have not audited it. Argument parsing, JSONC stripping, and IDE detection
are all implemented here rather than pulled in, because every dependency is
supply-chain surface in that position.

**Collection is never enabled implicitly.** `install` does not turn telemetry
on; a flag buried in an install command is not meaningful consent. You enable
it explicitly with `config set telemetry.enabled true` or `install --enable`.

**`config set` only writes `telemetry.*` keys.** The CLI has no business
editing arbitrary IDE settings, and refusing anything else means a typo cannot
silently rewrite an unrelated key. Every write backs up the previous
`settings.json` first.

**Settings files lose comments.** VS Code settings are JSONC; this CLI strips
comments to parse and rewrites plain JSON. That is why writes are backed up.
