---
name: Workflow
branch: test
run: checks.yml
---

# The workflow plugin's part

## Before a build

`npm ci` when `package-lock.json` differs from the last install.

## While working

`npm test` for the hooks (`test/hooks.test.ts`), run after each change to
a script; `claude plugin validate plugins/workflow` after a
change to an agent file, the manifest or the hooks.

## Before the push

`npm run format`, `npm test`, `npm run validate`. No screenshots: nothing
here is a screen.

## After the push

`checks.yml` on `test` runs the same and, green, fast-forwards `main`,
which every machine installs from; a red run holds `main` where it was.

## Reading

The scripts are read whole with Read; they are the product.
