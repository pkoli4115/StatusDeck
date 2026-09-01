# Run commands — StatusDeck UI v1 Context Catalogue + Confluence Sprint Pages

From the extracted project root:

```cmd
node scripts\regression-check.mjs

cd static\hello-world
npm ci
npm run build

cd ..\..
forge lint
forge deploy -e development
forge install --upgrade -p jira -e development
forge install --upgrade -p confluence -e development
```

When Forge asks for the site, use:

```text
qtilabs1.atlassian.net
```

Then hard-refresh Jira with `Ctrl + Shift + R`.

If `node_modules` is already valid, `npm ci` may be skipped and `npm run build` can be run directly.
