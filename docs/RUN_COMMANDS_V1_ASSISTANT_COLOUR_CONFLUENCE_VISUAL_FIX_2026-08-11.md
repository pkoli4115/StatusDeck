# Run commands

From the project root:

```cmd
node scripts\regression-check.mjs
cd static\hello-world
npm ci
npm run build
cd ..\..
forge lint
forge deploy -e development
```

No new manifest scopes are introduced by this patch, so if the previous Confluence-enabled build is already installed, no `forge install --upgrade` is required solely for this patch.

Then hard refresh Jira with `Ctrl + Shift + R`.
