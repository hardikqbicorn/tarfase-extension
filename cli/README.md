# `ide-collector` CLI

Installs and configures the IDE Event Collector extension from the command line.

```bash
npx @ide-collector/cli setup \
  --registration-endpoint https://api.example.com \
  --endpoint https://ingest.example.com
```

That is the whole thing. `setup` finds your IDE, installs the extension, shows
you what is and is not collected, waits for you to agree, writes the endpoints,
registers the installation, and hands the credential to the extension. Open
your IDE and it starts collecting.

Add `--code <enrollment-code>` if your platform issues them, and `--yes` to
accept the collection notice up front (required when there is no terminal to
prompt in — a provisioning script, say).

> Not published to npm yet. From a checkout of this repo, `npm install` links
> the CLI, so `npx ide-collector setup` runs it and installs a locally built
> `.vsix`.

## Commands

| Command | What it does |
| --- | --- |
| `setup` | All of the below, in one command |
| `install` | Detects your IDEs, resolves a `.vsix`, installs it |
| `login` | Registers this installation and stages the credential for the extension |
| `config get\|set` | Reads or writes the extension's `telemetry.*` settings |
| `doctor` | Diagnoses why collection is not working |
| `uninstall` | Removes the extension and clears local state |

The individual commands are still there for anything that needs them
separately — reconfiguring endpoints, re-registering after a token is revoked,
installing without enabling. `setup` is the path a new user takes.

Run `ide-collector --help` for the full flag list.

## Consent

`setup` prints what the extension records and waits for a yes. That prompt is
the only step that does not collapse into a flag, and it is deliberate: this
tool watches what you type, so agreeing to it has to be something you did
rather than something that happened.

The interesting case is the one with no terminal — CI, a pipe, a provisioning
script. Answering on your behalf there would make the consent theatre, so
`setup` stops and tells you to pass `--yes`. Unattended installs stay possible;
they just have to say so.

`install` on its own never enables collection, for the same reason: a flag
buried in an install command is not meaningful consent.

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

the extension notices, within seconds
   → reads the file
   → stores the token in the OS keychain
   → deletes the file
```

The extension watches that directory, and re-checks whenever its window gains
focus. Two triggers rather than one because `fs.watch` does not fire on every
filesystem, and running a CLI in a terminal then switching back to the IDE is
exactly the sequence that stages a credential. Either way there is nothing to
restart.

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
npm run package -w extensions/vscode   # builds, bundles, writes a .vsix
npx ide-collector setup                # picks it up from the checkout
```

The `package` script bundles before packaging, and that matters: a `.vsix`
ships no `node_modules`, and the extension imports four workspace packages. An
unbundled build packages cleanly and then fails on activation — installed,
listed, and doing nothing.

## Design notes

**No runtime dependencies beyond the workspace packages.** This CLI installs
software and handles credentials, and is meant to be run via `npx` by people
who have not audited it. Argument parsing, JSONC stripping, and IDE detection
are all implemented here rather than pulled in, because every dependency is
supply-chain surface in that position.

**`config set` only writes `telemetry.*` keys.** The CLI has no business
editing arbitrary IDE settings, and refusing anything else means a typo cannot
silently rewrite an unrelated key. Every write backs up the previous
`settings.json` first.

**Settings files lose comments.** VS Code settings are JSONC; this CLI strips
comments to parse and rewrites plain JSON. That is why writes are backed up.
