# Commands

From the extracted app root:

```cmd
node scripts\regression-check.mjs
```

Then:

```cmd
cd static\hello-world
npm ci
npm run build
cd ..\..
forge lint
forge deploy -e development
```

If `node_modules` is already installed and known-good:

```cmd
node scripts\regression-check.mjs
cd static\hello-world
npm run build
cd ..\..
forge lint
forge deploy -e development
```

Because the Forge manifest/scopes are unchanged, `forge install --upgrade` is normally not required for this update.
