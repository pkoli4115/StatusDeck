# Commands

From the extracted app root:

```cmd
node scripts\regression-check.mjs
```

Expected: `66 regression checks passed.`

Build the Custom UI:

```cmd
cd static\hello-world
npm ci
npm run build
```

If your existing node_modules is already valid:

```cmd
cd static\hello-world
npm run build
```

Then:

```cmd
cd ..\..
forge lint
forge deploy -e development
```

No manifest/scopes were changed, so a Forge install upgrade should not be required.
After deploy, hard refresh Jira with Ctrl+Shift+R.
