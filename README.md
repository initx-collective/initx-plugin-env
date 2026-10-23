## @initx-plugin/env

`initx` plugin to manage env vars and secrets from one private GitHub repo.

One private repository holds **one JSON file per store** (`stores/<name>.json`). Pull a store into a
local `.env`, inject it into a child process or CI job, or write it into GitHub Actions secrets.

```bash
initx plugin add env
```

## Why another secrets tool

Almost every existing tool (dotenvx, sops, 1Password, Doppler, Infisical, Vault) **injects** secrets
into a process. None of them writes values back into GitHub's secret storage — that is the gap this
plugin fills. It also keeps one honest boundary:

> **CI → local sync is impossible.** GitHub Actions secrets are write-only: the API returns
> `name` / `created_at` / `updated_at` and never the value. So the vault repo is always the source of
> truth and CI is always a one-way projection.

## Setup

```bash
npm i -g initx          # optional, otherwise use npx
initx plugin add env

initx env-config set repo <owner/repo>   # the private repo that holds your stores
initx env-config set token <pat>         # classic PAT with the `repo` scope is enough
initx env-config set path stores         # optional, default: stores
initx env-config status                  # prints the config (token masked) + checks connectivity
```

The config lives in `~/.initx/stores/@initx-plugin/env/store.json`. The token is stored **in
plaintext** there (same trade-off as `@initx-plugin/cp`) — set `INITX_ENV_TOKEN` instead if you would
rather keep it out of a file.

## Commands

| Command | What it does |
| --- | --- |
| `initx env list` | List the stores in the vault repo |
| `initx env pull [store]` | Pull a store into a local `.env` (asks which store / which file when ambiguous) |
| `initx env set <store> K=V ...` | Write variables into a store (the store name **is** the file name) |
| `initx env push <store>` | Update a store from a local `.env` |
| `initx env setup [store]` | Inject a store into **this** environment (CI job or shell) |
| `initx env run <store> -- <command> [...args]` | Inject a store directly into one child process and return its exit status |
| `initx env apply <store> --repo o/r` | Write a store into a repo's GitHub Actions secrets |

```bash
# write / update a store
initx env set mail-peon-publish EXTENSION_ID=abc CHROME_REFRESH_TOKEN=1//0g...

# pull it into a local .env (keeps your other keys, comments and order)
initx env pull mail-peon-publish
initx env pull mail-peon-publish --to .env.local --dry-run

# push local changes back
initx env push mail-peon-publish --from .env.local
initx env push mail-peon-publish --prune      # also drop remote keys missing locally

# run a script with the store's original values (including real newlines)
initx env run mail-peon-publish -- node scripts/publish.mjs
```

## Run a command locally or in CI

```bash
initx env run demo -- node scripts/check.mjs
initx env run demo -- node --version
initx env run acewill-slidev-production -- pnpm deploy
initx env run demo -- bash scripts/deploy.sh
```

The store and the first `--` are required. Put the plugin's optional `--token <token>` before `--`;
every argument after it belongs to the child, including `--help`, `--version`, `--token`, another
`--`, empty strings and arguments with spaces. Extra positional arguments and other plugin flags
(including `--repo`, `--json`, `--stdout`, `--only`, `--shell`, `--cwd`) are rejected before reading
the vault. Help before `--` is handled by initx; help after it is passed to the child.

The child inherits the caller's working directory, stdin, stdout, stderr and environment. Store
variables override inherited values without changing the calling shell. Empty values, CRLF, real
newlines, Unicode and punctuation are preserved; values are never expanded. Empty stores are valid.
Variable names must match `^[A-Za-z_][A-Za-z0-9_]*$`, and values cannot contain NUL. All values are
validated before starting the child. Windows names are case insensitive: a store's `PATH` replaces
an inherited `Path`, and conflicting store names such as `FOO` / `foo` abort. Other commands retain
their existing name validation rules.

