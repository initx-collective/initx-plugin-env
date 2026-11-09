import { defineConfig } from '@initx-plugin/env'

export default defineConfig({
  schema: 1,
  storage: {
    // Change to 'gitlab' and use the GitLab API base for a GitLab vault.
    type: 'github',
    apiBaseUrl: 'https://api.github.com',
    repo: 'example-owner/env-vault',
    branch: 'main',
    path: 'stores'
  }
})
