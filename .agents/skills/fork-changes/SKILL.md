---
name: fork-changes
description: Change the vleonbonnet/opencode fork so that upstream merges stay clean, and resolve an upstream merge by hand. Use before you change code on the fork's main branch, and when maintenance reports "upstream merge conflicts" for the opencode checkout.
---

# Fork changes

The fork's `main` merges upstream `dev` (`https://github.com/anomalyco/opencode.git`) automatically. The sync resolves conflicts only in generated files: the drizzle snapshot, the migration registry, the OpenAPI document and the generated client. Any other conflict aborts the merge, and the fork stops getting upstream changes until someone merges by hand. Each fork line next to a line that upstream changes can cause that conflict.

Done means: the change works, and `git diff --no-ext-diff upstream/dev...HEAD -- FILE` shows only the lines that the change needs in each upstream file.

## Change the fork

1. Put new fork code in files of its own: a module, a service or a test under `test/fork`. Call it from upstream code with as few lines as possible.
2. Keep upstream's text. Do not reformat, re-indent, re-wrap, reorder or reword upstream lines, including comments and doc comments.
3. Put fork imports after upstream's imports, in a group of their own after a blank line. Give a name the fork imports from a module that upstream also imports from its own statement there.
4. Keep upstream signatures. To pass more to an upstream function, extend its options interface by declaration merging in a fork block at the end of the file. For example, `Tool.SnapshotOptions` gets `exposure` and `ceilings` that way, at the end of `packages/core/src/tool.ts`. When there is no options object, add optional parameters after upstream's.
5. Do not wrap an upstream block in a callback or a new scope. Put the fork's logic in a helper and call it on one line before or after the block. For example, the cache gate's `gate.build` and `gate.consent` calls sit around upstream's request building in `packages/core/src/session/runner/llm.ts`.
6. Do not add fork members to an upstream service interface. Make a service of its own, as `SessionPreflight` is.
7. Do not append fork lines at the end of an upstream list of service bindings, layer dependencies or fields. Upstream appends there too. Insert them after a line in the middle of the list.
8. Put fork tests under `test/fork`. When a test needs a large upstream harness, put it in `test/fork/hosted` and export `forkTests(harness)`. The upstream test file then has only the import and one call at its end.
9. When the fork moves upstream code into a fork module, re-export it where upstream had it, with a one-line comment that says where to port upstream's changes. A conflict there is useful: it shows an upstream change that the fork must port. For example, permission matching lives in `packages/core/src/permission/match.ts`.
10. When upstream ships what a fork change does, drop the fork's version and use upstream's.

## Merge upstream by hand

1. Make a worktree of `main` on a new branch, install with `bun install --frozen-lockfile`, and run `git fetch upstream dev` and `git merge --no-edit FETCH_HEAD`.
2. For each conflict, read upstream's commit and the fork commit behind the lines. Keep both behaviors, in the shape the rules above give.
3. Run `bun install --frozen-lockfile` again, because the merge can change `bun.lock`.
4. Run `bun run check`, `bun run --cwd packages/core migration --check` and `bun run --cwd packages/core test`. Then run each package's `test/fork` with `bun run --cwd PACKAGE ../core/script/test.ts test/fork`.
5. Write the merge commit message as earlier merges do: the upstream commit, then "Dropped in favor of upstream" and "Carried onto upstream's rewrites" lists.
6. Fast-forward `main` to the merge and remove the worktree. Then retry the failure in the Emacs `*Maintenance*` buffer. The update recipe builds, validates, installs and then pushes `main` to `origin`.
