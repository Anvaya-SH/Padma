# Keybindings Reference

Padma exposes named actions, such as `app.session.new`, that can be assigned keybindings. You can change default assignments or bind unassigned actions in Padma's [user configuration](configuration.md#agent-directory).

Run `/hotkeys` to see the active shortcuts for the main editor and application.

## Assign keybindings

Create `<agent-dir>/keybindings.json`. The agent directory defaults to `~/.padma/agent` and is described in [Agent directory](configuration.md#agent-directory).

Map each action identifier to one key or a list of keys:

```json
{
  "app.session.new": "ctrl+shift+n",
  "app.session.tree": ["ctrl+shift+t", "alt+shift+t"]
}
```

A configured value replaces the default for that action. Use an empty list to disable an action's keybindings:

```json
{
  "tui.altScreen.pageUp": []
}
```

After editing the file, run `/reload` to apply the changes to the active session.

## Key syntax

Write a key as `modifier+key`. Modifiers are `ctrl`, `shift`, `alt`, and `super`. You can combine modifiers. Valid keys are:

- **Letters:** `a-z`
- **Digits:** `0-9`
- **Special:** `escape`, `esc`, `enter`, `return`, `tab`, `space`, `backspace`, `delete`, `insert`, `clear`, `home`, `end`, `pageUp`, `pageDown`, `up`, `down`, `left`, `right`
- **Function:** `f1`-`f12`
- **Symbols:** `` ` ``, `-`, `=`, `[`, `]`, `\`, `;`, `'`, `,`, `.`, `/`, `!`, `@`, `#`, `$`, `%`, `^`, `&`, `*`, `(`, `)`, `_`, `+`, `|`, `~`, `{`, `}`, `:`, `<`, `>`, `?`

Examples: `ctrl+shift+x`, `alt+ctrl+x`, `ctrl+shift+alt+x`, `super+k`, `ctrl+super+k`, and `ctrl+1`.

`super` bindings require a terminal that reports the modifier separately, typically through the Kitty keyboard protocol. They may not work in terminals without that support.

## Actions

### Terminal UI

#### Cursor movement

| Keybinding id | Default | Description |
|---|---|---|
| `tui.editor.cursorUp` | `up` | Move cursor up, browsing older history at the top |
| `tui.editor.cursorDown` | `down` | Move cursor down, browsing newer history at the bottom |
| `tui.editor.historyPrevious` | None | Select the previous prompt history entry |
| `tui.editor.historyNext` | None | Select the next prompt history entry |
| `tui.editor.cursorLeft` | `left`, `ctrl+b` | Move cursor left |
| `tui.editor.cursorRight` | `right`, `ctrl+f` | Move cursor right |
| `tui.editor.cursorWordLeft` | `alt+left`, `ctrl+left`, `alt+b` | Move cursor word left |
| `tui.editor.cursorWordRight` | `alt+right`, `ctrl+right`, `alt+f` | Move cursor word right |
| `tui.editor.cursorLineStart` | `home`, `ctrl+home`, `ctrl+a` | Move to line start |
| `tui.editor.cursorLineEnd` | `end`, `ctrl+end`, `ctrl+e` | Move to line end |
| `tui.editor.jumpForward` | `ctrl+]` | Jump forward to character |
| `tui.editor.jumpBackward` | `ctrl+alt+]` | Jump backward to character |
| `tui.editor.pageUp` | `pageUp`, `ctrl+pageUp` | Scroll up by page |
| `tui.editor.pageDown` | `pageDown`, `ctrl+pageDown` | Scroll down by page |

The dedicated history actions browse prompt history regardless of cursor position and take precedence over application actions using the same key.

#### Text editing

| Keybinding id | Default | Description |
|---|---|---|
| `tui.editor.deleteCharBackward` | `backspace`, `shift+backspace`, `ctrl+h` | Delete character backward |
| `tui.editor.deleteCharForward` | `delete`, `shift+delete`, `ctrl+d` | Delete character forward |
| `tui.editor.deleteWordBackward` | `alt+backspace`, `ctrl+backspace`, `ctrl+shift+backspace`, `ctrl+w`, `ctrl+alt+h` | Delete word backward |
| `tui.editor.deleteWordForward` | `alt+delete`, `ctrl+delete`, `ctrl+shift+delete`, `alt+d` | Delete word forward |
| `tui.editor.killWholeLine` | None | Delete the current whole line |
| `tui.editor.deleteToLineStart` | `ctrl+u` | Delete to line start |
| `tui.editor.deleteToLineEnd` | `ctrl+k` | Delete to line end |
| `tui.editor.yank` | `ctrl+y` | Paste most recently deleted text |
| `tui.editor.yankPop` | `alt+y` | Cycle through deleted text after yank |
| `tui.editor.undo` | `ctrl+-` (`ctrl+z` on Windows; `alt+z` on WSL) | Undo last edit |

#### Input and selection

| Keybinding id | Default | Description |
|---|---|---|
| `tui.input.newLine` | `ctrl+j`, `shift+enter`, `alt+enter` | Insert new line (no `ctrl+m`: legacy terminals report it as Enter) |
| `tui.input.submit` | `enter` | Submit input |
| `tui.input.tab` | `tab` | Tab or autocomplete |
| `tui.input.copy` | `ctrl+c` | Copy selection |
| `tui.select.up` | `up`, `ctrl+p`, `ctrl+k` | Move selection up |
| `tui.select.down` | `down`, `ctrl+n`, `ctrl+j` | Move selection down |
| `tui.select.pageUp` | `pageUp`, `ctrl+b` | Page up in list |
| `tui.select.pageDown` | `pageDown`, `ctrl+f` | Page down in list |
| `tui.select.left` | `left`, `ctrl+h` | Move left / change tab |
| `tui.select.right` | `right`, `ctrl+l` | Move right / change tab |
| `tui.select.top` | `home` | First item |
| `tui.select.bottom` | `end` | Last item |
| `tui.select.confirm` | `enter` | Confirm selection |
| `tui.select.cancel` | `escape`, `ctrl+c` | Cancel selection |

#### Fullscreen

In fullscreen mode, these actions control the transcript and take precedence over editor actions using the same key.

| Keybinding id | Default | Description |
|---|---|---|
| `tui.altScreen.pageUp` | `pageUp`, `shift+space`, `ctrl+b` | Scroll the transcript up by one page |
| `tui.altScreen.pageDown` | `pageDown`, `space`, `ctrl+f` | Scroll the transcript down by one page |
| `tui.altScreen.halfPageUp` | `ctrl+u` | Scroll the transcript up by half a page |
| `tui.altScreen.halfPageDown` | `ctrl+d` | Scroll the transcript down by half a page |
| `tui.altScreen.lineUp` | `up`, `k` | Scroll the transcript up by one line |
| `tui.altScreen.lineDown` | `down`, `j` | Scroll the transcript down by one line |
| `tui.altScreen.close` | `q`, `ctrl+c` | Close pager overlay |
| `tui.altScreen.closeTranscript` | `ctrl+t` | Close detailed transcript view |
| `tui.altScreen.find` | `f3`, `/` | Start transcript find |
| `tui.altScreen.previousPrompt` | `ctrl+shift+up`, `ctrl+up` (`ctrl+up` only on Windows and WSL) | Jump to the previous marked message |
| `tui.altScreen.nextPrompt` | `ctrl+shift+down`, `ctrl+down` (`ctrl+down` only on Windows and WSL) | Jump to the next marked message |
| `tui.altScreen.search` | `ctrl+shift+f` (`ctrl+f` on Windows and WSL) | Search the rendered transcript |
| `tui.altScreen.searchNext` | `enter`, `ctrl+g` | Select the next search match while searching |
| `tui.altScreen.searchPrevious` | `shift+enter`, `ctrl+shift+g` | Select the previous search match while searching |
| `tui.altScreen.searchClose` | `escape` | Close transcript search |
| `tui.altScreen.top` | `home` | Scroll to the beginning of the transcript |
| `tui.altScreen.bottom` | `end` | Scroll to the transcript end and follow new output |

### Application

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.interrupt` | `escape` | Cancel / abort |
| `app.clear` | `ctrl+c` | Clear editor (first) / exit (second) |
| `app.exit` | `ctrl+d` | Exit (when editor empty) |
| `app.suspend` | `ctrl+z` (None on Windows) | Suspend to background |
| `app.editor.external` | `ctrl+g` | Open in external editor (`externalEditor`, `$VISUAL`, `$EDITOR`, Notepad on Windows, or `nano` elsewhere) |
| `app.clipboard.pasteImage` | `ctrl+v` (`alt+v` on Windows and WSL) | Paste files on macOS, images, or text from clipboard |

On native Windows, `app.suspend` has no default because Windows terminals do not support Unix job control. If you assign it manually, Padma shows a status message instead of suspending. WSL uses the normal `ctrl+z` and `fg` behavior.

### Sessions

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.session.new` | None | Start a new session (`/new`) |
| `app.session.tree` | None | Open session tree navigator (`/tree`) |
| `app.session.fork` | None | Fork current session (`/fork`) |
| `app.session.resume` | None | Open session resume picker (`/resume`) |
| `app.session.togglePath` | `ctrl+p` | Toggle path display |
| `app.session.toggleSort` | `ctrl+shift+s` | Toggle sort mode |
| `app.session.toggleNamedFilter` | `ctrl+n` | Toggle named-only filter |
| `app.session.rename` | `ctrl+shift+r` | Rename session |
| `app.session.delete` | `ctrl+d` | Delete session |
| `app.session.deleteNoninvasive` | `ctrl+backspace` | Delete session when query is empty |

### Models and Thinking

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.model.select` | `ctrl+shift+l` | Open model selector |
| `app.model.cycleForward` | `ctrl+p` | Cycle to next model |
| `app.model.cycleBackward` | `shift+ctrl+p` (`alt+p` on Windows and WSL) | Cycle to previous model |
| `app.models.save` | `ctrl+shift+s` | Save the selected default model or scoped model configuration to settings |
| `app.thinking.cycle` | `shift+tab` | Cycle thinking level |
| `app.thinking.save` | `ctrl+shift+s` | Save current thinking level to settings |
| `app.thinking.toggle` | `ctrl+shift+t` | Collapse or expand thinking blocks |

### Display and Message Queue

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.tools.expand` | `alt+o` | Collapse or expand tool output |
| `app.message.copy` | `ctrl+o` | Copy the selected message in `/tree`; in fullscreen mode, copy the active selection when `fullscreenCopyOnSelect` is `false`; otherwise copy the last assistant message. On OAuth sign-in screens, copy the sign-in URL |
| `app.message.followUp` | `alt+enter` (`ctrl+q` on Windows and WSL) | Queue follow-up message |
| `app.message.dequeue` | `alt+q` | Restore queued messages to editor |

### Tree Navigation

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.tree.foldOrUp` | `ctrl+left`, `alt+left` | Fold current branch segment, or jump to the previous segment start |
| `app.tree.unfoldOrDown` | `ctrl+right`, `alt+right` | Unfold current branch segment, or jump to the next segment start or branch end |
| `app.tree.editLabel` | `shift+l` | Edit the label on the selected tree node |
| `app.tree.toggleLabelTimestamp` | `shift+t` | Toggle label timestamps in the tree |
| `app.tree.filter.default` | `ctrl+d` | Set tree filter to default view |
| `app.tree.filter.noTools` | `ctrl+alt+t` | Toggle tree filter that hides tool results |
| `app.tree.filter.userOnly` | `ctrl+u` | Toggle tree filter that shows only user messages |
| `app.tree.filter.labeledOnly` | `ctrl+alt+l` | Toggle tree filter that shows only labeled entries |
| `app.tree.filter.all` | `ctrl+a` | Toggle tree filter that shows all entries |
| `app.tree.filter.cycleForward` | `ctrl+alt+o` | Cycle tree filter forward |
| `app.tree.filter.cycleBackward` | `shift+ctrl+o` | Cycle tree filter backward |

### Scoped Models Selector

Used inside the scoped models selector (opened via `/scoped-models`).

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.models.enableAll` | `ctrl+a` | Enable all models (or all matching the current search) |
| `app.models.clearAll` | `ctrl+shift+x` | Clear all models (or all matching the current search) |
| `app.models.toggleProvider` | `ctrl+p` | Toggle all models for the current provider |
| `app.models.reorderUp` | `alt+up` | Move the selected model up in the cycle order |
| `app.models.reorderDown` | `alt+shift+down` | Move the selected model down in the cycle order |

### Global (Codex parity)

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.global.openAgents` | None | Open agent-session overview |
| `app.global.openTranscript` | `ctrl+t` | Open detailed transcript |
| `app.global.findTranscript` | `f3` | Find in transcript |
| `app.global.focusActivity` | `f4` | Focus transcript activity groups |
| `app.global.openWarnings` | `f2` | Open warnings view |
| `app.global.copy` | `ctrl+o` | Copy last agent response |
| `app.global.clearTerminal` | `ctrl+l` | Clear terminal UI |
| `app.global.toggleVimMode` | None | Toggle Vim composer mode |
| `app.global.toggleFastMode` | None | Toggle Fast mode |
| `app.global.toggleRawOutput` | `alt+r` | Toggle raw output mode |
| `app.global.toggleSideConversation` | `ctrl+/`, `ctrl+7` | Switch side conversation |

### Chat effort, questions, voice (Codex parity)

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.chat.decreaseEffort` | `alt+,`, `shift+down` | Decrease reasoning effort |
| `app.chat.increaseEffort` | `alt+.`, `shift+up` | Increase reasoning effort |
| `app.chat.prevPermission` | None | Previous permission mode |
| `app.chat.nextPermission` | None | Next permission mode |
| `app.chat.editQueued` | `shift+left`, `alt+up` | Forward through questions / edit queued |
| `app.chat.promptStackBack` | `shift+right`, `alt+down` | Back toward composer |
| `app.chat.skipQuestion` | `ctrl+]` | Skip focused question |
| `app.chat.toggleVoice` | `f8` | Start/stop voice conversation |
| `app.chat.toggleVoiceMute` | `ctrl+x` | Mute/unmute microphone |

### Composer (Codex parity)

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.composer.queue` | `tab` | Queue draft while working |
| `app.composer.toggleShortcuts` | `?` | Toggle shortcut help (empty composer) |
| `app.composer.historyPrev` | `ctrl+r` | History search previous |
| `app.composer.historyNext` | `ctrl+s` | History search next |

### Agents overview (Codex parity)

Keys apply when the agents overview is focused. Typing in its search field takes precedence over single-letter actions.

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.agents.resume` | `o` | Open resume picker |
| `app.agents.search` | `f` | Search tasks |
| `app.agents.newTask` | `n` | New session |
| `app.agents.newWorktree` | `w` | New worktree session |
| `app.agents.rename` | `r` | Rename task |
| `app.agents.stop` | `x` | Stop task |
| `app.agents.archive` | `a` | Archive task |
| `app.agents.delete` | `backspace` | Delete task |
| `app.agents.hide` | `h` | Hide task |
| `app.agents.toggleGrouping` | `g` | Cycle grouping |

### Approvals (Codex parity)

Shortcuts are usable only when the corresponding approval option exists.

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.approval.openFullscreen` | `ctrl+a`, `ctrl+shift+a` | Approval fullscreen details |
| `app.approval.openThread` | `o` | Open source thread |
| `app.approval.approve` | `y` | Approve primary option |
| `app.approval.approveForSession` | `a` | Approve for session |
| `app.approval.approveForPrefix` | `p` | Approve prefix |
| `app.approval.deny` | `d` | Deny |
| `app.approval.decline` | `escape`, `n` | Decline with guidance |
| `app.approval.cancel` | `c` | Cancel elicitation |

### Vim modes (Codex parity, registry only)

Vim composer mode handlers are not yet wired; these ids make Codex Vim defaults configurable. `g` stands in for the `g g` chord until chord support lands.

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `tui.vim.normal.enterInsert` | `i`, `insert` | Insert at cursor |
| `tui.vim.normal.appendAfterCursor` | `a` | Insert after cursor |
| `tui.vim.normal.appendLineEnd` | `shift+a` | Insert at end of line |
| `tui.vim.normal.insertLineStart` | `shift+i` | Insert at first nonblank |
| `tui.vim.normal.openLineBelow` | `o` | New line below |
| `tui.vim.normal.openLineAbove` | `shift+o` | New line above |
| `tui.vim.normal.enterReplaceMode` | `shift+r` | Replace mode |
| `tui.vim.normal.moveLeft` | `h`, `left` | Left |
| `tui.vim.normal.moveRight` | `l`, `right` | Right |
| `tui.vim.normal.moveUp` | `k`, `up` | Up |
| `tui.vim.normal.moveDown` | `j`, `down` | Down |
| `tui.vim.normal.moveWordForward` | `w` | Next word start |
| `tui.vim.normal.moveWordBackward` | `b` | Previous word start |
| `tui.vim.normal.moveWordEnd` | `e` | Word end |
| `tui.vim.normal.moveLineStart` | `0` | Line start |
| `tui.vim.normal.moveLineEnd` | `$` | Line end |
| `tui.vim.normal.findForward` | `f` | Find forward |
| `tui.vim.normal.findBackward` | `shift+f` | Find backward |
| `tui.vim.normal.tillForward` | `t` | Till forward |
| `tui.vim.normal.tillBackward` | `shift+t` | Till backward |
| `tui.vim.normal.jumpTop` | `g` | First line (`g g` chord) |
| `tui.vim.normal.jumpBottom` | `shift+g` | Last line |
| `tui.vim.normal.deleteChar` | `x` | Delete char |
| `tui.vim.normal.replaceChar` | `r` | Replace char |
| `tui.vim.normal.repeatLastChange` | `.` | Repeat edit |
| `tui.vim.normal.substituteChar` | `s` | Substitute char |
| `tui.vim.normal.deleteToLineEnd` | `shift+d` | Delete to line end |
| `tui.vim.normal.changeToLineEnd` | `shift+c` | Change to line end |
| `tui.vim.normal.yankLine` | `shift+y` | Yank line |
| `tui.vim.normal.pasteAfter` | `p` | Paste after |
| `tui.vim.normal.startDeleteOperator` | `d` | Delete operator |
| `tui.vim.normal.startYankOperator` | `y` | Yank operator |
| `tui.vim.normal.startChangeOperator` | `c` | Change operator |
| `tui.vim.normal.undo` | `u` | Undo |
| `tui.vim.normal.redo` | `ctrl+r` | Redo |
| `tui.vim.normal.cancelOperator` | `escape` | Cancel operator |
| `tui.vim.search.forward` | `/` | Search forward |
| `tui.vim.search.backward` | `?` | Search backward |
| `tui.vim.search.next` | `n` | Next match |
| `tui.vim.search.previous` | `shift+n` | Previous match |
| `tui.vim.operator.deleteLine` | `d` | `dd` delete line |
| `tui.vim.operator.yankLine` | `y` | `yy` yank line |
| `tui.vim.operator.motionLeft` | `h` | Operator left |
| `tui.vim.operator.motionRight` | `l` | Operator right |
| `tui.vim.operator.motionUp` | `k` | Operator up |
| `tui.vim.operator.motionDown` | `j` | Operator down |
| `tui.vim.operator.motionWordForward` | `w` | Operator word forward |
| `tui.vim.operator.motionWordBackward` | `b` | Operator word backward |
| `tui.vim.operator.motionWordEnd` | `e` | Operator word end |
| `tui.vim.operator.motionLineStart` | `0` | Operator line start |
| `tui.vim.operator.motionLineEnd` | `$` | Operator line end |
| `tui.vim.operator.motionFindForward` | `f` | Operator find forward |
| `tui.vim.operator.motionFindBackward` | `shift+f` | Operator find backward |
| `tui.vim.operator.motionTillForward` | `t` | Operator till forward |
| `tui.vim.operator.motionTillBackward` | `shift+t` | Operator till backward |
| `tui.vim.operator.motionJumpTop` | `g` | Operator first line |
| `tui.vim.operator.motionJumpBottom` | `shift+g` | Operator last line |
| `tui.vim.operator.selectInner` | `i` | Inner text object |
| `tui.vim.operator.selectAround` | `a` | Around text object |
| `tui.vim.operator.cancel` | `escape` | Cancel operator |
| `tui.vim.textObject.word` | `w` | Word object |
| `tui.vim.textObject.bigWord` | `shift+w` | WORD object |
| `tui.vim.textObject.parentheses` | `(`, `)`, `b` | Parentheses object |
| `tui.vim.textObject.brackets` | `[`, `]` | Brackets object |
| `tui.vim.textObject.braces` | `{`, `}`, `shift+b` | Braces object |
| `tui.vim.textObject.doubleQuote` | None | Double-quote object (unbound: no double-quote KeyId) |
| `tui.vim.textObject.singleQuote` | `'` | Single-quote object |
| `tui.vim.textObject.backtick` | `` ` `` | Backtick object |
| `tui.vim.textObject.cancel` | `escape` | Cancel text object |
