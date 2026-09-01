# Commands

From the app root:

```cmd
node scripts\regression-check.mjs
cd static\hello-world
npm run build
cd ..\..
forge lint
forge deploy -e development
```

No new scopes were added by this hotfix. If the prior Confluence-enabled v1 package is already installed/upgraded, no additional `forge install --upgrade` is required for this hotfix.
