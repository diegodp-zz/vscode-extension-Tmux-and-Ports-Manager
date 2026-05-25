# Tmux and Ports Manager

`Tmux and Ports Manager` is a VS Code extension scaffold for browsing and managing local `tmux` sessions from the activity bar.

## Features

- Browse `tmux` sessions, windows, and panes in a tree view
- Refresh the tree from the view title
- Create new sessions
- Create new windows/tasks inside a session
- Open a session in the integrated terminal
- Preview pane output in a read-only editor
- Kill sessions, windows, or panes from the context menu

## Development

```bash
npm install
npm run build
```

Then press `F5` in VS Code to launch the extension host.

## Notes

- This extension shells out to the local `tmux` binary, so `tmux` must be installed and available on `PATH`.
- Pane previews use `tmux capture-pane`, controlled by `tmuxManager.captureHistoryLines`.
