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

Because this release adds Confluence scopes and multi-app compatibility, refresh the Jira installation permissions and connect Confluence on the same Atlassian site:

```cmd
forge install --upgrade -p jira -e development
forge install -p confluence -e development
```

If the optional Confluence app is already connected, use:

```cmd
forge install --upgrade -p confluence -e development
```

Then hard refresh Jira (`Ctrl + Shift + R`).
