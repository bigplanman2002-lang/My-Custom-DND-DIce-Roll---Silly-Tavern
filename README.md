# Extension-Dice

D&D dice roller for SillyTavern with function tool support, advantage/disadvantage, and slash commands.

## How to install

Install via the built-in "Download Extensions and Assets" tool. Or use a direct link:

```txt
https://github.com/bigplanman2002-lang/My-Custom-DND-DIce-Roll---Silly-Tavern
```

## Features

- **Standard dice**: d4, d6, d8, d10, d12, d20, d100
- **Advantage/Disadvantage**: Roll 2d20, take highest or lowest
- **Modifiers**: Support for +/- modifiers (e.g. `1d20+5`)
- **Custom formulas**: Any valid dice notation (e.g. `4d6`, `3d8-2`)
- **Function tool**: Let the AI roll dice automatically during roleplay
- **Slash commands**: `/roll`, `/r`, `/dice` with mode and reason options

## How to use

### Via the function tool

Disabled by default. Go to extension settings → "D&D Dice" → enable "Enable function tool".

Requires a compatible Chat Completion backend. See [Function Calling](https://docs.sillytavern.app/for-contributors/function-calling/) for details.

The AI can roll dice automatically during roleplay. It supports:
- Standard rolls: "Roll a d20"
- Advantage/disadvantage: "Roll with advantage"
- Named rolls: "Roll a perception check"

### Via the wand menu

1. Open the wand menu.
2. Click "Roll Dice".
3. Select a die, a special roll (advantage/disadvantage), or custom formula.

### Via slash commands

Basic roll:
```txt
/roll 1d20
```

Roll with advantage:
```txt
/roll mode=advantage 1d20+5
```

Roll with disadvantage and a reason:
```txt
/roll mode=disadvantage reason="saving throw" 1d20
```

Quiet roll (no chat message, result passed to pipe):
```txt
/roll quiet=true 2d6 | /echo
```

### Settings

- **Enable function tool**: Allow AI to call the dice roller during chat
- **Show individual roll details**: Display each die result in the chat message
- **Default formula**: The dice formula used when none is specified (default: 1d20)

## License

This extension is licensed under the AGPL-3.0 license.
