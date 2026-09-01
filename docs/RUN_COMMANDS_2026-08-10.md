# Run commands

From the StatusDeck app root:

```cmd
node scripts\regression-check.mjs
```

Expected result: `51 regression checks passed.`

Frontend build:

```cmd
cd static\hello-world
npm ci
npm run build
```

If dependencies are already installed and known-good:

```cmd
cd static\hello-world
npm run build
```

Return to app root and validate/deploy:

```cmd
cd ..\..
forge lint
forge deploy -e development
```

Then hard refresh Jira with `Ctrl + Shift + R`.
