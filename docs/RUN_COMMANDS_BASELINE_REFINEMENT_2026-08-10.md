# Commands

From the extracted app root:

```cmd
node scripts\regression-check.mjs
```

Then build the frontend:

```cmd
cd static\hello-world
npm ci
npm run build
```

If node_modules is already valid, `npm run build` is sufficient.

Then:

```cmd
cd ..\..
forge lint
forge deploy -e development
```

Hard refresh Jira with Ctrl+Shift+R.
