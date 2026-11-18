# Tapeout

Hardware interview prep for new grads: curated, auto-graded problem lists for
design verification (DV 75), RTL design (RTL 75) and computer architecture (Arch 75).

Live site: https://siyabajaj330-boop.github.io/tapeout/

## How it works

- Static single-page app, built with esbuild into `docs/` and served by GitHub Pages.
- Fonts and code are self-hosted; a strict Content Security Policy limits scripts to this
  origin plus Google's sign-in helper.
- Optional accounts: Google sign-in through Firebase Authentication, progress and notes in
  Cloud Firestore (Lite SDK). Signed-out progress stays in the browser.
- `firestore.rules` restricts every user to their own documents, validates document shape
  and size, throttles writes, and denies everything else.

## Develop

```sh
npm install
npm run build        # writes docs/
python3 -m http.server -d docs 8080
```

Problem content lives in `src/content.json`.

## Report a problem

Found a wrong answer or a typo? [Open an issue](https://github.com/siyabajaj330-boop/tapeout/issues).

© 2026 Siya Bajaj. All rights reserved.
