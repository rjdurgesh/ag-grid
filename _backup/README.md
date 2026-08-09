# Backups

Each `large-file-view_<timestamp>/` folder is a snapshot of the files changed for the
**large-file (windowed) log preview** feature, taken **before** that change. It mirrors
the repo layout, so you can restore any file by copying it back over the original.

`LATEST.txt` holds the newest snapshot folder name.

## Restore everything from the latest snapshot (Git Bash)

```bash
cd D:/Website/coreui
SNAP="_backup/$(cat _backup/LATEST.txt | sed 's#_backup/##')"
# (or just: SNAP=_backup/large-file-view_YYYYMMDD-HHMMSS)
cp -r "$SNAP"/backend/. backend/
cp -r "$SNAP"/src/. src/
```

## Restore a single file

```bash
cp "_backup/large-file-view_YYYYMMDD-HHMMSS/src/app/views/log_analytics/log_analytics.component.ts" \
   src/app/views/log_analytics/log_analytics.component.ts
```

Since the repo is under git, `git diff` also shows exactly what changed, and
`git checkout -- <file>` restores the last committed version.

You can delete this `_backup/` folder anytime (or add it to `.gitignore`).
