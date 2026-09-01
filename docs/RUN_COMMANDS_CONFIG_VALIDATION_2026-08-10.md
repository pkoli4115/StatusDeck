# Commands

From app root:

```cmd
node scripts\regression-check.mjs
cd static\hello-world
npm ci
npm run build
cd ..\..
forge lint
forge deploy -e development
```

If node_modules is already valid:

```cmd
node scripts\regression-check.mjs
cd static\hello-world
npm run build
cd ..\..
forge lint
forge deploy -e development
```

After deploy: Ctrl + Shift + R in Jira.
