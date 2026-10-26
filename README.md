## @initx-plugin/env

`initx` plugin to manage env vars and secrets from a private GitHub or GitLab repository.

One private repository holds **one JSON file per store** (`stores/<name>.json`). Pull a store into a
local `.env`, inject it into a child process or CI job, or write it into GitHub Actions secrets.

```bash
initx plugin add env
```

The vault is the source of truth. Storage and execution platforms are independent: GitLab CI can
read a GitHub vault, and a GitLab vault can supply GitHub Actions secrets via `apply`. GitHub
Actions secrets are write-only; this plugin projects values from the vault into that target.
GitLab CI/CD Variables synchronization is a separate future target, not part of this release.

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

## Project configuration (GitHub or GitLab)

Commit a non-sensitive `.initx-env.json` in the business project's working directory:

```json
{
  "schema": 1,
  "storage": {
    "type": "gitlab",
    "apiBaseUrl": "https://gitlab.example.com/api/v4",
    "repo": "example-group/subgroup/env-vault",
    "branch": "main",
    "path": "stores"
  }
}
```

`type` and `repo` are required. GitLab accepts a numeric project ID (a string such as `"12345"`)
or the full namespace, including multiple subgroups. `apiBaseUrl` means the API base, including
`/api/v4` for GitLab or `/api/v3` for GitHub Enterprise. Defaults are
`https://gitlab.com/api/v4` and `https://api.github.com`. Branch defaults to `main`, directory to
`stores`; `"path": ""` explicitly selects repository root. For a GitHub vault, use `"type": "github"`
and `"repo": "owner/vault"`. Examples are in [examples](examples/).

The vault project/repository must already exist, but it can be empty. The first `env push <store>`
or `env set <store> K=V` creates the configured branch (default `main`) and the store file in one
commit, on both GitHub and GitLab. No README or manual branch creation is required. `list` and
`env-config status` report zero stores for a confirmed empty vault without writing anything.
An initialized vault with a missing configured branch still fails. The token must have permission
to create the first commit; GitLab instance rules for the initial/default branch may require a
Maintainer even when a Developer can write to other branches.

All storage commands and `env-config status` accept `--config <file>`. Relative paths resolve
against the caller's cwd. Without the flag, only cwd's `.initx-env.json` is checked; parents are
never searched. An explicitly missing file, invalid JSON, unknown schema or unknown field fails
instead of falling back. Project files cannot contain tokens, credentials or `vars`; business
values belong to the remote store (whose schema remains 1). Config files are only read.

```bash
initx env-config status --config .initx-env.json --offline
initx env run wukong-content-production --config .initx-env.json -- npm run pipeline
# When running from an isolated HOME/cwd, pass the business config's absolute path.
initx env run demo --config /workspace/business/.initx-env.json -- node /workspace/business/task.mjs
```

The config's location never changes the child cwd. `npm run pipeline` above is an example business
entry point, implemented by the consuming project. Set only `INITX_ENV_TOKEN` in CI; tokens and
business values do not belong in this file. Existing Slides invocations using `INITX_ENV_REPO`,
`INITX_ENV_BRANCH`, `INITX_ENV_PATH` and a GitHub token continue to work without new flags.

For local persisted GitLab settings (independent of a project file):

```bash
initx env-config set type gitlab
initx env-config set apiBaseUrl https://gitlab.example.com/api/v4
initx env-config set repo example-group/subgroup/env-vault
# Prefer INITX_ENV_TOKEN; if saving a token locally, select type and API address first.
initx env-config set token <gitlab-access-token>
```

Changing local type/API clears the old repo/branch/path to prevent accidental reuse. New persisted
tokens are keyed by provider and normalized full API base (including its path), not just hostname.
Legacy flat config remains GitHub config; its token is accepted only on the default GitHub API.

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