Arguments are passed as an array. The plugin does not interpret shell expressions, pipelines or
redirection. Explicitly run a shell or, preferably, write a script for multiple operations. One
`run` affects only that child and its descendants; the next independent CI command does not inherit
the fetched store. `cross-spawn` is the runtime dependency used to resolve executables and escape
Windows npm/pnpm `.cmd` launchers without enabling `shell: true` for every command
([upstream behavior](https://github.com/moxystudio/node-cross-spawn#why)).

Normal exits preserve the child's code, including nonzero codes. Missing commands return 127,
permission failures return 126, and parameter/configuration/read/validation/other startup failures
return 1. On POSIX, signal termination is reproduced after initx has finished its store cleanup,
with a nonzero `128 + signal number` fallback. Parent SIGINT/SIGTERM events are forwarded once to
the direct child, with a 5-second grace period followed by best-effort SIGKILL. Listeners are removed
when execution finishes. Background processes detached from the direct child are outside this
contract; deployment scripts should stay in the foreground.

On Windows, Node's process termination APIs do not deliver catchable POSIX signals: forwarding
SIGINT/SIGTERM can terminate the direct child immediately, and the wrapper returns 130/143. A
console Ctrl+C event received by Node uses the same forwarding handler. `.cmd` launchers can have
descendant processes; this version does not guarantee termination of that whole tree. Windows
tests exercise the real direct-child termination and listener cleanup by triggering the parent's
signal event over IPC; interactive console Ctrl+C still needs a manual console check.

`run` writes no `.env`, `$GITHUB_ENV`, dotenv artifact or secret cache, and emits no GitHub masking
protocol. Its own diagnostics go to stderr without values, tokens, complete response bodies or
command argument lists. **Child output is inherited without masking**: a script can still print
secrets. The parent environment, including inherited GitHub tokens, is retained. This is process
injection for trusted scripts and stores, not an isolation sandbox or encrypted secret manager.
The stdout form of `setup` remains intended for inspection/legacy use; use `run` for exact values.

## Configuration precedence

| Setting | Highest to lowest priority |
| --- | --- |
| Token | Explicit override / `--token` → `INITX_ENV_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` → persisted token |
| Vault repo | Explicit override → `INITX_ENV_REPO` → persisted `repo` |
| Branch | Explicit override → `INITX_ENV_BRANCH` → persisted `branch` → `main` |
| Store path | Explicit override → `INITX_ENV_PATH` → persisted `path` → `stores` |

Empty strings fall back to the next source. Environment settings affect the current invocation
only and are never written back to the plugin store. `env-config status --offline` shows the
effective settings with a masked token; `get` / `list` show the persisted settings. `env apply
--repo o/r` still selects the destination Actions repository, not the vault. `run` has no `--repo`.

## Use in GitLab CI

Preinstall fixed versions of initx and this plugin in the CI image, or prepare them with an explicit
noninteractive installation step. Do not rely on a first-run plugin installation prompt. This
implementation is smoke-tested with **initx 0.4.3**; compatible versions must expose the untouched
tail as `ctx.cliOptions['--']: string[]`, keep child flags out of prefix help/version handling, and
preserve `process.exitCode` after handlers finish. Older versions have not been verified.

Set a protected, masked `INITX_ENV_TOKEN` in GitLab with **Contents: read** access to the vault only.
Repository, branch and path can be ordinary YAML variables:

```yaml
deploy:
  stage: deploy
  variables:
    INITX_ENV_REPO: example/private-env-vault
    INITX_ENV_BRANCH: main
    INITX_ENV_PATH: stores
  script:
    - initx env run acewill-slidev-production -- pnpm deploy
```

This illustrates the integration point, not a complete pipeline. Keep deployment variables out of
the build job. Let `pnpm deploy` orchestrate flash-dns, uploads, release switching and verification;
the plugin does not hard-code their variable names or perform deployment operations. Scripts may
materialize multiline SSH keys as needed, set file permissions and clean them up; `run` does not
create key files or pass them through artifacts/cache.

Fetched variables are **not automatically registered as GitLab masked variables**. Disable command
tracing that could print them. Vault Contents permissions apply to the entire repository, not to a
store filename: use separate repositories for separate trust boundaries. The private JSON store and
its Git history remain plaintext.

## Use in GitHub Actions

The built-in `GITHUB_TOKEN` can only read **the repository the workflow runs in**, so a separate vault
repo needs its own token (one secret):

```yaml
- run: npx --yes initx plugin add env

# inject into this job: every later step sees $EXTENSION_ID / $CHROME_REFRESH_TOKEN
- run: npx --yes initx env setup mail-peon-publish --token "${{ secrets.ENV_VAULT_TOKEN }}"

# or write them into the repo's Actions secrets once (needs secrets write permission)
- run: npx --yes initx env apply mail-peon-publish --repo "${{ github.repository }}"
  env:
    INITX_ENV_TOKEN: ${{ secrets.ENV_VAULT_TOKEN }}
```

`env setup` writes to `$GITHUB_ENV` and emits `::add-mask::` for every value before it does, so the
values do not show up in logs. Values with newlines use the heredoc (`KEY<<EOF`) form.

## Store format

```jsonc
// stores/mail-peon-publish.json
{
  "schema": 1,
  "vars": {
    "EXTENSION_ID": "abcdefghijklmnopabcdefghijklmnop",
    "CHROME_REFRESH_TOKEN": "1//0g..."
  },
  "targets": { // optional routing hints
    "envFiles": [".env.local"], // pull: skip the file picker
    "secrets": [{ "repo": "mail-peon/mail-peon", "env": null }] // apply: default destination
  }
}
```

## Good to know

- **Values are stored as plaintext JSON in v1.** The repo is private, but anything committed stays in
  git history forever — rotate the values if that repo ever becomes public. Encryption is planned and
  will be orthogonal to the command surface (dotenvx / sops + age).
- **No local cache.** Values are fetched on every invocation. `pull` writes its target `.env` file
  and backup; `setup` may write `$GITHUB_ENV`; `run` does not persist fetched values.
- **`apply` constraints** (GitHub's, not ours): secret values are write-only; a single secret is
  capped at 48 KB; names may only contain `[A-Za-z0-9_]`, cannot start with a digit or `GITHUB_`, and
  are stored uppercased. Illegal names abort the command unless you pass `--skip-invalid`.
- **Token permissions**: read/write **Contents** on the vault repo, plus **Secrets: write** on the
  target repo for `apply`. A classic PAT with `repo` covers both; organisation-level secrets would
  additionally need `admin:org` (not supported in v1).
- **Output is masked**: tokens print as `***`, values are never printed by `list` / `get` / `status`.

## Development

```bash
pnpm install
pnpm stub        # unbuild --stub, then: initx plugin add .
pnpm test        # vitest
pnpm build
pnpm lint
pnpm typecheck
```

`pnpm test` runs unit tests and isolated child-process fixtures with fake GitHub responses and
temporary directories. It does not install or invoke the initx CLI. No real vault, DNS, SSH or
GitHub write endpoint is used. The Linux/Windows CI matrix runs the same checks. Platform-specific
coverage and the local verification record are in [env run implementation](docs/env-run-implementation.md).

## License

MIT
