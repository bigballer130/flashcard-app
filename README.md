# Flashcards

A flashcard app that runs entirely in the browser: make sets of terms and definitions, group them
in folders, and study them with Flashcards, Learn, Test, Match and Blast.

Online: https://bigballer130.github.io/flashcard-app/ (also works opened straight from disk: `index.html`).

## Sync between devices

Press the **cloud button** at the top right.

1. Follow the link to create a GitHub key (a "personal access token") with only the **gist**
   permission, and pick a long expiration.
2. Paste it and press **Connect** on the first device.
3. On every other device or browser, open the app, press the cloud button and paste the same key.

Cards already on a device are combined with the synced ones when it connects, so nothing is lost.
After that, changes sync about two seconds after you make them, whenever you come back to the app,
and every 30 seconds while it is open. If the same set is changed on two devices before they sync,
the newer change wins; a deletion wins over older edits.

The dot on the cloud button shows the state: green = synced, blue = syncing, grey = offline,
red = a problem (press the button to see it).

The data lives in a *secret* gist in your GitHub account: it isn't listed or searchable, but anyone
with its exact URL could open it, so don't share it. The key is stored only in your browser.

## Files

- `index.html`, `styles.css`, `css/`: the page and its styles.
- `js/core.js`: storage (localStorage), change tracking for sync, shared helpers.
- `js/app.js`: router, library, folders, set page and editor.
- `js/flashcards.js`, `learn.js`, `test.js`, `match.js`, `blast.js`: the study modes.
- `js/sync.js`: sync through a GitHub gist.