The store and the first `--` are required. Put optional `--token <token>` and `--config <file>` before `--`;
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
| Provider | Explicit override → `INITX_ENV_TYPE` → project `storage.type` → local storage type → `github` |
| API base | Explicit override → `INITX_ENV_API_BASE_URL` → project API → same-provider local API → provider default |
| Token | Explicit override / `--token` → `INITX_ENV_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` (last two only for default GitHub API) → scoped local token |
| Vault repo | Explicit override → `INITX_ENV_REPO` → project `storage.repo` → same-provider/API local `repo` |
| Branch | Explicit override → `INITX_ENV_BRANCH` → project branch → same-provider/API local branch → `main` |
| Store path | Explicit override → `INITX_ENV_PATH` → project path → same-provider/API local path → `stores` |

Empty strings fall back to the next source. Environment settings affect the current invocation
only and are never written back to the plugin store. `env-config status --offline` shows the
effective settings with a masked token; `get` / `list` show the persisted settings. `env apply
--repo o/r` still selects the destination Actions repository, not the vault. `run` has no `--repo`.

The provider is resolved first; values from another provider/API are never inherited. `GH_TOKEN`
and `GITHUB_TOKEN` are never sent to GitLab or custom API bases. `--token` and `INITX_ENV_TOKEN`
explicitly authorize the selected current target. Authenticated requests do not follow redirects,
have a 30-second timeout, and are not automatically retried (a failed write may have committed).
Status shows per-field sources, provider, API base, repo/ref/path, config file and fully masked
token source. `get/list/set/rm` operate only on persisted local settings, never project files.

## Use in GitLab CI

Preinstall fixed versions of initx and this plugin in the CI image, or prepare them with an explicit
noninteractive installation step. Do not rely on a first-run plugin installation prompt. This
implementation is smoke-tested with **initx 0.4.3**; compatible versions must expose the untouched
tail as `ctx.cliOptions['--']: string[]`, keep child flags out of prefix help/version handling, and
preserve `process.exitCode` after handlers finish. Older versions have not been verified.

Commit `.initx-env.json` as above and set a protected, masked `INITX_ENV_TOKEN` in GitLab. For a
GitLab vault, use a Personal/Project Access Token with `read_api` and access to the vault project;
local writes require `api` plus branch permissions. Check both Files and Tree access on your
instance. For a GitHub vault, use **Contents: read** access. Runner platform does not select storage.

```yaml
pipeline:
  script:
    - initx env run wukong-content-production --config "$CI_PROJECT_DIR/.initx-env.json" -- npm run pipeline
```

This illustrates the integration point; prepare pinned initx/plugin versions noninteractively in
your CI image first. This feature is not published by this change: use a tested local build until
a separate release exists, then pin that released version. Let the business script orchestrate its
own workflow; the plugin does not hard-code business variable names or perform deployments. Scripts may
materialize multiline SSH keys as needed, set file permissions and clean them up; `run` does not
create key files or pass them through artifacts/cache.

Fetched variables are **not automatically registered as GitLab masked variables**. Disable command
tracing that could print them. Vault read permissions apply to the entire repository, not to a
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

## Apply to GitHub Actions

`apply --repo owner/target` always selects the destination GitHub repository. Its vault is resolved
independently via `--config`/environment/local settings. For a GitLab or custom-host source, set
`INITX_ENV_TARGET_TOKEN` (recommended for CI) or `--target-token <github-token>` with Secrets write
access to the target. The source token never crosses providers/hosts. `GH_TOKEN`/`GITHUB_TOKEN`
are not implicit target credentials for these cross-platform calls. `--dry-run` also validates
that independent target credentials are configured, but makes no target API call.

```bash
initx env apply demo --config .initx-env.json --repo owner/target --dry-run
# Same invocation without --dry-run writes GitHub Actions secrets.
# Supply INITX_ENV_TOKEN for the vault and INITX_ENV_TARGET_TOKEN for the target in the environment.
```

Existing default GitHub API vault → default GitHub Actions calls may continue reusing the source
token. Explicit target credentials take precedence. `targets.secrets` retains its schema-1 shape.
GitLab CI Variables writing and CI_JOB_TOKEN support are deferred. Deploy Tokens used for git clone
are not Files/Tree API tokens.

## Storage guarantees and GitLab compatibility

