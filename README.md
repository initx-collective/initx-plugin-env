## @initx-plugin/env

`initx` plugin to manage env vars and secrets from one private GitHub repo.

One private repository holds **one JSON file per store** (`stores/<name>.json`). Pull a store into a
local `.env`, inject it into a CI job, or write it into GitHub Actions secrets.

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

# export for the current shell session
eval "$(initx env setup mail-peon-publish --stdout)"
```

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
- **No local cache.** Values are fetched on every run; nothing is written to disk except the target
  `.env` file (and a `<file>.bak` backup).
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
```

## License

MIT
