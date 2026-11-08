---
name: Bug report
about: Something went wrong during import, rollback, or in the settings page
title: '[bug] '
labels: bug
assignees: ''
---

## What happened

<!-- Describe the problem. If DSH showed an error, paste it verbatim. -->

## Error text

```
<!-- paste the exact message here, e.g.
历史加载失败：stored session "session-wb-..." is corrupt: ...
-->
```

## Steps to reproduce

1.
2.
3.

## Which part

- [ ] Settings page (browsing / selecting sessions)
- [ ] Import itself
- [ ] Compact import
- [ ] Opening the imported session
- [ ] Continuing a conversation in the imported session
- [ ] Rollback
- [ ] Model tools (`wb_list_sessions` / `wb_import_session` / `wb_rollback_import`)

## Environment

- DSH version:
- Plugin version (`package.json` → `version`, or the settings page footer):
- OS:
- Node version:

## Session details (optional)

<!-- These help a lot when the issue is about a specific session. -->

- Source session id (WorkBuddy):
- Number of turns / approximate size:
- Compact import used? yes / no
- If compact: `recentTurns` value:

## Console output (optional)

<!-- If the session fails to render, DSH's DevTools console usually shows the
     real cause. Paste the red lines here. -->

```
```

## Anything else

<!-- Screenshots, guesses, related issues -->