Commands use an explicit adapter factory; the store service deals only in UTF-8 content and opaque
`version` values. GitHub uses the file SHA; GitLab uses the file's `last_commit_id`, never Tree blob
IDs. Creates are explicit, updates/deletes carry the expected version. Conflict responses are
verified by a safe reread; GitHub 422 and GitLab 400 are not automatically conflicts. GitLab's
unchanged-content 400 is accepted only if the file still has the expected version and exact content.
`push --force` rereads and retries once; permission/validation/network errors do not trigger it.
The existing force semantics overwrite using the locally prepared store, including its routing
hints; concurrent remote-only changes can be replaced. Pull/review before force if those matter.

GitLab uses Files GET/POST/PUT, a conditional Commits delete action, and Tree offset pagination
(`per_page=100`). It supports full subgroups and numeric IDs, and does not require keyset pagination, newer Tree metadata or job-token
features. Missing paths are empty only after validating repository/ref access or confirming an
empty repository (GitLab project `empty_repo`, GitHub's explicit empty-repository response). Tree accepts both
legacy 200 empty arrays and newer 404 responses. Directory listing is not recursive. Errors expose
only a category, safe hint and HTTP status, never upstream response text or request URLs.

The implementation targets GitLab CE **15.9.4**, with mock coverage for its API behavior. This is
not a claim of real-instance acceptance. Use a temporary vault with non-sensitive dummy values to
verify read_api Files/Tree/commit access, pagination, encoded refs/paths, protected-branch errors,
create races and stale update/delete rejection on your actual instance. Record token type, scope,
role and instance version. See [implementation and acceptance record](docs/gitlab-storage-implementation.md).
API references: [Files](https://docs.gitlab.com/api/repository_files/),
[Tree](https://docs.gitlab.com/api/repositories/),
[Deploy Token limitations](https://docs.gitlab.com/user/project/deploy_tokens/).

One deliberate change from the initial plan: 15.9.4's Files DELETE does not declare
`last_commit_id`, so it discards that condition. Deletion therefore uses the existing Commits API
with one `delete` action containing `last_commit_id`; it does not rely on a client-side precheck.
The versioned [Files route](https://github.com/gitlabhq/gitlabhq/blob/v15.9.4/lib/api/files.rb),
[Commits route](https://github.com/gitlabhq/gitlabhq/blob/v15.9.4/lib/api/commits.rb) and
[MultiService check](https://github.com/gitlabhq/gitlabhq/blob/v15.9.4/app/services/files/multi_service.rb)
provide the compatibility basis; real-instance testing remains required.

The known legacy protected-branch 400 message is recognized as permission failure using an exact
literal from [v15.9.4 CreateService](https://github.com/gitlabhq/gitlabhq/blob/v15.9.4/app/services/commits/create_service.rb).
Arbitrary response messages are never forwarded to the caller or printed.

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
- **Token permissions**: GitHub vaults need **Contents** read/write; GitLab vaults use `read_api`
  for reads or `api` for writes, plus project/branch access. `apply` needs **Secrets: write** on the
  GitHub target. Default GitHub API calls can share a classic PAT with `repo`; other sources use
  independent target credentials. Organization secrets are not supported.
- **Output is masked**: tokens print as `***`, values are never printed by `list` / `get` / `status`.

## Development

Do not install the `initx` CLI as a dependency or test tool in this project. Use the existing
core/utils SDKs, mocks and command-handler fixtures. Historical CLI checks and business CI
installation examples do not change this rule; see [AGENTS.md](AGENTS.md).

```bash
pnpm install
pnpm stub        # unbuild --stub, then: initx plugin add .
pnpm test        # vitest
pnpm build
pnpm lint
pnpm typecheck
```

`pnpm test` runs unit tests and isolated child-process fixtures with fake GitHub/GitLab responses and
temporary directories. Tests use the existing core matcher and direct command handlers, without
installing or importing the initx CLI. Child-process tests check execution markers and nonzero
exit codes. No real vault, DNS, SSH or
GitHub/GitLab write endpoint is used. The Linux/Windows CI matrix runs the same checks. Platform-specific
coverage and the local verification record are in [env run implementation](docs/env-run-implementation.md).

## License

MIT
