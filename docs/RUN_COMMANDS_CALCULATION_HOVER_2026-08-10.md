# Run commands

From the application root:

```cmd
node scripts\regression-check.mjs
cd static\hello-world
npm ci
npm run build
cd ..\..
forge lint
forge deploy -e development
```

If `node_modules` is already known-good:

```cmd
node scripts\regression-check.mjs
cd static\hello-world
npm run build
cd ..\..
forge lint
forge deploy -e development
```

Then hard-refresh Jira with `Ctrl + Shift + R`.
